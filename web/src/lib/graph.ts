import type { CodeSymbol, Edge, Note, ReviewState } from "@domain/model.ts";

export type Index = {
  byId: Map<string, CodeSymbol>;
  out: Map<string, Edge[]>;
  into: Map<string, Edge[]>;
  notesBySymbol: Map<string, Note[]>;
  entries: CodeSymbol[];
};

const flowKinds = new Set(["calls", "renders"]);

export function buildIndex(state: ReviewState): Index {
  const byId = new Map(state.symbols.map((s) => [s.id, s]));
  const out = new Map<string, Edge[]>();
  const into = new Map<string, Edge[]>();
  for (const e of state.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push(e);
  }
  for (const list of out.values()) list.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  const notesBySymbol = new Map<string, Note[]>();
  for (const n of state.notes) if (n.symbolId) (notesBySymbol.get(n.symbolId) ?? notesBySymbol.set(n.symbolId, []).get(n.symbolId)!).push(n);
  const entries = state.symbols.filter((s) => s.entry).sort(byPosition);
  return { byId, out, into, notesBySymbol, entries };
}

export const byPosition = (a: CodeSymbol, b: CodeSymbol) => a.file.localeCompare(b.file) || (a.range?.start ?? 0) - (b.range?.start ?? 0);

/** The shortest flow path from a door to this symbol, so a deep click still reads top-down from where it starts. */
export function pathFromEntry(index: Index, target: string): string[] {
  const seen = new Map<string, string | null>([[target, null]]);
  const queue = [target];
  let found: string | null = null;
  while (queue.length) {
    const id = queue.shift()!;
    const s = index.byId.get(id);
    if (s?.entry && id !== target) {
      found = id;
      break;
    }
    for (const e of index.into.get(id) ?? []) {
      if (!flowKinds.has(e.kind) || e.change === "removed" || seen.has(e.from)) continue;
      // Don't route through unchanged callers; they sit above the door, not on the path.
      if (index.byId.get(e.from)?.status === "context" && !index.byId.get(e.from)?.entry) continue;
      seen.set(e.from, id);
      queue.push(e.from);
    }
  }
  if (!found) return [target];
  const path: string[] = [];
  for (let cur: string | null = found; cur; cur = seen.get(cur) ?? null) path.push(cur);
  return path.slice(-6);
}

export function displayName(s: CodeSymbol): string {
  return s.container ? `${s.container}.${s.name}` : s.name;
}

export function openFindings(notes: Note[] | undefined): Note[] {
  return (notes ?? []).filter((n) => n.kind === "finding" && n.status === "open");
}

export const severityRank = { blocker: 0, concern: 1, nit: 2 } as const;
