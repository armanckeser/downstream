import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
p.on("console", (m) => { if (m.type() === "error" || m.type()==="warning") console.log(m.type(), m.text().slice(0, 1500)); });
p.on("pageerror", (e) => console.log("PAGEERR", e.stack?.slice(0, 2500)));
await p.goto("http://127.0.0.1:7341", { waitUntil: "networkidle" });
await p.locator("nav[aria-label='Ways in'] ul li button").first().click();
await p.waitForTimeout(2500);
await b.close();
