// The repositories one Downstream server serves. Each keeps its own review
// database in `<repo>/.downstream/`; the server finds a repo's clone from its
// GitHub name, and clones it when you have none.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Store } from "./store.ts";
import { Workspace } from "./workspace.ts";
import { ActionError } from "./actions.ts";
import { downstreamHome, type HomeStore } from "./home-store.ts";
import { ghAsync } from "./gh.ts";
import type { ReviewEvent } from "../domain/model.ts";

export class RepoContext {
  readonly store: Store;
  private workspaces = new Map<string, Workspace>();
  readonly id: string;
  readonly root: string;
  readonly nameWithOwner: string | null;

  constructor(id: string, root: string, nameWithOwner: string | null) {
    this.id = id;
    this.root = root;
    this.nameWithOwner = nameWithOwner;
    const dir = path.join(root, ".downstream");
    mkdirSync(dir, { recursive: true });
    excludeFromGit(root);
    this.store = new Store(path.join(dir, "review.db"));
  }

  workspace(reviewId: string): Workspace {
    let ws = this.workspaces.get(reviewId);
    if (!ws) {
      const review = this.store.review(reviewId);
      if (!review) throw new ActionError(`No review ${reviewId}`, 404);
      ws = new Workspace(this.store.reviewRoot(reviewId) || this.root, review);
      this.workspaces.set(reviewId, ws);
    }
    return ws;
  }

  dropWorkspace(reviewId: string) {
    this.workspaces.delete(reviewId);
  }
}

/** Short, readable and stable: `downstream-1a2b3c`. The URL of a repo's reviews. */
export function repoId(root: string): string {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  return `${slug}-${createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 6)}`;
}

/** `owner/name` from the origin remote, read from .git/config so a scan of many repos runs no git processes. */
export function originOf(root: string): string | null {
  const config = path.join(root, ".git", "config");
  if (!existsSync(config)) return null;
  const text = readFileSync(config, "utf8");
  const origin = text.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
  const m = origin?.[1]?.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

const SKIP = new Set(["node_modules", "Library", "Applications", "dist", "build", "vendor", "target"]);
const SCAN_DEPTH = 4;
const RESCAN_AFTER_MS = 5 * 60_000;

export class RepoRegistry {
  private loaded = new Map<string, RepoContext>();
  private scannedAt = 0;
  /** Every repo's review events, as ("event", repo, reviewId, event): the home page and agent sessions follow them. */
  readonly bus = new EventEmitter();

  private readonly home: HomeStore;

  constructor(home: HomeStore) {
    this.home = home;
    this.bus.setMaxListeners(100);
  }

  /** A repository the CLI is running in, or one the home page needs. Idempotent. */
  register(root: string): RepoContext {
    const abs = path.resolve(root);
    const id = repoId(abs);
    const existing = this.loaded.get(id);
    if (existing) return existing;
    const ctx = new RepoContext(id, abs, originOf(abs));
    this.home.putRepo({ id, root: abs, nameWithOwner: ctx.nameWithOwner });
    this.loaded.set(id, ctx);
    ctx.store.bus.on("event", (reviewId: string, e: ReviewEvent) => this.bus.emit("event", ctx, reviewId, e));
    return ctx;
  }

  get(id: string): RepoContext | null {
    const loaded = this.loaded.get(id);
    if (loaded) return loaded;
    const row = this.home.repos().find((r) => r.id === id);
    return row && existsSync(row.root) ? this.register(row.root) : null;
  }

  /** Every repository with reviews, for the home page. */
  withReviews(): RepoContext[] {
    return this.home
      .repos()
      .filter((r) => existsSync(path.join(r.root, ".downstream", "review.db")))
      .map((r) => this.register(r.root));
  }

  /** Where `owner/name` is cloned on this machine, looking in the usual places once in a while. */
  find(nameWithOwner: string): string | null {
    const known = this.home.rootFor(nameWithOwner);
    if (known && existsSync(known)) return known;
    if (Date.now() - this.scannedAt < RESCAN_AFTER_MS) return null;
    this.scannedAt = Date.now();
    for (const { dir, depth } of searchRoots()) scan(dir, depth, (root, origin) => this.home.putRepo({ id: repoId(root), root, nameWithOwner: origin }));
    const found = this.home.rootFor(nameWithOwner);
    return found && existsSync(found) ? found : null;
  }

  /** A partial clone (no file contents until needed) under Downstream's home, for repos you don't have. */
  async clone(nameWithOwner: string, account: string): Promise<string> {
    const dest = path.join(downstreamHome(), "repos", ...nameWithOwner.split("/"));
    if (!existsSync(path.join(dest, ".git"))) {
      mkdirSync(path.dirname(dest), { recursive: true });
      await ghAsync(["repo", "clone", nameWithOwner, dest, "--", "--filter=blob:none"], { account });
    }
    this.register(dest);
    return dest;
  }
}

/** Code folders are searched deep; the home directory itself only one level, for `~/myrepo`. */
function searchRoots(): { dir: string; depth: number }[] {
  const env = process.env.DOWNSTREAM_REPO_ROOTS;
  if (env) return env.split(path.delimiter).filter(Boolean).map((dir) => ({ dir, depth: SCAN_DEPTH }));
  const home = homedir();
  const deep = ["projects", "code", "src", "dev"].map((d) => ({ dir: path.join(home, d), depth: SCAN_DEPTH }));
  return [...deep, { dir: home, depth: 1 }].filter((r) => existsSync(r.dir));
}

function scan(dir: string, depth: number, found: (root: string, origin: string) => void) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === ".git" && e.isDirectory())) {
    const origin = originOf(dir);
    if (origin) found(dir, origin);
    return;
  }
  if (depth === 0) return;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
    scan(path.join(dir, e.name), depth - 1, found);
  }
}

function excludeFromGit(root: string) {
  const exclude = path.join(root, ".git", "info", "exclude");
  try {
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!text.split("\n").includes(".downstream/")) appendFileSync(exclude, `${text.endsWith("\n") || !text ? "" : "\n"}.downstream/\n`);
  } catch {
    /* worktrees keep info/ elsewhere; not worth failing over */
  }
}
