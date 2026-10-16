#!/usr/bin/env node
// Runs the CLI from the package's own directory so it works from any repository.
// A clone runs the TypeScript sources with Node's built-in type stripping. A
// published copy (npx, npm install) sits under node_modules, where Node refuses
// to strip types, so it runs the JavaScript compiled into dist/ at publish time.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const published = skillDir.split(path.sep).includes("node_modules");
const entry = published ? path.join(skillDir, "dist", "cli", "downstream.js") : path.join(skillDir, "cli", "downstream.ts");
if (!published && !existsSync(path.join(skillDir, "node_modules", "typescript"))) {
  console.error("downstream: installing dependencies (first run)…");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: skillDir, stdio: "inherit", shell: process.platform === "win32" });
}
const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
