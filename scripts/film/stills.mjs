// The README's stills, from the same made-up inbox and storefront as the film.
// node scripts/film/stills.mjs [out-dir]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, "..", "..", "docs"));
const DIR = "/tmp/downstream-stills";
const PORT = "4427";

const stage = (...extra) =>
  Object.fromEntries(
    execFileSync("sh", [path.join(here, "stage.sh"), DIR, PORT, ...extra], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );

const asAgent = (page, action, input) =>
  page.evaluate(
    async ([action, input]) => {
      const api = location.pathname.replace(/\/$/, "") + "/api";
      const r = await fetch(`${api}/actions/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-downstream-actor": "agent" }, body: JSON.stringify({ input }) });
      return r.status;
    },
    [action, input],
  );

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name) => {
  await page.mouse.move(1435, 895);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(name);
};

const { home } = stage();
await page.goto(home, { waitUntil: "networkidle" });
await page.getByText("Discount codes at checkout").first().click();
await page.getByRole("button", { name: /Start review/ }).waitFor();
await shot("home");

const { review } = stage("review");
await page.goto(review, { waitUntil: "networkidle" });
await asAgent(page, "apply", JSON.parse(readFileSync(path.join(here, "plan.json"), "utf8")));
await page.getByText("NEEDS YOU", { exact: false }).first().waitFor();
await shot("overview");

await page.getByRole("button", { name: /Start walkthrough/ }).click();
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(800);
await page.locator("article").filter({ hasText: "applyDiscount" }).last().getByText("subtotal", { exact: true }).first().hover();
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, "trail.png") });
console.log("trail");

await page.locator("#composer").click();
await page.keyboard.type("What if someone types spring20 with a space?");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(600);
const state = await page.evaluate(async () => (await fetch(location.pathname.replace(/\/$/, "") + "/api/state")).json());
const asked = state.notes.filter((n) => n.author === "user").sort((a, b) => b.number - a.number)[0];
await asAgent(page, "note.reply", { noteId: asked.id, body: "It still works: `findCode` trims and uppercases what was typed (line 8), so ` spring20 ` matches `SPRING20`." });
await shot("conversation");

await page.keyboard.press("Escape");
await page.locator("body").click({ position: { x: 600, y: 880 } });
await page.keyboard.press("m");
await page.waitForTimeout(1200);
await page.locator("[data-node]").filter({ hasText: "applyDiscount" }).first().hover();
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(out, "map.png") });
console.log("map");

await page.mouse.move(700, 80);
await page.getByRole("button", { name: /^Send/ }).first().click();
await page.getByRole("button", { name: "Request changes" }).click();
await shot("send");

await browser.close();
execFileSync("node", [path.join(here, "..", "..", "bin", "downstream.mjs"), "stop"], { env: { ...process.env, DOWNSTREAM_HOME: `${DIR}/home` } });
