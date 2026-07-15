import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const tests = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => resolve("tests", name));
const isolated = tests.filter((file) => file.endsWith("workflow-sandbox.test.ts"));
const groups = [tests.filter((file) => !isolated.includes(file)), isolated];

for (const files of groups) {
  if (!files.length) continue;
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
