// Screenshots of a running review, for checking the UI and for the README.
// node scripts/shoot.mjs <url> <outDir> [width] [height]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const [url = "http://127.0.0.1:4317", out = "shots", w = "1600", h = "1000"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log("shot", name);
};

await page.goto(url, { waitUntil: "networkidle" });
await shot("1-overview");

await page.keyboard.press("m");
await shot("2-map");

await page.keyboard.press("o");
const door = page.locator("nav[aria-label='Ways in'] ul li button").first();
await door.click();
await page.waitForTimeout(1200);
await shot("3-trail");

// Follow the first call chip of the first frame.
const chip = page.locator("article").first().locator("text=calls").locator("xpath=..").locator("button").first();
if (await chip.count()) {
  await chip.click();
  await page.waitForTimeout(1200);
  await shot("4-trail-deeper");
}

const step = page.locator("nav[aria-label='Ways in'] ol li button").first();
if (await step.count()) {
  await step.click();
  await page.waitForTimeout(1200);
  await shot("5-step");
}

const thread = page.locator("aside[aria-label='Conversation'] ul li button").first();
if (await thread.count()) {
  await thread.click();
  await page.waitForTimeout(1000);
  await shot("6-thread");
}

if (errors.length) console.log("console errors:\n" + errors.join("\n"));
await browser.close();
