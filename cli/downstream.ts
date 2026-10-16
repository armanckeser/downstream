// `downstream`: the agent's handle on a review. Every write goes through the
// same HTTP actions the browser uses; reads can also go straight to SQLite
// through a read-only connection.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { codeRoot, install, packageRoot, serverEntry } from "../server/install.ts";
import { goesOut } from "../domain/outgoing.ts";
import { severityLabel, type CodeSymbol, type Edge, type Note, type ReviewEvent, type ReviewState } from "../domain/model.ts";

const skillDir = packageRoot;
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "home";
// Under the 300s headers timeout of Node's fetch.
const WAIT_CHUNK_SECONDS = 240;

function flags(list: string[]) {
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) opts[k] = v;
      else if (list[i + 1] !== undefined && !list[i + 1]!.startsWith("--")) opts[k] = list[++i]!;
      else opts[k] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

const { pos, opts } = flags(argv.slice(1));
const str = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);

function repoRoot(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const insideRepo = () => repoRoot() !== null;

function fail(msg: string): never {
  console.error(`downstream: ${msg}`);
  process.exit(1);
}

/** The one server for this machine, shared by every repository (and the home page). */
const homeDir = process.env.DOWNSTREAM_HOME ?? path.join(homedir(), ".downstream");
const serverFile = path.join(homeDir, "server.json");

// Repository commands need a repo; `home`, `stop` and `url` don't.
let rootCache: string | null = null;
const root = () => (rootCache ??= repoRoot() ?? fail("Not inside a git repository."));
const dir = () => path.join(root(), ".downstream");
const cursorFile = () => path.join(dir(), "agent-cursor");

async function health(): Promise<{ url: string; pid: number; startedAt: number } | null> {
  if (!existsSync(serverFile)) return null;
  const { url } = JSON.parse(readFileSync(serverFile, "utf8")) as { url: string };
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    const h = (await r.json()) as { pid: number; startedAt: number };
    return { url, pid: h.pid, startedAt: h.startedAt ?? 0 };
  } catch {
    return null;
  }
}

async function serverUrl(): Promise<string | null> {
  return (await health())?.url ?? null;
}

let repoBase: string | null = null;
/** This repository's API on the shared server: `<server>/r/<repo id>`. */
async function base(): Promise<string> {
  if (repoBase) return repoBase;
  const url = (await serverUrl()) ?? fail("no server running. Start with `downstream open`.");
  const r = await fetch(`${url}/api/repos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: root() }) });
  const body = (await r.json()) as { id?: string; error?: string };
  if (!r.ok || !body.id) fail(body.error ?? "couldn't register this repository with the server");
  return (repoBase = `${url}/r/${body.id}`);
}

function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

/** Newest change to the server's own code, so an updated skill restarts a stale server. */
function codeVersion(): number {
  return Math.max(newest(path.join(codeRoot, "server")), newest(path.join(codeRoot, "domain")));
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(freePort(start + 1)));
    s.listen(start, "127.0.0.1", () => s.close(() => resolve(start)));
  });
}

function ensureBuilt() {
  // A published copy ships its dependencies and built UI; it has no sources to build from.
  if (install === "published") return;
  if (!existsSync(path.join(skillDir, "node_modules", "hono"))) {
    console.error("downstream: installing dependencies (first run)…");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: skillDir, stdio: "inherit", shell: process.platform === "win32" });
  }
  const built = path.join(skillDir, "web", "dist", "index.html");
  if (!existsSync(built) || newest(path.join(skillDir, "web", "src")) > statSync(built).mtimeMs) {
    console.error("downstream: building the review UI…");
    execFileSync("npm", ["run", "build"], { cwd: skillDir, stdio: "inherit", shell: process.platform === "win32" });
  }
}

async function ensureServer(): Promise<string> {
  const running = await health();
  if (running && running.startedAt >= codeVersion()) return running.url;
  if (running) {
    console.error("downstream: the skill was updated; restarting the server…");
    try {
      process.kill(running.pid);
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  ensureBuilt();
  mkdirSync(homeDir, { recursive: true });
  const port = await freePort(Number(str("port") ?? 4317));
  const log = openSync(path.join(homeDir, "server.log"), "a");
  const child = spawn(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", serverEntry, `--port=${port}`],
    { cwd: skillDir, detached: true, stdio: ["ignore", log, log], windowsHide: true },
  );
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const url = await serverUrl();
    if (url) return url;
  }
  fail(`server did not start; see ${path.join(homeDir, "server.log")}`);
}

async function call<T = unknown>(name: string, input: unknown = {}): Promise<T> {
  const r = await fetch(`${await base()}/api/actions/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-downstream-actor": "agent" },
    body: JSON.stringify({ input }),
  });
  const body = (await r.json()) as T & { error?: string; issues?: unknown };
  if (!r.ok) fail(`${name}: ${body.error ?? r.statusText}${body.issues ? "\n" + JSON.stringify(body.issues, null, 2) : ""}`);
  return body;
}

