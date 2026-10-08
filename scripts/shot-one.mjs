// node scripts/shot-one.mjs <url> <out.png> [door-name] [key]
import { chromium } from "playwright";
const [url, out, door, key] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
p.on("pageerror", (e) => console.log("PAGEERR", e.message));
await p.goto(url, { waitUntil: "networkidle" });
if (door) { await p.locator("nav[aria-label='Ways in'] ul li button", { hasText: door }).first().click(); await p.waitForTimeout(1500); }
if (key) { await p.keyboard.press(key); await p.waitForTimeout(1000); }
await p.screenshot({ path: out, fullPage: !!process.env.FULL });
await b.close();
