// Films the README's launch GIF against the made-up inbox and storefront
// (stage.sh): the home page, then one review from the agent's first read to
// the review landing on the pull request, with a caption under each beat.
//
// FILM_MJS=<film.mjs> node scripts/film/shoot.mjs [--scale 2] [--out docs/launch.gif]
//
// FILM_MJS is a frame-stepped Playwright renderer that takes a storyboard
// (url, viewport, steps of moveTo/click/type/key/evaluate/hold) and writes an
// mp4, logging `mark <name> <ms>` to stderr for each step with a `mark` and
// `mark end <ms>` when the take ends. It also needs `replay: false`, because
// the review re-reads /state on every live event.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const scale = Number(option("scale", "2"));
const out = path.resolve(option("out", path.join(root, "docs", "launch.gif")));
const film = process.env.FILM_MJS ?? (() => { throw new Error("Set FILM_MJS to a film.mjs renderer."); })();
const work = "/tmp/downstream-film-takes";
mkdirSync(work, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };
const BAND = 96;
const PAGE = "#111214";

/** One line under the frame for each beat: what you get, then how. */
const CAPTIONS = {
  home: ["Know what needs you.", "Every pull request waiting on you, and the one to do first."],
  agent: ["Your agent reads it first.", "It maps the change and writes you a walkthrough."],
  trail: ["Read it the way it runs.", "Follow each call from where the change starts, with the bugs pinned to their lines."],
  ask: ["Ask, and keep reading.", "The answer lands right next to the code."],
  send: ["Send what you agreed on.", "Your verdict and your words, posted to the pull request."],
};

/** Runs stage.sh and reads back the `name=url` it prints. */
const stage = (...extra) =>
  Object.fromEntries(
    execFileSync("sh", [path.join(here, "stage.sh"), "/tmp/downstream-film", "4417", ...extra], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );

/** `downstream wait` in a loop, as the agent runs it, until the user asks; the take then replies. */
function listen() {
  const env = { ...process.env, DOWNSTREAM_HOME: "/tmp/downstream-film/home", DOWNSTREAM_HOSTED: "1" };
  const wait = `node "${path.join(root, "bin", "downstream.mjs")}" wait --timeout 200`;
  spawn("sh", ["-c", `until ${wait} | grep -q "The user asked"; do :; done`], { cwd: "/tmp/downstream-film/storefront", env, stdio: "ignore", detached: true }).unref();
}

const plan = readFileSync(path.join(here, "plan.json"), "utf8");
const api = `location.pathname.replace(/\\/$/, "") + "/api"`;
const asAgent = `{ method: "POST", headers: { "content-type": "application/json", "x-downstream-actor": "agent" } }`;
const APPLY = `fetch(${api} + "/actions/apply", { ...${asAgent}, body: JSON.stringify({ input: ${plan} }) }).then((r) => r.status)`;
const REPLY = `(async () => {
  const state = await (await fetch(${api} + "/state")).json();
  const asked = state.notes.filter((n) => n.author === "user").sort((a, b) => b.number - a.number)[0];
  const body = "It still works: \`findCode\` trims and uppercases what was typed (line 8), so \` spring20 \` matches \`SPRING20\`.";
  return (await fetch(${api} + "/actions/note.reply", { ...${asAgent}, body: JSON.stringify({ input: { noteId: asked.id, body } }) })).status;
})()`;
// Start review would launch a real agent; the film cuts to the review instead.
const HOLD_START = `document.addEventListener("click", (e) => { if (e.target.closest("button")?.textContent.includes("Start review")) { e.preventDefault(); e.stopImmediatePropagation(); } }, true)`;

const common = { viewport: VIEWPORT, deviceScaleFactor: scale, replay: false, settleMs: 900 };
const TAKES = [
  {
    name: "home",
    url: () => stage().home,
    waitFor: "text=Discount codes at checkout",
    steps: [
      { mark: "home", hold: 1600 },
      { moveTo: "text=Discount codes at checkout", travelMs: 1000, hold: 150 },
      { click: true, hold: 1700 },
      { evaluate: HOLD_START, moveTo: "button:has-text('Start review')", travelMs: 900, hold: 150 },
      { click: true, hold: 700 },
    ],
  },
  {
    name: "review",
    // Opened only now, so the home take still offers to start it. The agent
    // listens the way it does in a real review, so the question reads as heard.
    url: () => {
      const { review } = stage("review");
      listen();
      return review;
    },
    waitFor: "text=Agent is reading",
    steps: [
      { mark: "agent", hold: 1500 },
      { evaluate: APPLY, hold: 2900 },
      { mark: "trail", moveTo: "button:has-text('Start walkthrough')", travelMs: 900, hold: 100 },
      { click: true, hold: 1900 },
      { key: "Enter", hold: 1300 },
      { key: "Enter", hold: 1300 },
      { key: "Enter", hold: 1100 },
      { moveTo: "article :text('A $20 code on a $15 cart')", travelMs: 900, hold: 1600 },
      { mark: "ask", moveTo: "#composer", travelMs: 900, hold: 100 },
      { click: true, hold: 250 },
      { type: "What if someone types spring20 with a space?", hold: 350 },
      { key: "Control+Enter", hold: 1200 },
      { evaluate: REPLY, hold: 2800 },
      { mark: "send", moveTo: "button:has-text('Send…')", travelMs: 900, hold: 100 },
      { click: true, hold: 1200 },
      { moveTo: "button:has-text('Request changes')", travelMs: 700, hold: 100 },
      { click: true, hold: 500 },
      { moveTo: "button:has-text('Send to #482')", travelMs: 800, hold: 100 },
      { click: true, hold: 800 },
      { moveTo: "button:text-is('Send')", travelMs: 500, hold: 100 },
      { click: true, hold: 2800 },
    ],
  },
];

/** Renders one take; returns its mp4 and when each marked beat starts and the take ends, in seconds. */
function shoot(take) {
  const storyboard = path.join(work, `${take.name}.json`);
  const video = path.join(work, `${take.name}.mp4`);
  writeFileSync(storyboard, JSON.stringify({ ...common, ...take, url: take.url() }, null, 2));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [film, storyboard, video], { stdio: ["ignore", "inherit", "pipe"], cwd: path.dirname(film) });
    const marks = [];
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
      for (const m of String(chunk).matchAll(/^mark (\S+) ([\d.]+)$/gm)) marks.push({ name: m[1], at: Number(m[2]) / 1000 });
    });
    child.on("exit", (code) => (code === 0 ? resolve({ video, marks }) : reject(new Error(`${take.name} failed:\n${log}`))));
  });
}

