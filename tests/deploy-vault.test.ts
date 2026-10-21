import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const deploy = new URL("../tools/deploy.sh", import.meta.url).pathname;

// `pnpm deploy:stage` must hand Alchemy the vault of the stage it deploys, so the prod stage never
// gets dev's values. A fake `agents` on the PATH prints the command it was given, offline.
describe("deploy:stage vault", () => {
  let bin: string;
  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), "umail-deploy-vault-"));
    await writeFile(join(bin, "agents"), '#!/bin/sh\necho "$@"\n');
    await chmod(join(bin, "agents"), 0o755);
  });
  afterAll(() => rm(bin, { recursive: true, force: true }));

  const command = async (args: ReadonlyArray<string>, stage?: string) => {
    const { ALCHEMY_STAGE: _, ...env } = process.env;
    const { stdout } = await run(deploy, args, {
      env: { ...env, PATH: `${bin}:${env.PATH}`, ...(stage && { ALCHEMY_STAGE: stage }) },
      timeout: 10_000,
    });
    return stdout.trim();
  };

  it.each([
    [["--stage", "prod", "--profile", "p", "--dry-run"], undefined, "prod"],
    [["--stage=prod"], undefined, "prod"],
    [["--dry-run"], "prod", "prod"],
    [["--stage", "pr-12"], undefined, "dev"],
    [["--stage", "pr-12"], "prod", "dev"],
    [["--stage", "prod"], "pr-12", "prod"],
    [["--profile", "prod"], undefined, "dev"],
    [[], undefined, "dev"],
  ])("runs %j with ALCHEMY_STAGE=%s under the %s vault", async (args, stage, vault) => {
    expect(await command(args, stage)).toBe(
      `run --env ${vault} -- alchemy deploy ${args.join(" ")}`.trim(),
    );
  });
});
