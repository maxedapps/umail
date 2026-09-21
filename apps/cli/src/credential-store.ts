import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const FILE_LOCK_TIMEOUT = Duration.seconds(5);
const REFRESH_LOCK_TIMEOUT = Duration.seconds(8);
const LOCK_RETRY = Duration.millis(25);
const LOCK_STALE_TIMEOUT = Duration.seconds(30);

const RegistrationFields = {
  version: Schema.Literal(2),
  origin: Schema.String,
  issuer: Schema.String,
  resource: Schema.String,
  scope: Schema.String,
  clientId: Schema.String,
  generation: Schema.Natural.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
} as const;

export const OAuthRegisteredState = Schema.Struct({
  ...RegistrationFields,
  kind: Schema.Literal("registered"),
});
export type OAuthRegisteredState = typeof OAuthRegisteredState.Type;

export const OAuthAuthorizedState = Schema.Struct({
  ...RegistrationFields,
  kind: Schema.Literal("authorized"),
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
});
export type OAuthAuthorizedState = typeof OAuthAuthorizedState.Type;

export const OAuthCredentialState = Schema.Union([OAuthRegisteredState, OAuthAuthorizedState]);
export type OAuthCredentialState = typeof OAuthCredentialState.Type;

export class OAuthCredentialStoreError extends Data.TaggedError("OAuthCredentialStoreError") {
  override readonly message = "The OAuth credential file is missing or insecure.";
}
export class OAuthCredentialLockError extends Data.TaggedError("OAuthCredentialLockError") {
  override readonly message = "Could not acquire the OAuth credential lock.";
}
export class OAuthCredentialSupersededError extends Data.TaggedError(
  "OAuthCredentialSupersededError",
) {
  override readonly message = "OAuth credentials were replaced by another process.";
}

export type CredentialCommitResult = "committed" | "superseded";

export interface OAuthLogoutRevocation {
  readonly clientId: string;
  readonly refreshToken: string;
}

export interface OAuthCredentialStoreService {
  readonly read: Effect.Effect<OAuthCredentialState | null, OAuthCredentialStoreError>;
  readonly write: (
    state: OAuthCredentialState,
  ) => Effect.Effect<void, OAuthCredentialStoreError | OAuthCredentialLockError>;
  readonly commit: (
    expectedGeneration: number,
    state: OAuthCredentialState,
  ) => Effect.Effect<CredentialCommitResult, OAuthCredentialStoreError | OAuthCredentialLockError>;
  readonly takeLogoutSnapshot: (
    origin: string,
  ) => Effect.Effect<
    OAuthLogoutRevocation | null,
    OAuthCredentialStoreError | OAuthCredentialLockError
  >;
  readonly withRefreshLock: <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OAuthCredentialStoreError | OAuthCredentialLockError, R>;
}

export class OAuthCredentialStore extends Context.Service<
  OAuthCredentialStore,
  OAuthCredentialStoreService
>()("umail/OAuthCredentialStore") {
  static readonly layer = Layer.succeed(OAuthCredentialStore, makeCredentialStore(process.env));
}

interface HeldLock {
  readonly path: string;
}

export function credentialPath(env: NodeJS.ProcessEnv): string {
  const root = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(root, "umail", "oauth.json");
}

export function credentialLockPath(credentialFile: string): string {
  return `${credentialFile}.lock`;
}

export function credentialRefreshLockPath(credentialFile: string): string {
  return `${credentialFile}.refresh.lock`;
}

export function registeredCredentialState(state: OAuthCredentialState): OAuthRegisteredState {
  return {
    version: state.version,
    kind: "registered",
    origin: state.origin,
    issuer: state.issuer,
    resource: state.resource,
    scope: state.scope,
    clientId: state.clientId,
    generation: state.generation,
  };
}

export function makeCredentialStore(env: NodeJS.ProcessEnv): OAuthCredentialStoreService {
  const path = credentialPath(env);
  return {
    read: Effect.tryPromise({
      try: () => readCredentialState(path),
      catch: () => new OAuthCredentialStoreError(),
    }),
    write: (state) =>
      withExclusiveLock(
        credentialLockPath(path),
        FILE_LOCK_TIMEOUT,
        Effect.tryPromise({
          try: () => writeCredentialState(path, state),
          catch: () => new OAuthCredentialStoreError(),
        }).pipe(Effect.uninterruptible),
      ),
    commit: (expectedGeneration, state) =>
      withExclusiveLock(
        credentialLockPath(path),
        FILE_LOCK_TIMEOUT,
        Effect.tryPromise({
          try: () => commitCredentialState(path, expectedGeneration, state),
          catch: () => new OAuthCredentialStoreError(),
        }).pipe(Effect.uninterruptible),
      ),
    takeLogoutSnapshot: (origin) =>
      Effect.gen(function* () {
        const current = yield* Effect.tryPromise({
          try: () => readCredentialState(path),
          catch: () => new OAuthCredentialStoreError(),
        });
        if (current === null || current.origin !== origin) return null;
        return yield* withExclusiveLock(
          credentialLockPath(path),
          FILE_LOCK_TIMEOUT,
          Effect.tryPromise({
            try: () => takeLogoutSnapshot(path, origin),
            catch: () => new OAuthCredentialStoreError(),
          }).pipe(Effect.uninterruptible),
        );
      }),
    withRefreshLock: (body) =>
      withExclusiveLock(credentialRefreshLockPath(path), REFRESH_LOCK_TIMEOUT, body),
  };
}

