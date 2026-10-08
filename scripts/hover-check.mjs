import { chromium } from "playwright";
const url = process.argv[2] ?? "http://127.0.0.1:4318";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
p.on("pageerror", (e) => console.log("PAGEERR", e.message));
await p.goto(url, { waitUntil: "networkidle" });
await p.locator("nav[aria-label='Ways in'] ol li button").first().click();
await p.waitForTimeout(1500);
// Pierre renders into a shadow root; Playwright pierces open shadow DOM.
const tok = p.locator("article").first().locator("span", { hasText: /^baseState$/ }).first();
console.log("tokens", await tok.count());
await tok.hover();
await p.waitForTimeout(1500);
await p.screenshot({ path: ".shots/7-hover.png" });
const tok2 = p.locator("article").first().locator("span", { hasText: /^LiveItem$/ }).first();
await tok2.hover();
await p.waitForTimeout(1500);
await p.screenshot({ path: ".shots/8-hover-ts.png" });
await b.close();
