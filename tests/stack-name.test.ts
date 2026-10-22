import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const runNode = promisify(execFile);
const entrypoint = new URL("../alchemy.run.ts", import.meta.url).href;
const loader = new URL("../node_modules/alchemy/bin/register-oxc.js", import.meta.url).pathname;
const invalidName =
  "UMAIL_STACK must start with a letter and contain only letters, digits or internal hyphens.";

describe("installation identity at the real stack entrypoint", () => {
  it("selects the exact stack from the environment alone and rejects explicit blanks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "umail-stack-"));
    try {
      // `file` writes a `.env` beside the command: Alchemy loads it, but it never selects the stack.
      const scenarios = [
        { shell: null, file: null, expected: "uMail" },
        { shell: "uMail-academind", file: null, expected: "uMail-academind" },
        { shell: null, file: "uMail-file", expected: "uMail" },
        { shell: "uMail-shell", file: "", expected: "uMail-shell" },
        { shell: "", file: "uMail-file", expected: invalidName },
        { shell: " UMail ", file: null, expected: invalidName },
        { shell: "uMail/academind", file: null, expected: invalidName },
        {
          shell: "a".repeat(33),
          file: null,
          expected: "UMAIL_STACK must be at most 32 characters.",
        },
      ];
      // One isolated process imports the actual entrypoint afresh for each configuration. Only
      // module evaluation runs: no Stack effect or cloud provider is executed.
      const script = `
        import { writeFile, rm } from "node:fs/promises";
        import { isUserFacing } from ${JSON.stringify(new URL("../node_modules/alchemy/lib/UserFacingError.js", import.meta.url).href)};
        const scenarios = ${JSON.stringify(scenarios)};
        const results = [];
        for (const [index, scenario] of scenarios.entries()) {
          if (scenario.shell === null) delete process.env.UMAIL_STACK;
          else process.env.UMAIL_STACK = scenario.shell;
          if (scenario.file === null) await rm(".env", { force: true });
          else await writeFile(".env", "UMAIL_STACK=" + JSON.stringify(scenario.file) + "\\n");
          try {
            const { default: stack } = await import(${JSON.stringify(entrypoint)} + "?selection=" + index);
            results.push({ name: stack.stackName });
          } catch (error) {
            results.push({ message: error.message, userFacing: isUserFacing(error) });
          }
        }
        process.stdout.write(JSON.stringify(results));
      `;
      const { stdout, stderr } = await runNode(
        process.execPath,
        ["--import", loader, "--input-type=module", "--eval", script],
        { cwd: directory, timeout: 20_000 },
      );
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual(
        scenarios.map(({ expected }) =>
          expected.startsWith("UMAIL_STACK ")
            ? { message: expected, userFacing: true }
            : { name: expected },
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prints an import-time stack error on one line through the actual Alchemy CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "umail-stack-error-"));
    try {
      // Keep the real CLI offline: its version check accepts a fresh cache without dist-tags.
      await mkdir(join(directory, ".alchemy"));
      await writeFile(
        join(directory, ".alchemy/version-check.json"),
        JSON.stringify({ checkedAt: Date.now() }),
      );
      let result;
      try {
        result = await runNode(
          process.execPath,
          [
            new URL("../node_modules/alchemy/bin/cli.js", import.meta.url).pathname,
            "deploy",
            "--config",
            new URL(entrypoint).pathname,
            "--stage",
            "prod",
            "--dry-run",
            "--no-input",
          ],
          {
            cwd: directory,
            env: { ...process.env, UMAIL_STACK: "", ALCHEMY_TELEMETRY_DISABLED: "1" },
            timeout: 20_000,
          },
        );
      } catch (error) {
        result = error as Error & { code: number; stdout: string; stderr: string };
      }
      expect(result).toHaveProperty("code", 1);
      expect(result.stderr.trim()).toBe(`error: ${invalidName}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
