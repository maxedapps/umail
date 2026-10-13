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
  it("selects the exact stack with CLI env-file precedence and rejects explicit blanks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "umail-stack-"));
    try {
      const scenarios = [
        { shell: null, file: null, selected: null, expected: "uMail" },
        { shell: null, file: "uMail", selected: null, expected: "uMail" },
        { shell: "uMail-shell", file: "uMail-file", selected: null, expected: "uMail-shell" },
        { shell: null, file: "uMail-file", selected: null, expected: "uMail-file" },
        {
          shell: "uMail-shell",
          file: "uMail",
          selected: "uMail-academind",
          expected: "uMail-academind",
        },
        { shell: null, file: "uMail-file", selected: null, selectAbsent: true, expected: "uMail" },
        { shell: "", file: "uMail-file", selected: null, expected: invalidName },
        { shell: "uMail-shell", file: "uMail", selected: "", expected: invalidName },
        { shell: null, file: "", selected: null, expected: invalidName },
        { shell: "", file: null, selected: null, expected: invalidName },
        { shell: null, file: null, selected: " UMail ", expected: invalidName },
        { shell: null, file: null, selected: "uMail/academind", expected: invalidName },
        {
          shell: null,
          file: null,
          selected: "a".repeat(33),
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
          process.argv = [process.execPath, "stack-selection", "deploy", "--stage", "prod"];
          if (scenario.selected !== null || scenario.selectAbsent) {
            await writeFile(".env.installation", scenario.selected === null ? "" : "UMAIL_STACK=" + JSON.stringify(scenario.selected) + "\\n");
            process.argv.push("--env-file", ".env.installation");
          }
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
      const envFile = join(directory, ".env.invalid");
      await writeFile(envFile, "UMAIL_STACK=\n");
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
            "--env-file",
            envFile,
            "--dry-run",
            "--no-input",
          ],
          {
            cwd: directory,
            env: { ...process.env, UMAIL_STACK: "uMail-shell", ALCHEMY_TELEMETRY_DISABLED: "1" },
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