function withExclusiveLock<A, E, R>(
  lockPath: string,
  timeout: Duration.Input,
  body: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    acquireExclusiveLock(lockPath, timeout),
    () => body,
    (lock) => releaseLockEffect(lock),
  );
}

function acquireExclusiveLock(lockPath: string, timeout: Duration.Input) {
  return Effect.gen(function* () {
    const timeoutMs = Duration.toMillis(timeout);
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const acquired = yield* Effect.tryPromise({
        try: () => tryCreateLock(lockPath, now),
        catch: () => new OAuthCredentialStoreError(),
      });
      if (acquired !== null) return acquired;
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* new OAuthCredentialLockError();
      yield* Effect.sleep(LOCK_RETRY);
    }
  });
}

function releaseLockEffect(lock: HeldLock) {
  return Effect.promise(() => releaseExclusiveLock(lock).catch(() => undefined)).pipe(
    Effect.asVoid,
  );
}

async function commitCredentialState(
  path: string,
  expectedGeneration: number,
  state: OAuthCredentialState,
): Promise<CredentialCommitResult> {
  const current = await readCredentialState(path);
  const currentGeneration = current?.generation ?? 0;
  if (currentGeneration !== expectedGeneration) return "superseded";
  await writeCredentialState(path, { ...state, generation: expectedGeneration });
  return "committed";
}

async function takeLogoutSnapshot(
  path: string,
  origin: string,
): Promise<OAuthLogoutRevocation | null> {
  const current = await readCredentialState(path);
  if (current === null || current.origin !== origin) return null;
  const revocation =
    current.kind === "authorized"
      ? { clientId: current.clientId, refreshToken: current.refreshToken }
      : null;
  await writeCredentialState(path, {
    ...registeredCredentialState(current),
    generation: current.generation + 1,
  });
  return revocation;
}

async function ensureDirectory(path: string, privateDirectory: boolean): Promise<void> {
  await mkdir(path, { recursive: true, mode: privateDirectory ? 0o700 : 0o755 });
  await validateDirectory(path, privateDirectory);
}
async function validateDirectory(path: string, privateDirectory: boolean): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error("insecure credential directory");
  if (privateDirectory && (info.mode & 0o077) !== 0)
    throw new Error("insecure credential directory mode");
}
async function validateCredentialParents(path: string): Promise<boolean> {
  const privateDirectory = dirname(path);
  try {
    await validateDirectory(dirname(privateDirectory), false);
    await validateDirectory(privateDirectory, true);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}
async function validateCredentialFile(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("insecure credential file");
  return true;
}
async function readCredentialState(path: string): Promise<OAuthCredentialState | null> {
  if (!(await validateCredentialParents(path)) || !(await validateCredentialFile(path)))
    return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("insecure credential file");
    return Schema.decodeSync(Schema.fromJsonString(OAuthCredentialState))(
      await handle.readFile({ encoding: "utf8" }),
    );
  } finally {
    await handle.close();
  }
}
async function writeCredentialState(path: string, state: OAuthCredentialState): Promise<void> {
  const directory = dirname(path);
  await ensureDirectory(dirname(directory), false);
  await ensureDirectory(directory, true);
  await validateCredentialFile(path);
  const temporary = join(directory, `.oauth-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(state)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function tryCreateLock(lockPath: string, now: number): Promise<HeldLock | null> {
  const directory = dirname(lockPath);
  await ensureDirectory(dirname(directory), false);
  await ensureDirectory(directory, true);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (!isExistError(error)) throw error;
    await maybeRemoveStaleLock(lockPath, now);
    return null;
  }
  try {
    const info = await lstat(lockPath);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("insecure credential lock");
    return { path: lockPath };
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function maybeRemoveStaleLock(lockPath: string, now: number): Promise<void> {
  let info;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("insecure credential lock");
  if (now - info.mtimeMs < Duration.toMillis(LOCK_STALE_TIMEOUT)) return;
  await rm(lockPath, { recursive: true, force: true });
}

async function releaseExclusiveLock(lock: HeldLock): Promise<void> {
  await rm(lock.path, { recursive: true, force: true }).catch(() => undefined);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isExistError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
