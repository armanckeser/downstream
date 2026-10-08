// Records the README demo against a real repository.
// node scripts/demo.mjs <repo> <base> <head> <plan.json> <out-dir>
// Opens a fresh review, then plays both sides: the browser (Playwright) and the agent (CLI).
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [repo, base, head, plan, out = "docs"] = process.argv.slice(2);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "downstream.mjs");
const ds = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
const dsAsync = (...args) => spawn(process.execPath, [cli, ...args], { cwd: repo, stdio: "ignore" });

ds("open", "--base", base, "--head", head, "--no-browser");
const url = ds("url").trim();
mkdirSync(out, { recursive: true });
const videoDir = path.join(out, ".video");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } });
// Headless video has no pointer; draw one so viewers can follow.
await ctx.addInitScript(() => {
  window.addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.style.cssText = "position:fixed;z-index:99999;width:14px;height:14px;border-radius:50%;background:rgba(232,228,219,.9);box-shadow:0 0 0 2px rgba(17,18,20,.85);pointer-events:none;transform:translate(-50%,-50%);left:-20px;top:-20px;transition:transform 120ms";
    document.body.appendChild(c);
    window.addEventListener("pointermove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    window.addEventListener("pointerdown", () => (c.style.transform = "translate(-50%,-50%) scale(.75)"), true);
    window.addEventListener("pointerup", () => (c.style.transform = "translate(-50%,-50%)"), true);
  });
});
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const cursor = async (locator) => {
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
};

await page.goto(url, { waitUntil: "networkidle" });
await wait(1600);

// The agent writes its walkthrough; the page fills in live.
ds("apply", plan);
await wait(2600);

// Walk it.
const walk = page.getByRole("button", { name: /Walk through it/ });
await cursor(walk);
await walk.click();
await wait(2200);

// Hover a type: real TypeScript, with its doc comment.
const liveItem = page.locator("article").first().locator("span", { hasText: /^LiveItem$/ }).first();
await cursor(liveItem);
await wait(2400);
await page.mouse.move(700, 120, { steps: 10 });
await wait(400);

// Next step: follow the helper.
await page.keyboard.press("j");
await wait(2000);
await page.keyboard.press("j");
await wait(2400);

// The agent listens; ask it something and it answers in the margin.
const listening = spawn(process.execPath, [cli, "wait", "--timeout", "120"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
let heard = "";
listening.stdout.on("data", (d) => (heard += d));
await wait(1500);
const box = page.locator("#composer");
await cursor(box);
await box.click();
await box.pressSequentially("Does this run on every render?", { delay: 38 });
await wait(300);
await page.keyboard.press("Control+Enter");
await new Promise((r) => listening.on("exit", r));
const asked = { id: heard.match(/\[(n_[a-z0-9]+)\]/)[1] };
dsAsync(
  "reply",
  asked.id,
  "Only when `items` or `today` change: it runs inside the `useMemo` that groups the agenda by day. Each call is two passes over one day's items.",
);
await wait(3200);

await page.mouse.click(640, 860);
// The system at a glance.
await page.keyboard.press("m");
await wait(1600);
const node = page.locator("[data-node]").filter({ hasText: "openFirst" }).first();
await cursor(node);
await wait(2400);

await ctx.close();
await browser.close();
const video = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
renameSync(path.join(videoDir, video), path.join(out, "demo.webm"));
console.log(path.join(out, "demo.webm"));
void readFileSync;