async function get<T>(p: string): Promise<T> {
  const r = await fetch(`${await base()}${p.replace(/^\/api/, "/api")}`, { headers: { "x-downstream-actor": "agent" } });
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) fail(body.error ?? r.statusText);
  return body;
}

function openBrowser(url: string) {
  if (opts["no-browser"]) return;
  const [bin, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(bin, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* printing the URL is enough */
  }
}

const range = (v: string | undefined) => {
  if (!v) return null;
  const [a, b] = v.split(/[-:]/).map(Number);
  return { start: a!, end: b ?? a! };
};

const glyph: Record<string, string> = { added: "+", modified: "~", removed: "-", context: " " };

function outline(state: ReviewState) {
  const { review, symbols, edges, notes, steps, files } = state;
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const out: string[] = [];
  out.push(`${review.title}  [${review.mode}${review.base ? `, ${review.base}…${review.head === "WORKTREE" ? "working tree" : review.head}` : ""}, ${review.status}]`);
  if (files.length) {
    const add = files.reduce((n, f) => n + f.additions, 0);
    const del = files.reduce((n, f) => n + f.deletions, 0);
    out.push(`${files.length} files  +${add} -${del}`);
  }
  out.push(review.summary ? `\nSummary: ${review.summary.split("\n")[0]}` : "\nSummary: (none yet: `downstream apply` or review.update)");

  const entries = symbols.filter((s) => s.entry);
  out.push(`\nEntry points (${entries.length})`);
  for (const s of entries) out.push(`  ${s.id}`);

  const order = ["added", "modified", "removed", "context"] as const;
  out.push(`\nSymbols  (+ added  ~ modified  - removed  · context)`);
  for (const status of order) {
    for (const s of symbols.filter((x) => x.status === status).sort((a, b) => a.file.localeCompare(b.file))) {
      const lines = s.range ? `:${s.range.start}-${s.range.end}` : s.oldRange ? ` (was :${s.oldRange.start}-${s.oldRange.end})` : "";
      const tag = s.status === "context" ? "·" : glyph[s.status];
      out.push(`  ${tag} ${s.id}${lines}  ${s.kind}${s.entry ? "  ENTRY" : ""}${s.summary ? `\n      ${s.summary}` : ""}`);
    }
  }

  out.push(`\nFlow (${edges.length} edges; * = new in this change, x = removed)`);
  for (const e of edges.sort((a, b) => a.from.localeCompare(b.from))) {
    const mark = e.change === "added" ? "*" : e.change === "removed" ? "x" : " ";
    out.push(`  ${mark} ${short(byId.get(e.from), e.from)} ─${e.kind}→ ${short(byId.get(e.to), e.to)}${e.line ? `  (line ${e.line})` : ""}${e.label ? `  "${e.label}"` : ""}`);
  }

  out.push(`\nWalkthrough (${steps.length} steps)`);
  for (const s of steps) out.push(`  ${s.order}. ${s.title}${s.symbolId ? `  → ${s.symbolId}` : ""}`);

  const open = notes.filter((n) => n.status === "open");
  out.push(`\nThreads (${open.length} open of ${notes.length})`);
  for (const n of notes) out.push(`  ${noteLine(n)}`);
  const posts = state.review.posts;
  if (posts.length) {
    out.push(`\nComments for other PRs (${posts.filter((p) => !p.posted).length} not posted)`);
    for (const p of posts) out.push(`  [${p.id}] ${p.repo}#${p.number}${p.posted ? ` posted ${p.posted.url}` : " not posted"}: ${p.body.split("\n")[0]!.slice(0, 80)}`);
  }
  return out.join("\n");
}

const short = (s: CodeSymbol | undefined, id: string) => (s ? `${s.container ? s.container + "." : ""}${s.name}` : id);

function noteLine(n: Note) {
  const sev = n.severity ? `/${severityLabel[n.severity]}` : "";
  const out = goesOut(n) ? "  [in the review]" : "  [private]";
  const last = n.replies.at(-1);
  const waiting = last ? (last.author === "user" ? "  ← user replied" : "") : n.author === "user" ? "  ← from user" : "";
  return `#${n.number} [${n.id}] ${n.status === "open" ? "" : `(${n.status}) `}${n.kind}${sev} by ${n.author}: ${n.title}${n.symbolId ? `  @ ${n.symbolId}` : ""}${n.lines ? `:${n.lines.start}-${n.lines.end}` : ""}  (${n.replies.length} replies)${waiting}${out}`;
}

function printFrame(patch: string) {
  const lines = patch.split("\n");
  const header = lines.find((l) => l.startsWith("@@"))!;
  const m = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)!;
  let oldN = Number(m[1]);
  let newN = Number(m[2]);
  const out: string[] = [];
  for (const l of lines.slice(lines.indexOf(header) + 1)) {
    if (!l && out.length && lines.at(-1) === l) continue;
    const t = l[0];
    if (t === "+") out.push(`${String(newN++).padStart(5)} + ${l.slice(1)}`);
    else if (t === "-") out.push(`${String(oldN++).padStart(5)} - ${l.slice(1)}`);
    else {
      out.push(`${String(newN++).padStart(5)}   ${l.slice(1)}`);
      oldN++;
    }
  }
  console.log(out.join("\n"));
}

