import { ExternalMailAddress } from "@umail/api-contract";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { mcpResourceUrl, restResourceUrl } from "../../src/auth/options.ts";
import { provisionAuth } from "../../src/auth/provisioning.ts";
import { memoryQueryDatabase } from "./memory-d1.ts";
import { OPERATOR_EMAIL, OPERATOR_PASSWORD, TEST_SITE, createWorld, runInWorker } from "./world.ts";

const SessionBody = Schema.Struct({
  user: Schema.Struct({
    email: Schema.String,
  }),
});

describe("provisioned operator authority", () => {
  it("grants operator authority only to the configured credentials", async () => {
    const world = await createWorld();
    const session = await world.fetch("http://umail.test/api/auth/get-session", {
      headers: { cookie: world.sessionCookie },
    });
    expect(session.status).toBe(200);
    const body = Schema.decodeUnknownSync(SessionBody)(await session.json());
    expect(body.user.email).toBe(OPERATOR_EMAIL);
    expect(world.operatorAccessToken.length).toBeGreaterThan(0);
  });

  it("never creates authority from an unknown email or public signup", async () => {
    const world = await createWorld();
    const usersBefore = await world.db.all("SELECT email FROM user");
    const signUp = await world.fetch("http://umail.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "intruder",
        email: "intruder@example.com",
        password: "intruder-passphrase",
      }),
    });
    expect(signUp.ok).toBe(false);
    const signIn = await world.fetch("http://umail.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "intruder@example.com",
        password: "intruder-passphrase",
      }),
    });
    expect(signIn.status).toBe(401);
    expect(await world.db.all("SELECT email FROM user")).toEqual(usersBefore);
  });

  it("rejects the old password after rotation", async () => {
    const world = await createWorld();
    await runInWorker(
      provisionAuth(memoryQueryDatabase(world.db), {
        identity: { databaseId: "test-auth" },
        runNonce: "after-rotation",
        operatorEmail: OPERATOR_EMAIL,
        restResource: restResourceUrl(TEST_SITE),
        mcpResource: mcpResourceUrl(TEST_SITE),
        password: "replacement-passphrase",
      }),
    );

    const oldPassword = await world.fetch("http://umail.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await world.fetch("http://umail.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OPERATOR_EMAIL, password: "replacement-passphrase" }),
    });
    expect(newPassword.status).toBe(200);
  });

  it("signs in a mixed-case operator email through the provisioned issuer mapping", async () => {
    const mixedCaseEmail = Schema.decodeSync(ExternalMailAddress)("Admin@example.com");
    const world = await createWorld();
    await runInWorker(
      provisionAuth(memoryQueryDatabase(world.db), {
        identity: { databaseId: "test-auth" },
        runNonce: "mixed-case",
        operatorEmail: mixedCaseEmail,
        restResource: restResourceUrl(TEST_SITE),
        mcpResource: mcpResourceUrl(TEST_SITE),
        password: OPERATOR_PASSWORD,
      }),
    );

    const signIn = await world.fetch("http://umail.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: mixedCaseEmail, password: OPERATOR_PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie")).toContain("session");
  });
});
