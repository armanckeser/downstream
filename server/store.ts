// SQLite is the source of truth for a review. The browser and the agent both
// write through actions (server/actions.ts); the agent may read with plain SQL
// through a read-only connection (`downstream sql`), which cannot write.
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import type {
  Author,
  CodeSymbol,
  Edge,
  FileChange,
  Note,
  Presence,
  Reply,
  Review,
  ReviewEvent,
  ReviewState,
  Step,
} from "../domain/model.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, data TEXT NOT NULL, root TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (review_id TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (review_id, path));
CREATE TABLE IF NOT EXISTS symbols (review_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (review_id, id));
CREATE TABLE IF NOT EXISTS edges (review_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (review_id, id));
CREATE TABLE IF NOT EXISTS steps (review_id TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (review_id, id));
CREATE TABLE IF NOT EXISTS notes (review_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (review_id, id));
CREATE TABLE IF NOT EXISTS replies (review_id TEXT NOT NULL, id TEXT NOT NULL, note_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (review_id, id));
CREATE TABLE IF NOT EXISTS app_state (review_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (review_id, key));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL);

-- Flat views for ad-hoc agent queries: downstream sql "select * from v_notes where status = 'open'"
CREATE VIEW IF NOT EXISTS v_symbols AS SELECT review_id, id, json_extract(data,'$.name') AS name, json_extract(data,'$.kind') AS kind,
  json_extract(data,'$.file') AS file, json_extract(data,'$.status') AS status, json_extract(data,'$.entry') AS entry,
  json_extract(data,'$.range.start') AS start_line, json_extract(data,'$.range.end') AS end_line, json_extract(data,'$.summary') AS summary FROM symbols;
CREATE VIEW IF NOT EXISTS v_edges AS SELECT review_id, id, json_extract(data,'$.from') AS from_id, json_extract(data,'$.to') AS to_id,
  json_extract(data,'$.kind') AS kind, json_extract(data,'$.change') AS change, json_extract(data,'$.line') AS line FROM edges;
CREATE VIEW IF NOT EXISTS v_notes AS SELECT review_id, id, json_extract(data,'$.kind') AS kind, json_extract(data,'$.severity') AS severity,
  json_extract(data,'$.status') AS status, json_extract(data,'$.author') AS author, json_extract(data,'$.title') AS title,
  json_extract(data,'$.symbolId') AS symbol_id, json_extract(data,'$.body') AS body, created_at FROM notes;