function describe(e: ReviewEvent, state: ReviewState | null): string {
  const p = e.payload as Record<string, unknown>;
  const note = state?.notes.find((n) => n.id === (p.noteId ?? p.id));
  switch (e.type) {
    case "ask":
      return `The user asked [${p.id}]${p.symbolId ? ` about ${p.symbolId}` : ""}${p.lines ? ` lines ${(p.lines as { start: number }).start}-${(p.lines as { end: number }).end}` : ""}:\n  "${p.body}"\n  → answer: downstream reply ${p.id} "…"`;
    case "note.replied":
      return `The user replied in [${p.noteId}] "${p.title}":\n  "${p.body}"\n  → downstream reply ${p.noteId} "…"   (or resolve it: downstream resolve ${p.noteId} "why")`;
    case "note.added":
      return `The user opened a ${String(p.kind)} [${p.id}]: "${p.title}"${note?.body ? `\n  ${note.body}` : ""}\n  → downstream reply ${p.id} "…"`;
    case "note.status":
      return `The user marked [${p.noteId}] "${p.title}" as ${p.status}${p.reason ? `: "${p.reason}"` : ""}`;
    case "review.verdict":
      return `The user's verdict: ${p.value}${p.body ? ` ("${p.body}")` : ""}`;
    case "review.done":
      return "The user ended the review session.";
    case "note.updated":
      return `The user edited #${p.number} "${p.title}" (${(p.fields as string[]).join(", ")}). Run downstream draft to see what would be sent.`;
    case "post.drafted":
      return `The user drafted a comment for #${p.number} [${p.postId}]. It's in the outbox; the user posts it.`;
    case "post.updated":
      return `The user reworded the comment for #${p.number} [${p.postId}]. Leave their wording alone unless asked.`;
    case "post.discarded":
      return `The user threw away the comment for #${p.number} [${p.postId}].`;
    case "post.sent":
      return `The user posted the comment for #${p.number}: ${p.url}`;
    case "review.published":
      return `The user sent the review to the pull request (${p.event}, ${p.comments} inline comments): ${p.url}`;
    case "symbol.annotated":
      return `The user changed ${p.id}${p.entry !== null ? ` (entry=${p.entry})` : ""}`;
    default:
      return `${e.type} ${JSON.stringify(p)}`;
  }
}