/** The caption strip for a beat, in the app's own type and colors. */
async function captions() {
  const css = pathToFileURL(path.join(root, "node_modules", "@fontsource-variable", "geist", "index.css")).href;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: VIEWPORT.width, height: BAND }, deviceScaleFactor: scale });
  const files = {};
  for (const [name, [lead, rest]] of Object.entries(CAPTIONS)) {
    await page.setContent(`<link rel="stylesheet" href="${css}"><style>
      html, body { margin: 0; height: 100%; background: ${PAGE}; }
      body { display: grid; place-items: center; font: 400 25px/1 "Geist Variable", sans-serif; letter-spacing: -0.01em; color: #a8a49c; }
      b { color: #e8e4db; font-weight: 600; }
    </style><p><b>${lead}</b> ${rest}</p>`);
    await page.evaluate(() => document.fonts.ready);
    files[name] = path.join(work, `caption-${name}.png`);
    await page.screenshot({ path: files[name] });
  }
  await browser.close();
  return files;
}

const FADE = 0.3;
const CROSSFADE = 0.5;

/** One take with its band and captions burned in. */
function caption(take, files) {
  const end = take.marks.find((m) => m.name === "end").at;
  const beats = take.marks.filter((m) => m.name !== "end").map((m, i, all) => ({ ...m, until: all[i + 1]?.at ?? end }));
  const inputs = ["-i", take.video, ...beats.flatMap((b) => ["-loop", "1", "-t", String(end), "-i", files[b.name]])];
  let graph = `[0:v]pad=iw:ih+${BAND * scale}:0:0:color=${PAGE.replace("#", "0x")}[v0]`;
  beats.forEach((b, i) => {
    const fadeIn = i === 0 ? "" : `fade=t=in:st=${b.at}:d=${FADE}:alpha=1,`;
    const fadeOut = b.until >= end ? "" : `,fade=t=out:st=${b.until - FADE}:d=${FADE}:alpha=1`;
    graph += `;[${i + 1}:v]format=rgba,${fadeIn}null${fadeOut}[c${i}];[v${i}][c${i}]overlay=0:H-h:shortest=1[v${i + 1}]`;
  });
  const result = path.join(work, `${path.basename(take.video, ".mp4")}-captioned.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", `[v${beats.length}]`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", result]);
  return { video: result, duration: end };
}

const shot = [];
for (const take of TAKES) shot.push(await shoot(take));
const files = await captions();
const [home, review] = shot.map((take) => caption(take, files));

const joined = path.join(work, "launch.mp4");
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-i", home.video, "-i", review.video,
  "-filter_complex", `[0:v][1:v]xfade=transition=fade:duration=${CROSSFADE}:offset=${home.duration - CROSSFADE}[v]`,
  "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", joined,
]);

const WIDTH = 1280;
const FPS = 15;
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-i", joined,
  "-vf", `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  out,
]);
console.log(joined);
console.log(out);
