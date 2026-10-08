#!/usr/bin/env node
// Runs the TypeScript CLI through tsx, resolved from the skill's own node_modules
// so it works from any repository.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(path.join(skillDir, "node_modules", "tsx"))) {
  console.error("downstream: installing dependencies (first run)…");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: skillDir, stdio: "inherit", shell: process.platform === "win32" });
}
const tsx = import.meta.resolve("tsx");
const res = spawnSync(
  process.execPath,
  ["--no-warnings=ExperimentalWarning", "--import", tsx, path.join(skillDir, "cli", "downstream.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(res.status ?? 1);
