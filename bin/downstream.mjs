#!/usr/bin/env node
// Runs the TypeScript CLI with Node's built-in type stripping, from the skill's own
// directory so it works from any repository.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(path.join(skillDir, "node_modules", "typescript"))) {
  console.error("downstream: installing dependencies (first run)…");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: skillDir, stdio: "inherit", shell: process.platform === "win32" });
}
const res = spawnSync(
  process.execPath,
  ["--no-warnings=ExperimentalWarning", path.join(skillDir, "cli", "downstream.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(res.status ?? 1);
