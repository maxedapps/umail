import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const LOCK_TIMEOUT = Duration.seconds(8);
const LOCK_RETRY = Duration.millis(25);
const LOCK_STALE = Duration.seconds(30);

// The CLI's OAuth tokens for one AgentMail origin. Files written by older versions carry extra
// fields, which decoding ignores.
export const OAuthCredentials = Schema.Struct({
  origin: Schema.String,
  scope: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
});
export type OAuthCredentials = typeof OAuthCredentials.Type;

const CredentialsJson = Schema.fromJsonString(OAuthCredentials);

export class OAuthCredentialStoreError extends Data.TaggedError("OAuthCredentialStoreError") {
  override readonly message = "The OAuth credential file is missing or insecure.";
}
export class OAuthCredentialLockError extends Data.TaggedError("OAuthCredentialLockError") {
  override readonly message = "Could not acquire the OAuth credential lock.";
}

export interface OAuthCredentialStoreService {
  readonly read: Effect.Effect<OAuthCredentials | null, OAuthCredentialStoreError>;
  readonly write: (credentials: OAuthCredentials) => Effect.Effect<void, OAuthCredentialStoreError>;
  readonly remove: Effect.Effect<void, OAuthCredentialStoreError>;
  // Serialises login, refresh and logout across CLI processes, so none acts on tokens another
  // process is replacing.
  readonly withLock: <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OAuthCredentialStoreError | OAuthCredentialLockError, R>;
}

// `$XDG_STATE_HOME/umail/oauth.json`, else `~/.local/state/umail/oauth.json`.
export const credentialFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* Config.string("XDG_STATE_HOME").pipe(
    Config.orElse(() =>
      Config.string("HOME").pipe(Config.map((home) => path.join(home, ".local", "state"))),
    ),
  );
  return path.join(root, "umail", "oauth.json");
});

export const makeCredentialStore = Effect.fn("makeCredentialStore")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const directory = path.dirname(file);
  const root = path.dirname(directory);
  const lock = `${file}.lock`;
  const uid = process.getuid?.();

  // readLink succeeds only for a symlink, and fails with NotFound when nothing is there.
  const entryAt = (target: string) =>
    fs.readLink(target).pipe(
      Effect.as("symlink" as const),
      Effect.catch((error: PlatformError.PlatformError) =>
        Effect.succeed(
          error.reason._tag === "NotFound" ? ("missing" as const) : ("entry" as const),
        ),
      ),
    );

  // Not a symlink, owned by this user and, when private, closed to everyone else.
  const assertSafe = Effect.fn("assertSafe")(function* (
    target: string,
    type: "Directory" | "File",
    isPrivate: boolean,
  ) {
    if ((yield* entryAt(target)) === "symlink") return yield* new OAuthCredentialStoreError();
    const info = yield* fs.stat(target);
    if (
      info.type !== type ||
      Option.getOrUndefined(info.uid) !== uid ||
      (isPrivate && (info.mode & 0o077) !== 0)
    ) {
      return yield* new OAuthCredentialStoreError();
    }
  });

  const ensureDirectory = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* assertSafe(root, "Directory", false);
    yield* assertSafe(directory, "Directory", true);
  });

  const read = Effect.gen(function* () {
    const entry = yield* entryAt(file);
    if (entry === "missing") return null;
    if (entry === "symlink") return yield* new OAuthCredentialStoreError();
    yield* assertSafe(root, "Directory", false);
    yield* assertSafe(directory, "Directory", true);
    yield* assertSafe(file, "File", true);
    return yield* Schema.decodeEffect(CredentialsJson)(yield* fs.readFileString(file));
  }).pipe(Effect.mapError(() => new OAuthCredentialStoreError()));

  // Written to a private temporary file, then renamed over the old one, so readers never see a
  // partial file.
  const write = Effect.fn("OAuthCredentialStore.write")(
    function* (credentials: OAuthCredentials) {
      yield* ensureDirectory;
      if ((yield* entryAt(file)) === "entry") yield* assertSafe(file, "File", true);
      const temporary = path.join(directory, `.oauth-${yield* crypto.randomUUIDv4}.tmp`);
      yield* fs
        .writeFileString(
          temporary,
          `${yield* Schema.encodeEffect(CredentialsJson)(credentials)}\n`,
          {
            flag: "wx",
            mode: 0o600,
          },
        )
        .pipe(
          Effect.andThen(fs.rename(temporary, file)),
          Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        );
    },
    Effect.uninterruptible,
    Effect.mapError(() => new OAuthCredentialStoreError()),
  );

  const remove = fs
    .remove(file, { force: true })
    .pipe(Effect.mapError(() => new OAuthCredentialStoreError()));

  // The lock is a directory: creating it is atomic. One left behind by a killed process is removed
  // once it is older than LOCK_STALE.
  const acquireLock = Effect.gen(function* () {
    yield* ensureDirectory.pipe(Effect.mapError(() => new OAuthCredentialStoreError()));
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(LOCK_TIMEOUT);
    while (true) {
      const created = yield* fs.makeDirectory(lock, { mode: 0o700 }).pipe(
        Effect.as(true),
        Effect.catch((error: PlatformError.PlatformError) =>
          error.reason._tag === "AlreadyExists"
            ? Effect.succeed(false)
            : Effect.fail(new OAuthCredentialStoreError()),
        ),
      );
      if (created) return;
      const now = yield* Clock.currentTimeMillis;
      const modified = yield* fs.stat(lock).pipe(
        Effect.map((info) => Option.map(info.mtime, (mtime) => mtime.getTime())),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      if (Option.isSome(modified) && now - modified.value > Duration.toMillis(LOCK_STALE)) {
        yield* fs.remove(lock, { recursive: true, force: true }).pipe(Effect.ignore);
        continue;
      }
      if (now >= deadline) return yield* new OAuthCredentialLockError();
      yield* Effect.sleep(LOCK_RETRY);
    }
  });

  return {
    read,
    write,
    remove,
    withLock: (body) =>
      Effect.acquireUseRelease(
        acquireLock,
        () => body,
        () => fs.remove(lock, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
  } satisfies OAuthCredentialStoreService;
});

export class OAuthCredentialStore extends Context.Service<
  OAuthCredentialStore,
  OAuthCredentialStoreService
>()("umail/OAuthCredentialStore") {
  static readonly layer = Layer.effect(
    OAuthCredentialStore,
    Effect.flatMap(credentialFile, makeCredentialStore),
  );
}
