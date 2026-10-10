// Alchemy PR #1923, patched in until Alchemy ships it (ADR 0008): a silent OAuth refresh starts
// from the profile as stored under its credentials lock, so concurrent refreshes spend a
// single-use refresh token once. Delete this file with the patch.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthError,
  AuthProviderLayer,
  AuthProviders,
  NeedsReauth,
} from "alchemy/Auth/AuthProvider";
import { inspectProvider } from "alchemy/Auth/Inspect";
import { ProfileStore, ProfileStoreLive, type ProviderConfig } from "alchemy/Auth/Profile";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import * as Interaction from "alchemy/Interaction";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

const PROVIDER = "FakeRotatingAuthProvider";

type RotatingConfig = { method: "oauth"; refresh: string; expires: number };

// The fake token endpoint: like Cloudflare's, each refresh token works once, and spending one
// again revokes the grant.
const endpoint = { refreshes: 0, spent: new Set<string>() };

const rotate = (
  profileName: string,
  config: RotatingConfig,
  updateConfig?: (config: RotatingConfig) => Effect.Effect<void, AuthError>,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (config.expires > now) return config.refresh;
    if (endpoint.spent.has(config.refresh)) {
      return yield* new NeedsReauth({
        provider: PROVIDER,
        profile: profileName,
        message: `refresh token ${config.refresh} was already spent`,
      });
    }
    endpoint.spent.add(config.refresh);
    endpoint.refreshes += 1;
    // Yield, as a real token request does, so a concurrent refresh can interleave.
    yield* Effect.sleep("20 millis");
    const refreshed: RotatingConfig = {
      method: "oauth",
      refresh: `r${endpoint.refreshes}`,
      expires: now + 3_600_000,
    };
    yield* updateConfig?.(refreshed) ?? Effect.void;
    return refreshed.refresh;
  });

const FakeRotatingAuth = AuthProviderLayer<RotatingConfig, string>()(PROVIDER, {
  configSchema: Schema.Struct({
    method: Schema.Literal("oauth"),
    refresh: Schema.String,
    expires: Schema.Finite,
  }),
  configure: () => Effect.succeed({ method: "oauth", refresh: "r0", expires: 0 }),
  login: () => Effect.void,
  logout: () => Effect.void,
  details: (profileName, config, updateConfig) =>
    Effect.map(rotate(profileName, config, updateConfig), (token) => ({
      lines: [{ key: "token", value: token }],
    })),
  read: rotate,
});

const expired: RotatingConfig = { method: "oauth", refresh: "r0", expires: 0 };

// Alchemy's profiles and locks in a scratch ALCHEMY_HOME, with an expired login stored. The
// profile store is built only after ALCHEMY_HOME points there, since building it creates the
// home's directories.
const withExpiredProfile = <A, E>(effect: Effect.Effect<A, E, ProfileStore | AuthProviders>) =>
  Effect.gen(function* () {
    endpoint.refreshes = 0;
    endpoint.spent.clear();
    const home = yield* FileSystem.FileSystem.use((fs) =>
      fs.makeTempDirectoryScoped({ prefix: "alchemy-home-" }),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.stubEnv("ALCHEMY_HOME", home)),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    return yield* Effect.gen(function* () {
      yield* ProfileStore.use((profiles) =>
        profiles.setProviderConfig("default", PROVIDER, expired),
      );
      return yield* effect;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ProfileStoreLive, FakeRotatingAuth).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(AuthProviders, {}),
              ConfigProvider.layer(ConfigProvider.fromUnknown({})),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("concurrent resolves of an expired login refresh it once", () =>
  withExpiredProfile(
    Effect.gen(function* () {
      // Both resolutions load the profile first, as two deploys starting together do.
      const first = yield* resolveProviderConfig<RotatingConfig, string>(PROVIDER);
      const second = yield* resolveProviderConfig<RotatingConfig, string>(PROVIDER);
      const tokens = yield* Effect.all([first.resolve, second.resolve], {
        concurrency: "unbounded",
      });
      expect(tokens).toEqual(["r1", "r1"]);
      expect(endpoint.refreshes).toBe(1);
      // A later resolve in the same long-lived process reads the rotated token too.
      expect(yield* first.resolve).toBe("r1");
      expect(endpoint.refreshes).toBe(1);
    }),
  ),
);

it.live("concurrent inspections of an expired login refresh it once", () =>
  withExpiredProfile(
    Effect.gen(function* () {
      const registered = yield* AuthProviders;
      const profiles = yield* ProfileStore;
      const persist = (updated: ProviderConfig) =>
        profiles
          .setProviderConfig("default", PROVIDER, updated)
          .pipe(Effect.mapError((cause) => new AuthError({ message: cause.message, cause })));
      // Both start from the config read before either refresh, as two `alchemy profile show` do.
      const inspect = inspectProvider("default", PROVIDER, expired, registered, persist);
      const connections = yield* Effect.all([inspect, inspect], { concurrency: "unbounded" }).pipe(
        Effect.provide(Interaction.layerNonInteractive()),
      );
      expect(connections.map((connection) => connection.status)).toEqual([
        "connected",
        "connected",
      ]);
      expect(endpoint.refreshes).toBe(1);
    }),
  ),
);
