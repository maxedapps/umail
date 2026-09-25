import { ExternalMailAddress } from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { mcpResourceUrl, restResourceUrl } from "../../src/auth/options.ts";
import { provisionAuth } from "../../src/auth/provisioning.ts";
import { memoryQueryDatabase } from "./memory-d1.ts";
import {
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  TEST_SITE,
  WorkerServices,
  createWorld,
  readJson,
} from "./world.ts";

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const SessionBody = Schema.Struct({
  user: Schema.Struct({
    email: Schema.String,
  }),
});

describe("provisioned operator authority", () => {
  it.effect("grants operator authority only to the configured credentials", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const session = yield* world.request("http://umail.test/api/auth/get-session", {
        headers: { cookie: world.sessionCookie },
      });
      expect(session.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(SessionBody)(yield* readJson(session));
      expect(body.user.email).toBe(OPERATOR_EMAIL);
      expect(world.operatorAccessToken.length).toBeGreaterThan(0);
    }),
  );

  it.effect("never creates authority from an unknown email or public signup", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const usersBefore = yield* Effect.promise(() => world.db.all("SELECT email FROM user"));
      const signUp = yield* world.request("http://umail.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: yield* jsonText({
          name: "intruder",
          email: "intruder@example.com",
          password: "intruder-passphrase",
        }),
      });
      expect(signUp.ok).toBe(false);
      const signIn = yield* world.request("http://umail.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: yield* jsonText({
          email: "intruder@example.com",
          password: "intruder-passphrase",
        }),
      });
      expect(signIn.status).toBe(401);
      expect(yield* Effect.promise(() => world.db.all("SELECT email FROM user"))).toEqual(
        usersBefore,
      );
    }),
  );

  it.effect("rejects the old password after rotation", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      yield* provisionAuth(memoryQueryDatabase(world.db), {
        identity: { databaseId: "test-auth" },
        runNonce: "after-rotation",
        operatorEmail: OPERATOR_EMAIL,
        restResource: restResourceUrl(TEST_SITE),
        mcpResource: mcpResourceUrl(TEST_SITE),
        password: "replacement-passphrase",
      }).pipe(Effect.provide(WorkerServices));

      const oldPassword = yield* world.request("http://umail.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: yield* jsonText({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
      });
      expect(oldPassword.status).toBe(401);

      const newPassword = yield* world.request("http://umail.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: yield* jsonText({ email: OPERATOR_EMAIL, password: "replacement-passphrase" }),
      });
      expect(newPassword.status).toBe(200);
    }),
  );

  it.effect("signs in a mixed-case operator email through the provisioned issuer mapping", () =>
    Effect.gen(function* () {
      const mixedCaseEmail = yield* Schema.decodeEffect(ExternalMailAddress)("Admin@example.com");
      const world = yield* createWorld();
      yield* provisionAuth(memoryQueryDatabase(world.db), {
        identity: { databaseId: "test-auth" },
        runNonce: "mixed-case",
        operatorEmail: mixedCaseEmail,
        restResource: restResourceUrl(TEST_SITE),
        mcpResource: mcpResourceUrl(TEST_SITE),
        password: OPERATOR_PASSWORD,
      }).pipe(Effect.provide(WorkerServices));

      const signIn = yield* world.request("http://umail.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: yield* jsonText({ email: mixedCaseEmail, password: OPERATOR_PASSWORD }),
      });
      expect(signIn.status).toBe(200);
      expect(signIn.headers.get("set-cookie")).toContain("session");
    }),
  );
});