const HELP = `downstream: a review surface you and the user share.

Start
  home                     open the home page: every PR that needs you, one next action each (also: no command)
  open [--base <ref>] [--head <ref>] [--pr <n>] [--title <t>]   review a change (default: working tree vs main)
  open --teach <path...>                                        explain existing code instead of a diff
  url | status | stop

Read
  show [--json]            the map: entry points, symbols, flow edges, steps, threads
  code <symbol>            a symbol's code with line numbers and +/- marks
  screen                   what the user is looking at and has selected
  sql "<select …>"         read-only SQL (views: v_symbols, v_edges, v_notes, v_replies)
  actions                  every action with its input schema

Write (the browser uses the same actions)
  apply <file.json | ->    author the walkthrough in one batch (see SKILL.md for the shape)
  note <kind> [symbol] --title "…" [--body "…"] [--severity blocker|concern|nit] [--lines a-b]
                           kind: why | decision | finding | question | comment
  reply <thread> "…"       resolve <thread> ["why"]   dismiss <thread> ["why"]   reopen <thread>
  ask "…" [--symbol s] [--lines a-b]
  go <symbol> [--lines a-b] | go step <n> | go thread <id> | go map | go overview
  verdict approve|changes|comment ["…"]
  outgoing <thread> "…" [--exclude]   put a thread in the review in these words, or keep it private
  post <pr> "…" [--repo o/n] [--thread n]   draft a comment for ANOTHER pull request; the user posts it from the outbox
  draft                    the review exactly as it would be sent
  send [--event comment] [--force]   send it to the PR, only when the user has said to (--force: even though the PR changed since you opened it)
  reanalyze                re-read the code after edits
  do <action> '<json>'     call any action directly

Converse
  wait [--timeout 600]     block until the user replies, asks, resolves or ends the session`;

