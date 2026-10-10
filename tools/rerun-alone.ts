// The gate's lone rerun (AGENTS.md, Checks): each test a red Vitest run failed runs once more alone, in
// a process of its own. A pass alone is a flake and appends a line to the ledger; the gate stays red.
// Run in the suite's directory: node <root>/tools/rerun-alone.ts <config> <json report>
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LEDGER = new URL("../flakes.md", import.meta.url);

type Report = {
  readonly testResults: ReadonlyArray<{
    readonly name: string;
    readonly assertionResults: ReadonlyArray<{
      readonly ancestorTitles: ReadonlyArray<string>;
      readonly title: string;
      readonly status: string;
      readonly failureMessages: ReadonlyArray<string>;
    }>;
  }>;
};

const [config, report] = process.argv.slice(2);
const failed = (JSON.parse(readFileSync(report, "utf8")) as Report).testResults.flatMap((file) =>
  file.assertionResults
    .filter((test) => test.status === "failed")
    .map((test) => ({
      file: file.name,
      // The name `-t` matches; the report's fullName joins the titles with spaces instead.
      name: [...test.ancestorTitles, test.title].join(" > "),
      message: test.failureMessages[0],
    })),
);

const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" });
const task = /^task-\d+/.exec(branch)?.[0] ?? "task-?";
const date = new Date().toISOString().slice(0, 10);
const code = (text: string) => `\`${text.replaceAll("`", "'")}\``;

for (const test of failed) {
  const pattern = `^${test.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const file = relative(process.cwd(), test.file);
  console.log(`\nRerunning alone: ${file} > ${test.name}`);
  const alone = spawnSync("vitest", ["run", "--config", config, file, "-t", pattern], {
    stdio: "inherit",
    timeout: 300_000,
  });
  if (alone.status !== 0) {
    console.log("Fails alone: a bug in the change or the test, not a flake.");
    continue;
  }
  const symptom = (test.message ?? "").split("\n")[0];
  appendFileSync(
    LEDGER,
    `- ${date} ${task} ${code(`${relative(ROOT, test.file)} > ${test.name}`)} — ${code(symptom)} — cause: ?\n`,
  );
  console.log("Passes alone: a flake, logged in flakes.md. Fix its cause or skip it.");
}
