// The flow graph for Python files: same shape as the TypeScript one (statuses,
// new and removed calls, callers from anywhere in the repo), built from PyIndex.
import type { CodeSymbol, EdgeKind, FileChange, Range } from "../../domain/model.ts";
import { countInRange, inRanges, type Hunks } from "./git.ts";
import type { GraphInput } from "./graph.ts";
import { enclosingPy, parsePy, PyIndex, type PyDecl } from "./py.ts";

type AddEdge = (from: string, to: string, kind: EdgeKind, line: number | null, change: "added" | "removed" | "same") => void;
type ToSymbol = (file: string, d: PyDecl, status: CodeSymbol["status"], changedLines?: number) => CodeSymbol;

const MAX_CALLERS = 12;
const id = (file: string, key: string) => `${file}#${key}`;

function ownChanges(d: PyDecl, ranges: Range[]): number {
  let n = 0;
  for (let line = d.range.start; line <= d.range.end; line++) if (inRanges(line, ranges) && !inRanges(line, d.memberRanges)) n++;
  return n;
}

export type PyChanged = { file: string; decl: PyDecl; symbol: CodeSymbol };

/** Statuses for one Python file's declarations, both sides. */
export function pySymbols(input: GraphInput, f: FileChange, hunks: Hunks, toSymbol: ToSymbol, symbols: Map<string, CodeSymbol>): PyChanged[] {
  const newText = f.status === "deleted" ? null : input.newSrc.read(f.path);
  const oldText = f.oldPath && input.oldSrc ? input.oldSrc.read(f.oldPath) : null;
  const newDecls = newText !== null ? parsePy(f.path, newText).decls : [];
  const oldDecls = oldText !== null ? parsePy(f.oldPath!, oldText).decls : [];
  const oldByKey = new Map(oldDecls.map((d) => [d.key, d]));
  const newKeys = new Set(newDecls.map((d) => d.key));
  const changed: PyChanged[] = [];

  for (const d of newDecls) {
    if (input.mode === "teach") {
      if (!d.exported && d.kind === "function" && !d.container) continue;
      const s = toSymbol(f.path, d, "context");
      symbols.set(s.id, s);
      changed.push({ file: f.path, decl: d, symbol: s });
      continue;
    }
    const od = oldByKey.get(d.key);
    const own = d.memberRanges.length > 0;
    const added = own ? ownChanges(d, hunks.added) : countInRange(d.range, hunks.added);
    const deleted = od ? (od.memberRanges.length ? ownChanges(od, hunks.deleted) : countInRange(od.range, hunks.deleted)) : 0;
    const status = !od && (added > 0 || f.status === "added") ? "added" : added + deleted > 0 ? "modified" : null;
    if (!status) continue;
    const s = toSymbol(f.path, d, status, added + deleted);
    if (od) {
      s.oldFile = f.oldPath;
      s.oldRange = od.range;
    }
    symbols.set(s.id, s);
    changed.push({ file: f.path, decl: d, symbol: s });
  }
  if (input.mode === "diff") {
    for (const od of oldDecls) {
      if (newKeys.has(od.key)) continue;
      const s = toSymbol(f.path, od, "removed", od.range.end - od.range.start + 1);
      s.oldFile = f.oldPath;
      s.oldRange = od.range;
      symbols.set(s.id, s);
    }
  }
  return changed;
}

/** Outgoing calls, callers, and calls that disappeared, for the changed Python symbols. */
export function pyEdges(input: GraphInput, index: PyIndex, changed: PyChanged[], symbols: Map<string, CodeSymbol>, toSymbol: ToSymbol, addEdge: AddEdge) {
  const ensure = (file: string, d: PyDecl) => {
    const sid = id(file, d.key);
    if (!symbols.has(sid)) symbols.set(sid, toSymbol(file, d, "context"));
    return sid;
  };

  // What changed code calls.
  for (const { file, decl, symbol } of changed) {
    const pf = index.get(file);
    if (!pf) continue;
    const added = input.hunks.get(file)?.added ?? [];
    for (const c of pf.calls) {
      if (c.line < decl.range.start || c.line > decl.range.end || inRanges(c.line, decl.memberRanges)) continue;
      const hit = index.resolve(file, c.chain, c.line);
      if (!hit) continue;
      const targetId = id(hit.file, hit.decl.key);
      if (targetId === symbol.id) continue;
      const known = symbols.get(targetId);
      const near = inRanges(c.line, added) || inRanges(c.line - 1, added) || inRanges(c.line + 1, added);
      if (input.mode === "diff" && !(known && known.status !== "context") && !near) continue;
      addEdge(symbol.id, ensure(hit.file, hit.decl), "calls", c.line, input.mode === "diff" && inRanges(c.line, added) ? "added" : "same");
    }
  }
  if (input.mode !== "diff") return;

  // Who calls the changed code, from anywhere in the repo.
  for (const { file, decl, symbol } of changed) {
    if (symbol.kind === "class") continue;
    const callName = decl.name === "__init__" && decl.container ? decl.container.split(".").at(-1)! : decl.name;
    let count = 0;
    for (const other of index.all()) {
      if (count >= MAX_CALLERS) break;
      const text = input.newSrc.read(other);
      if (!text || !text.includes(callName)) continue;
      const pf = index.get(other);
      if (!pf) continue;
      for (const c of pf.calls) {
        if (c.chain.split(".").at(-1) !== callName) continue;
        const hit = index.resolve(other, c.chain, c.line);
        if (!hit || id(hit.file, hit.decl.key) !== symbol.id) continue;
        const caller = enclosingPy(pf.decls, c.line);
        if (!caller) continue;
        const callerId = id(other, caller.key);
        if (callerId === symbol.id) continue;
        const added = input.hunks.get(other)?.added ?? [];
        addEdge(ensure(other, caller), symbol.id, "calls", c.line, inRanges(c.line, added) ? "added" : "same");
        if (++count >= MAX_CALLERS) break;
      }
    }
  }

  // Calls that disappeared.
  for (const s of symbols.values()) {
    if ((s.status !== "modified" && s.status !== "removed") || !s.oldRange || !input.oldSrc || !(s.file.endsWith(".py") || s.file.endsWith(".pyi"))) continue;
    const oldText = input.oldSrc.read(s.oldFile ?? s.file);
    if (!oldText) continue;
    const before = PyIndex.calleeNames(parsePy(s.file, oldText), s.oldRange);
    const pf = s.range ? index.get(s.file) : null;
    const after = pf && s.range ? PyIndex.calleeNames(pf, s.range) : new Map<string, number>();
    for (const [name, line] of before) {
      if (after.has(name)) continue;
      const target = [...symbols.values()].find((t) => t.name === name && t.id !== s.id && (t.file === s.file || t.status !== "context"));
      if (target) addEdge(s.id, target.id, "calls", line, "removed");
    }
  }
}
