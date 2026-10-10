import { globSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "@effect/vitest";

// A skipped flaky test guards nothing, so its skip lapses by itself within 14 days (awesome-tests):
// `skipIf` on the real clock, marked `// flaky: task-<n> until <yyyy-mm-dd>` on its line or the one above.
const SKIP = /\.(?:skip|skipIf)\(/;
const CONDITIONAL = /\.skipIf\(/;
const FLAKY = /\/\/ flaky: task-\d+ until (\d{4}-\d{2}-\d{2})$/;
const FLAKY_ABOVE = new RegExp(`^\\s*${FLAKY.source}`);
const LIFETIME_MS = 14 * 86_400_000;

const ROOT = new URL("../", import.meta.url);

it("lets every skipped test run again within 14 days", () => {
  const latest = new Date(Date.now() + LIFETIME_MS).toISOString().slice(0, 10);
  const problems = globSync("**/*.{test,spec}.ts", {
    cwd: fileURLToPath(ROOT),
    exclude: ["**/node_modules/**", "**/dist/**"],
  }).flatMap((file) =>
    readFileSync(new URL(file, ROOT), "utf8")
      .split("\n")
      .flatMap((line, index, lines) => {
        if (!SKIP.test(line)) return [];
        const until = FLAKY.exec(line)?.[1] ?? FLAKY_ABOVE.exec(lines[index - 1] ?? "")?.[1];
        if (until === undefined || !CONDITIONAL.test(line)) {
          return [`${file}:${index + 1}: not a skipIf marked "// flaky: task-<n> until <date>"`];
        }
        return until > latest
          ? [`${file}:${index + 1}: skipped until ${until}, past ${latest}`]
          : [];
      }),
  );
  expect(problems).toEqual([]);
});
