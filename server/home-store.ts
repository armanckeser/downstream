// What Downstream remembers across repositories: which repos it knows and where
// they're cloned, which account you're looking through, where you moved PRs in
// the matrix, and the agent sessions it started for you.
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Choices, Quadrant } from "../domain/inbox.ts";
import { now } from "./store.ts";

/** Everything global lives here; `DOWNSTREAM_HOME` moves it (tests, a second install). */
export function downstreamHome(): string {
  const dir = process.env.DOWNSTREAM_HOME ?? path.join(homedir(), ".downstream");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name_with_owner TEXT, seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS triage (account TEXT NOT NULL, item_key TEXT NOT NULL, quadrant TEXT NOT NULL CHECK (quadrant IN ('do', 'next', 'delegate', 'someday')), at TEXT NOT NULL, PRIMARY KEY (account, item_key));
CREATE TABLE IF NOT EXISTS launches (account TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL, root TEXT NOT NULL, session_id TEXT, at TEXT NOT NULL, PRIMARY KEY (repo, pr));
`;

export type RepoRow = { id: string; root: string; nameWithOwner: string | null };

/** An agent session Downstream started on a PR: where, as whom, and its Claude session id for resuming. */
export type Launch = { account: string; repo: string; pr: number; root: string; sessionId: string | null; at: string };

export class HomeStore {
  readonly db: DatabaseSync;
  /** "changed" whenever anything the home page shows may differ. */
  readonly bus = new EventEmitter();

  constructor(file = path.join(downstreamHome(), "home.db")) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.renameQuadrants();
    this.bus.setMaxListeners(100);
  }

  changed() {
    this.bus.emit("changed");
  }

  // -- repositories ---------------------------------------------------------

  repos(): RepoRow[] {
    return (this.db.prepare("SELECT id, root, name_with_owner FROM repos ORDER BY seen_at DESC").all() as { id: string; root: string; name_with_owner: string | null }[]).map(
      (r) => ({ id: r.id, root: r.root, nameWithOwner: r.name_with_owner }),
    );
  }

  putRepo(row: RepoRow) {
    this.db
      .prepare(
        "INSERT INTO repos (id, root, name_with_owner, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(root) DO UPDATE SET name_with_owner = COALESCE(excluded.name_with_owner, repos.name_with_owner), seen_at = excluded.seen_at",
      )
      .run(row.id, row.root, row.nameWithOwner, now());
  }

  rootFor(nameWithOwner: string): string | null {
    const row = this.db.prepare("SELECT root FROM repos WHERE lower(name_with_owner) = lower(?) ORDER BY seen_at DESC LIMIT 1").get(nameWithOwner) as { root: string } | undefined;
    return row?.root ?? null;
  }

  // -- the account you look through ------------------------------------------------

  account(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'account'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setAccount(login: string) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('account', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(login);
    this.changed();
  }

  // -- where you moved things in the matrix ------------------------------------------

  choices(account: string): Choices {
    const rows = this.db.prepare("SELECT item_key, quadrant, at FROM triage WHERE account = ?").all(account) as { item_key: string; quadrant: Quadrant; at: string }[];
    return Object.fromEntries(rows.map((r) => [r.item_key, { quadrant: r.quadrant, at: r.at }]));
  }

  /** Choices made before Schedule and Later became Next and Someday keep their meaning. */
  private renameQuadrants() {
    const old = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'choices'").get();
    if (!old) return;
    this.tx(() => {
      this.db.exec(`INSERT OR IGNORE INTO triage (account, item_key, quadrant, at)
        SELECT account, item_key, CASE quadrant WHEN 'schedule' THEN 'next' WHEN 'later' THEN 'someday' ELSE quadrant END, at FROM choices`);
      this.db.exec("DROP TABLE choices");
    });
  }

  /** `null` hands the item back to Downstream's read. */
  choose(account: string, key: string, quadrant: Quadrant | null) {
    if (quadrant === null) this.db.prepare("DELETE FROM triage WHERE account = ? AND item_key = ?").run(account, key);
    else this.db.prepare("INSERT INTO triage (account, item_key, quadrant, at) VALUES (?, ?, ?, ?) ON CONFLICT (account, item_key) DO UPDATE SET quadrant = excluded.quadrant, at = excluded.at").run(account, key, quadrant, now());
    this.changed();
  }

  // -- sessions Downstream started ----------------------------------------------------

  launch(repo: string, pr: number): Launch | null {
    const row = this.db.prepare("SELECT account, repo, pr, root, session_id, at FROM launches WHERE lower(repo) = lower(?) AND pr = ?").get(repo, pr) as
      | { account: string; repo: string; pr: number; root: string; session_id: string | null; at: string }
      | undefined;
    return row ? { account: row.account, repo: row.repo, pr: row.pr, root: row.root, sessionId: row.session_id, at: row.at } : null;
  }

  putLaunch(l: Omit<Launch, "at">) {
    this.db
      .prepare(
        "INSERT INTO launches (account, repo, pr, root, session_id, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repo, pr) DO UPDATE SET account = excluded.account, root = excluded.root, session_id = COALESCE(excluded.session_id, launches.session_id), at = excluded.at",
      )
      .run(l.account, l.repo, l.pr, l.root, l.sessionId, now());
  }

  /** The account a PR's session was started with, so its gh calls (and the review it sends) use the same one. */
  accountFor(root: string, pr: number): string | null {
    const row = this.db.prepare("SELECT account FROM launches WHERE root = ? AND pr = ?").get(root, pr) as { account: string } | undefined;
    return row?.account ?? null;
  }

  private tx(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