CREATE VIEW IF NOT EXISTS v_replies AS SELECT review_id, id, note_id, json_extract(data,'$.author') AS author, json_extract(data,'$.body') AS body, created_at FROM replies;
`;

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

export class Store {
  readonly db: DatabaseSync;
  readonly bus = new EventEmitter();
  private waiters = 0;
  private lastAgentActivity: string | null = null;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.bus.setMaxListeners(100);
  }

  // -- reviews --------------------------------------------------------------

  currentReviewId(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'current'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setCurrent(id: string) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('current', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
  }

  listReviews(): Review[] {
    return (this.db.prepare("SELECT data FROM reviews ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  review(id: string): Review | null {
    const row = this.db.prepare("SELECT data FROM reviews WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  reviewRoot(id: string): string | null {
    const row = this.db.prepare("SELECT root FROM reviews WHERE id = ?").get(id) as { root: string } | undefined;
    return row?.root ?? null;
  }

  saveReview(review: Review, root?: string) {
    const existing = this.reviewRoot(review.id);
    this.db
      .prepare("INSERT INTO reviews (id, data, root, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(review.id, JSON.stringify(review), root ?? existing ?? "", review.createdAt);
  }

  // -- analysis ---------------------------------------------------------------

  /**
   * Replace the analyzed part of a review, keeping what people wrote: symbol
   * summaries and entry flags survive a re-analysis, as do manual symbols/edges.
   */
  replaceAnalysis(reviewId: string, files: FileChange[], symbols: CodeSymbol[], edges: Edge[]) {
    const prior = new Map(this.symbols(reviewId).map((s) => [s.id, s]));
    this.tx(() => {
      this.db.prepare("DELETE FROM files WHERE review_id = ?").run(reviewId);
      this.db.prepare("DELETE FROM symbols WHERE review_id = ? AND manual = 0").run(reviewId);
      this.db.prepare("DELETE FROM edges WHERE review_id = ? AND manual = 0").run(reviewId);
      const insFile = this.db.prepare("INSERT INTO files (review_id, path, data) VALUES (?, ?, ?)");
      for (const f of files) insFile.run(reviewId, f.path, JSON.stringify(f));
      const insSym = this.db.prepare("INSERT OR IGNORE INTO symbols (review_id, id, data, manual) VALUES (?, ?, ?, 0)");
      for (const s of symbols) {
        const before = prior.get(s.id);
        if (before) {
          s.summary = before.summary ?? s.summary;
          if (before.entry !== s.entry && this.entryWasSetByHand(reviewId, s.id)) s.entry = before.entry;
        }
        insSym.run(reviewId, s.id, JSON.stringify(s));
      }
      const insEdge = this.db.prepare("INSERT OR IGNORE INTO edges (review_id, id, data, manual) VALUES (?, ?, ?, 0)");
      for (const e of edges) insEdge.run(reviewId, e.id, JSON.stringify(e));
    });
  }

  private entryWasSetByHand(reviewId: string, symbolId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM events WHERE review_id = ? AND type = 'symbol.annotated' AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.entry') IS NOT NULL LIMIT 1")
      .get(reviewId, symbolId);
    return !!row;
  }

  files(reviewId: string): FileChange[] {
    return (this.db.prepare("SELECT data FROM files WHERE review_id = ? ORDER BY path").all(reviewId) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  symbols(reviewId: string): CodeSymbol[] {
    return (this.db.prepare("SELECT data FROM symbols WHERE review_id = ?").all(reviewId) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  symbol(reviewId: string, id: string): CodeSymbol | null {
    const row = this.db.prepare("SELECT data FROM symbols WHERE review_id = ? AND id = ?").get(reviewId, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  putSymbol(reviewId: string, s: CodeSymbol, manual = false) {
    this.db
      .prepare(
        "INSERT INTO symbols (review_id, id, data, manual) VALUES (?, ?, ?, ?) ON CONFLICT(review_id, id) DO UPDATE SET data = excluded.data, manual = MAX(symbols.manual, excluded.manual)",
      )
      .run(reviewId, s.id, JSON.stringify(s), manual ? 1 : 0);
  }

  deleteSymbol(reviewId: string, id: string) {
    this.db.prepare("DELETE FROM symbols WHERE review_id = ? AND id = ?").run(reviewId, id);
    this.db.prepare("DELETE FROM edges WHERE review_id = ? AND (json_extract(data,'$.from') = ? OR json_extract(data,'$.to') = ?)").run(reviewId, id, id);
  }

  edges(reviewId: string): Edge[] {
    return (this.db.prepare("SELECT data FROM edges WHERE review_id = ?").all(reviewId) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  putEdge(reviewId: string, e: Edge, manual = false) {
    this.db
      .prepare("INSERT INTO edges (review_id, id, data, manual) VALUES (?, ?, ?, ?) ON CONFLICT(review_id, id) DO UPDATE SET data = excluded.data")
      .run(reviewId, e.id, JSON.stringify(e), manual ? 1 : 0);
  }

  deleteEdge(reviewId: string, id: string) {
    this.db.prepare("DELETE FROM edges WHERE review_id = ? AND id = ?").run(reviewId, id);
  }

  // -- walkthrough --------------------------------------------------------------

  steps(reviewId: string): Step[] {
    return (this.db.prepare("SELECT data FROM steps WHERE review_id = ? ORDER BY ord").all(reviewId) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  replaceSteps(reviewId: string, steps: Step[]) {
    this.tx(() => {
      this.db.prepare("DELETE FROM steps WHERE review_id = ?").run(reviewId);
      const ins = this.db.prepare("INSERT INTO steps (review_id, id, ord, data) VALUES (?, ?, ?, ?)");
      for (const s of steps) ins.run(reviewId, s.id, s.order, JSON.stringify(s));
    });
  }

  // -- threads --------------------------------------------------------------------

  notes(reviewId: string): Note[] {
    const notes = (this.db.prepare("SELECT data FROM notes WHERE review_id = ? ORDER BY created_at").all(reviewId) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Note,
    );
    const replies = (this.db.prepare("SELECT data FROM replies WHERE review_id = ? ORDER BY created_at").all(reviewId) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Reply,
    );
    const byNote = Map.groupBy(replies, (r) => r.noteId);
    return notes.map((n) => ({ ...n, replies: byNote.get(n.id) ?? [] }));
  }

  note(reviewId: string, id: string): Note | null {
    const row = this.db.prepare("SELECT data FROM notes WHERE review_id = ? AND id = ?").get(reviewId, id) as { data: string } | undefined;
    if (!row) return null;
    const note = JSON.parse(row.data) as Note;
    const replies = (this.db.prepare("SELECT data FROM replies WHERE review_id = ? AND note_id = ? ORDER BY created_at").all(reviewId, id) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Reply,
    );
    return { ...note, replies };
  }

  putNote(reviewId: string, note: Note) {
    const { replies: _replies, ...rest } = note;
    this.db
      .prepare("INSERT INTO notes (review_id, id, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(review_id, id) DO UPDATE SET data = excluded.data")
      .run(reviewId, note.id, JSON.stringify({ ...rest, replies: [] }), note.createdAt);
  }

  addReply(reviewId: string, reply: Reply) {
    this.db.prepare("INSERT INTO replies (review_id, id, note_id, data, created_at) VALUES (?, ?, ?, ?, ?)").run(reviewId, reply.id, reply.noteId, JSON.stringify(reply), reply.createdAt);
  }

  // -- application state -------------------------------------------------------------

  getAppState<T>(reviewId: string, key: string): T | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE review_id = ? AND key = ?").get(reviewId, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setAppState(reviewId: string, key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO app_state (review_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(review_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(reviewId, key, JSON.stringify(value), now());
  }

  // -- events --------------------------------------------------------------------------

  emit(reviewId: string, type: string, actor: Author | "system", payload: unknown = {}): ReviewEvent {
    const at = now();
    const res = this.db.prepare("INSERT INTO events (review_id, type, actor, payload, at) VALUES (?, ?, ?, ?, ?)").run(reviewId, type, actor, JSON.stringify(payload), at);
    const event: ReviewEvent = { id: Number(res.lastInsertRowid), type, actor, payload, at };
    if (actor === "agent") this.touchAgent();
    this.bus.emit("event", reviewId, event);
    return event;
  }

  events(reviewId: string, after: number, actor?: string): ReviewEvent[] {
    const rows = (
      actor
        ? this.db.prepare("SELECT * FROM events WHERE review_id = ? AND id > ? AND actor = ? ORDER BY id").all(reviewId, after, actor)
        : this.db.prepare("SELECT * FROM events WHERE review_id = ? AND id > ? ORDER BY id").all(reviewId, after)
    ) as { id: number; type: string; actor: Author; payload: string; at: string }[];
    return rows.map((r) => ({ id: r.id, type: r.type, actor: r.actor, payload: JSON.parse(r.payload), at: r.at }));
  }

  cursor(reviewId: string): number {
    const row = this.db.prepare("SELECT MAX(id) AS id FROM events WHERE review_id = ?").get(reviewId) as { id: number | null };
    return row.id ?? 0;
  }

  // -- presence ----------------------------------------------------------------------------

  touchAgent() {
    this.lastAgentActivity = now();
  }

  waiterJoined() {
    this.waiters++;
    this.touchAgent();
    this.bus.emit("presence");
  }

  waiterLeft() {
    this.waiters = Math.max(0, this.waiters - 1);
    this.touchAgent();
    this.bus.emit("presence");
  }

  presence(): Presence {
    const recent = this.lastAgentActivity && Date.now() - Date.parse(this.lastAgentActivity) < 90_000;
    return { agent: this.waiters > 0 ? "listening" : recent ? "working" : "away", lastAgentActivity: this.lastAgentActivity };
  }

  state(reviewId: string): ReviewState | null {
    const review = this.review(reviewId);
    if (!review) return null;
    return {
      review,
      files: this.files(reviewId),
      symbols: this.symbols(reviewId),
      edges: this.edges(reviewId),
      steps: this.steps(reviewId),
      notes: this.notes(reviewId),
      presence: this.presence(),
      cursor: this.cursor(reviewId),
    };
  }

  tx(fn: () => void) {
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

/** A connection that structurally cannot write. Backs `downstream sql`. */
export function readOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}