async function main() {
  switch (cmd) {
    case "open": {
      await ensureServer();
      const teach = opts.teach !== undefined;
      const paths = teach ? [...(typeof opts.teach === "string" ? [opts.teach] : []), ...pos] : [];
      const res = await call<{ review: { title: string }; files: number; symbols: number; edges: number }>("review.open", {
        mode: teach ? "teach" : "diff",
        base: str("base"),
        head: str("head"),
        pr: str("pr") ? Number(str("pr")) : undefined,
        paths,
        title: str("title"),
      });
      writeFileSync(cursorFile(), "0");
      const state = await get<ReviewState>("/api/state");
      writeFileSync(cursorFile(), String(state.cursor));
      const page = await base();
      console.log(`Opened "${res.review.title}": ${res.files} files, ${res.symbols} symbols, ${res.edges} edges.`);
      console.log(`UI: ${page}`);
      console.log(`Next: \`downstream show\`, read the code, then \`downstream apply plan.json\`. See SKILL.md.`);
      // Started from the home page, the user's browser is already on its way to this review.
      if (!process.env.DOWNSTREAM_HOSTED) openBrowser(page);
      return;
    }
    case "home": {
      const url = await ensureServer();
      console.log(`Home: ${url}`);
      openBrowser(url);
      return;
    }
    case "url":
    {
      const url = await serverUrl();
      if (!url) return console.log("not running");
      console.log(insideRepo() ? await base() : url);
      return;
    }
    case "status": {
      const url = await serverUrl();
      if (!url) return console.log("not running");
      const state = await get<ReviewState>("/api/state");
      console.log(`${await base()}  ·  ${state.review.title}  ·  ${state.notes.filter((n) => n.status === "open").length} open threads  ·  agent ${state.presence.agent}`);
      return;
    }
    case "stop": {
      if (!existsSync(serverFile)) return console.log("not running");
      const { pid } = JSON.parse(readFileSync(serverFile, "utf8")) as { pid: number };
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
      console.log("stopped");
      return;
    }
    case "show": {
      const state = await get<ReviewState>("/api/state");
      console.log(opts.json ? JSON.stringify(state, null, 2) : outline(state));
      return;
    }
    case "code": {
      const state = await get<ReviewState>("/api/state");
      const q = pos[0] ?? fail("which symbol?");
      const s = state.symbols.find((x) => x.id === q) ?? state.symbols.find((x) => x.id.endsWith(`#${q}`) || x.name === q) ?? fail(`no symbol ${q}`);
      const frame = await get<{ patch: string }>(`/api/frame?symbol=${encodeURIComponent(s.id)}`);
      console.log(`${s.id}  [${s.status}]  ${s.file}${s.range ? `:${s.range.start}-${s.range.end}` : ""}`);
      if (s.signature) console.log(s.signature);
      const into = state.edges.filter((e: Edge) => e.to === s.id).map((e) => `${e.from}${e.change === "added" ? " *" : ""}`);
      const out = state.edges.filter((e: Edge) => e.from === s.id).map((e) => `${e.to}${e.change === "added" ? " *" : e.change === "removed" ? " x" : ""}`);
      if (into.length) console.log(`called by: ${into.join(", ")}`);
      if (out.length) console.log(`calls: ${out.join(", ")}`);
      console.log("");
      printFrame(frame.patch);
      return;
    }
    case "screen":
      console.log(JSON.stringify(await call("screen"), null, 2));
      return;
    case "sql": {
      const { readOnly } = await import("../server/store.ts");
      const db = readOnly(path.join(dir(), "review.db"));
      const rows = db.prepare(pos.join(" ")).all();
      console.log(rows.length ? JSON.stringify(rows, null, 2) : "(no rows)");
      return;
    }
    case "actions": {
      const list = await get<{ name: string; description: string; input: unknown }[]>("/api/actions");
      for (const a of list) console.log(`${a.name}\n  ${a.description}\n  input: ${JSON.stringify(a.input)}\n`);
      return;
    }
    case "apply": {
      const src = pos[0] ?? "-";
      const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(path.resolve(src), "utf8");
      const res = await call<{ applied: string[] }>("apply", JSON.parse(text));
      console.log(`applied: ${res.applied.join(", ") || "nothing"}`);
      return;
    }
    case "note": {
      const kind = pos[0] ?? fail("note <why|decision|finding|question|comment> [symbol] --title …");
      const note = await call<Note>("note.add", {
        kind,
        symbolId: pos[1] ?? str("symbol") ?? null,
        title: str("title") ?? fail("--title is required"),
        body: str("body") ?? "",
        severity: str("severity") ?? null,
        category: str("category") ?? null,
        fix: str("fix") ?? "",
        impact: str("impact") ?? "",
        lines: range(str("lines")),
        side: str("side") ?? "new",
      });
      console.log(`#${note.number} [${note.id}] ${note.kind}: ${note.title}`);
      return;
    }
    case "reply": {
      const [noteId, ...rest] = pos;
      await call("note.reply", { noteId, body: rest.join(" ") || str("body") || fail("reply <thread> \"text\"") });
      console.log("replied");
      return;
    }
    case "resolve":
    case "dismiss":
    case "reopen": {
      const [noteId, ...rest] = pos;
      const status = cmd === "resolve" ? "resolved" : cmd === "dismiss" ? "dismissed" : "open";
      await call("note.status", { noteId, status, reason: rest.join(" ") || undefined });
      console.log(status);
      return;
    }
    case "ask": {
      const note = await call<Note>("ask", { body: pos.join(" "), symbolId: str("symbol") ?? null, lines: range(str("lines")) });
      console.log(`[${note.id}] asked. \`downstream wait\` to hear back.`);
      return;
    }
    case "go": {
      const [what, arg] = pos;
      let input: Record<string, unknown>;
      if (what === "map" || what === "overview" || what === "trail") input = { view: what };
      else if (what === "step") {
        const state = await get<ReviewState>("/api/state");
        const step = state.steps.find((s) => s.order === Number(arg) || s.id === arg) ?? fail(`no step ${arg}`);
        input = { stepId: step.id };
      } else if (what === "thread" || what === "note") input = { noteId: arg };
      else input = { symbolId: what ?? fail("go <symbol>"), lines: range(str("lines")) };
      await call("navigate", input);
      console.log("moved the user's view");
      return;
    }
    case "outgoing": {
      // downstream outgoing <thread> "comment for the PR author"   |   --exclude keeps it private
      const [noteId, ...rest] = pos;
      const include = !opts.exclude;
      const body = rest.join(" ") || str("body") || "";
      await call("note.update", { noteId, outgoing: { include, body } });
      console.log(include ? `${noteId} goes to the PR${body ? " in your wording" : ""}` : `${noteId} stays private`);
      return;
    }
    case "post": {
      // downstream post 45119 "comment for that PR" [--repo owner/name] [--thread 2]
      const [number, ...rest] = pos;
      const body = rest.join(" ") || str("body") || "";
      const post = await call<{ id: string; repo: string; number: number }>("post.draft", { number: Number(number), body, ...(str("repo") ? { repo: str("repo") } : {}), ...(str("thread") ? { noteId: str("thread") } : {}) });
      console.log(`drafted [${post.id}] for ${post.repo}#${post.number}: it's in the user's outbox, not posted`);
      return;
    }
    case "draft": {
      const d = await call<{ event: string; markdown: string; target: { pr: number; repo: string | null } | null; comments: { inline: boolean }[] }>("review.draft", {});
      const target = d.target ? `${d.target.repo ?? "?"} #${d.target.pr}` : "none: not a PR review, copy the markdown";
      console.log(`Event: ${d.event}   Target: ${target}   Inline comments: ${d.comments.filter((c) => c.inline).length}\n`);
      console.log(d.markdown);
      return;
    }
    case "send": {
      const raw = str("event")?.toLowerCase();
      const event = raw === "approve" ? "APPROVE" : raw === "changes" || raw === "request_changes" ? "REQUEST_CHANGES" : raw === "comment" ? "COMMENT" : undefined;
      const res = await call<{ url: string; comments: number }>("review.publish", { ...(event ? { event } : {}), ...(opts.force ? { force: true } : {}) });
      console.log(`Sent: ${res.url} (${res.comments} inline comments)`);
      return;
    }
    case "verdict": {
      const [value, ...rest] = pos;
      await call("review.verdict", { value, body: rest.join(" ") });
      console.log(`verdict: ${value}`);
      return;
    }
    case "reanalyze": {
      const res = await call<{ symbols: number; edges: number }>("review.reanalyze");
      console.log(`re-read: ${res.symbols} symbols, ${res.edges} edges`);
      return;
    }
    case "do": {
      const [name, json] = pos;
      console.log(JSON.stringify(await call(name ?? fail("do <action> '<json>'"), json ? JSON.parse(json) : {}), null, 2));
      return;
    }
    case "wait": {
      const after = existsSync(cursorFile()) ? Number(readFileSync(cursorFile(), "utf8")) || 0 : 0;
      const timeout = Number(str("timeout") ?? 600);
      // Node's fetch gives up on a response whose headers take longer than 300s, so a
      // long wait is a series of shorter ones from the same cursor.
      const deadline = Date.now() + timeout * 1000;
      let res: { events: ReviewEvent[]; cursor: number; timedOut: boolean };
      do {
        const chunk = Math.max(1, Math.min(WAIT_CHUNK_SECONDS, Math.ceil((deadline - Date.now()) / 1000)));
        res = await get(`/api/wait?after=${after}&timeout=${chunk}`);
      } while (res.timedOut && Date.now() < deadline);
      writeFileSync(cursorFile(), String(res.cursor));
      if (res.timedOut) return console.log(`(no activity in ${timeout}s; the user may be reading. Run \`downstream wait\` again.)`);
      const state = await get<ReviewState>("/api/state");
      for (const e of res.events) console.log(describe(e, state) + "\n");
      const screen = await call<{ selection: { file: string; lines: { start: number; end: number }; code: string | null } | null }>("screen");
      if (screen.selection?.code && res.events.some((e) => e.type === "ask")) {
        console.log(`User's selection, ${screen.selection.file}:${screen.selection.lines.start}-${screen.selection.lines.end}:\n${screen.selection.code}\n`);
      }
      if (!res.events.some((e) => e.type === "review.done")) console.log("When you've responded, run `downstream wait` again.");
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      fail(`unknown command "${cmd}".\n\n${HELP}`);
  }
}

await main();
