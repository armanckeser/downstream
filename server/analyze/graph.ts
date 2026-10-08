// Turns a diff into a flow graph: the changed symbols, what they call, who
// calls them, and which of those relationships are new. The agent edits the
// result; this only has to be a good first draft.
import ts from "typescript";
import path from "node:path";
import type { CodeSymbol, Edge, EdgeKind, FileChange, Range } from "../../domain/model.ts";
import { countInRange, inRanges, type FileSource, type Hunks } from "./git.ts";
import { calleeNames, enclosing, extractDecls, isTsLike, parse, type Decl } from "./ts-decls.ts";
import { TsProjects, type TsProject } from "./ts-project.ts";
import { isPy, PyIndex } from "./py.ts";
import { pyEdges, pySymbols, type PyChanged } from "./py-graph.ts";

export type GraphInput = {
  root: string;
  mode: "diff" | "teach";
  files: FileChange[];
  hunks: Map<string, Hunks>;
  oldSrc: FileSource | null;
  newSrc: FileSource;
  /** Reuse an existing project set (the workspace keeps it for hover). */
  projects?: TsProjects;
  pyIndex?: PyIndex;
};

export type Graph = { symbols: CodeSymbol[]; edges: Edge[] };

const MAX_CALLERS = 12;
const symbolId = (file: string, key: string) => `${file}#${key}`;

type DeclLike = Pick<Decl, "key" | "name" | "container" | "kind" | "range" | "signature" | "exported">;

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)conftest\.py$/;
export const isTestFile = (file: string) => TEST_FILE.test(file);

function toSymbol(file: string, d: DeclLike, status: CodeSymbol["status"], changedLines = 0): CodeSymbol {
  return {
    test: isTestFile(file),
    id: symbolId(file, d.key),
    name: d.name,
    container: d.container,
    kind: d.kind,
    file,
    range: status === "removed" ? null : d.range,
    oldFile: null,
    oldRange: null,
    status,
    signature: d.signature,
    exported: d.exported,
    entry: false,
    summary: null,
    changedLines,
  };
}

/** Lines changed in a declaration that do not belong to one of its members. */
function ownChanges(d: Decl, ranges: Range[]): number {
  let n = 0;
  for (let line = d.range.start; line <= d.range.end; line++) {
    if (inRanges(line, ranges) && !inRanges(line, d.memberRanges)) n++;
  }
  return n;
}

export function buildGraph(input: GraphInput): Graph {
  const lap = timer();
  const symbols = new Map<string, CodeSymbol>();
  const edges = new Map<string, Edge>();
  const projects = input.projects ?? new TsProjects(input.root, input.newSrc, input.files.filter((f) => f.status !== "deleted").map((f) => f.path));

  const addEdge = (from: string, to: string, kind: EdgeKind, line: number | null, change: Edge["change"]) => {
    if (from === to) return;
    const id = `${from}->${to}:${kind}`;
    const prev = edges.get(id);
    if (prev) {
      if (change === "added" && prev.change === "same") prev.change = "added";
      return;
    }
    edges.set(id, { id, from, to, kind, change, line, label: null });
  };

  // 1. Symbols per file.
  const changedDecls: { file: string; decl: Decl; symbol: CodeSymbol }[] = [];
  const pyChanged: PyChanged[] = [];
  for (const f of input.files) {
    const hunks = input.hunks.get(f.path) ?? { added: [], deleted: [] };
    if (isPy(f.path)) {
      pyChanged.push(...pySymbols(input, f, hunks, toSymbol, symbols));
      continue;
    }
    if (!isTsLike(f.path)) {
      symbols.set(...moduleSymbol(f, hunks, input));
      continue;
    }
    const newText = f.status === "deleted" ? null : input.newSrc.read(f.path);
    const oldText = f.oldPath && input.oldSrc ? input.oldSrc.read(f.oldPath) : null;
    const newDecls = newText !== null ? extractDecls(parse(f.path, newText)) : [];
    const oldDecls = oldText !== null ? extractDecls(parse(f.oldPath!, oldText)) : [];
    const oldByKey = new Map(oldDecls.map((d) => [d.key, d]));
    const newKeys = new Set(newDecls.map((d) => d.key));

    for (const d of newDecls) {
      const od = oldByKey.get(d.key);
      if (input.mode === "teach") {
        if (d.kind === "const" && !d.exported) continue;
        const s = toSymbol(f.path, d, "context");
        symbols.set(s.id, s);
        changedDecls.push({ file: f.path, decl: d, symbol: s });
        continue;
      }
      const hasMembers = d.memberRanges.length > 0;
      const added = hasMembers ? ownChanges(d, hunks.added) : countInRange(d.range, hunks.added);
      const deleted = od ? (hasMembers ? ownChanges(od, hunks.deleted) : countInRange(od.range, hunks.deleted)) : 0;
      const status = !od && (added > 0 || f.status === "added") ? "added" : added + deleted > 0 ? "modified" : null;
      if (!status) continue;
      const s = toSymbol(f.path, d, status, added + deleted);
      if (od) {
        s.oldFile = f.oldPath;
        s.oldRange = od.range;
      }
      symbols.set(s.id, s);
      changedDecls.push({ file: f.path, decl: d, symbol: s });
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
  }

  lap("symbols");
  // 2. Outgoing edges through the checker; context symbols for what changed code calls.
  const ensureContext = (project: TsProject, rel: string, decl: Decl): string => {
    const id = symbolId(rel, decl.key);
    if (!symbols.has(id)) symbols.set(id, toSymbol(rel, decl, "context"));
    return id;
  };

  const resolve = (project: TsProject, node: ts.Node): { rel: string; decl: Decl } | null => {
    const checker = project.program().getTypeChecker();
    let sym = checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    let target = sym?.valueDeclaration ?? sym?.declarations?.[0];
    // Services return `{ createGrant, patchGrant }`; follow the shorthand to the function itself.
    if (target && ts.isShorthandPropertyAssignment(target)) {
      target = checker.getShorthandAssignmentValueSymbol(target)?.valueDeclaration ?? target;
    } else if (target && ts.isPropertyAssignment(target) && ts.isIdentifier(target.initializer)) {
      target = checker.getSymbolAtLocation(target.initializer)?.valueDeclaration ?? target;
    }
    if (!target) return null;
    const sf = target.getSourceFile();
    const rel = project.rel(sf.fileName);
    if (rel === null || project.program().isSourceFileDefaultLibrary(sf)) return null;
    const entry = project.declsFor(rel);
    if (!entry) return null;
    const decl = enclosing(entry.decls, entry.sf, target.getStart(entry.sf));
    return decl ? { rel, decl } : null;
  };

  for (const { file, decl, symbol } of changedDecls) {
    const project = projects.for(file);
    const entry = project?.declsFor(file);
    if (!project || !entry) continue;
    const live = entry.decls.find((d) => d.key === decl.key);
    if (!live) continue;
    const addedLines = input.hunks.get(file)?.added ?? [];
    const lineOf = (n: ts.Node) => entry.sf.getLineAndCharacterOfPosition(n.getStart(entry.sf)).line + 1;
    // An unchanged call into unchanged code is noise in a diff; hover still explains it.
    const relevant = (targetId: string, line: number, kind: EdgeKind) => {
      if (input.mode === "teach" || kind === "extends" || kind === "implements") return true;
      const known = symbols.get(targetId);
      if (known && known.status !== "context") return true;
      return inRanges(line, addedLines) || inRanges(line - 1, addedLines) || inRanges(line + 1, addedLines);
    };
    const visit = (n: ts.Node) => {
      // Members are their own symbols; don't attribute their calls to the class.
      if (n !== live.node && live.memberRanges.length && (ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isPropertyDeclaration(n))) return;
      let target: ts.Node | null = null;
      let kind: EdgeKind = "calls";
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        target = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
        for (const arg of n.arguments ?? []) {
          if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) {
            const hit = resolve(project, ts.isPropertyAccessExpression(arg) ? arg.name : arg);
            if (hit && relevant(symbolId(hit.rel, hit.decl.key), lineOf(arg), "calls") && hit.decl.kind !== "const" && hit.decl.kind !== "type" && hit.decl.kind !== "interface") {
              addEdge(symbol.id, ensureContext(project, hit.rel, hit.decl), "calls", lineOf(arg), input.mode === "diff" && inRanges(lineOf(arg), addedLines) ? "added" : "same");
            }
          }
        }
      } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        target = n.tagName;
        kind = "renders";
      } else if (ts.isTypeReferenceNode(n)) {
        target = n.typeName;
        kind = "uses";
      } else if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)) {
        target = n.expression;
        kind = n.parent.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      }
      if (target) {
        const hit = resolve(project, target);
        if (hit) {
          const targetId = symbolId(hit.rel, hit.decl.key);
          // Type uses only matter when the type is part of the change.
          const known = symbols.get(targetId);
          const interesting = kind !== "uses" || (known !== undefined && known.status !== "context");
          const line = lineOf(n);
          if (interesting && targetId !== symbol.id && relevant(targetId, line, kind)) {
            addEdge(symbol.id, ensureContext(project, hit.rel, hit.decl), kind, line, input.mode === "diff" && inRanges(line, addedLines) ? "added" : "same");
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(live.node, visit);
  }

  lap("outgoing");
  // 3. Callers: who reaches the changed code from outside it.
  if (input.mode === "diff") {
    for (const { file, decl, symbol } of changedDecls) {
      if (symbol.kind === "route" || symbol.kind === "class") continue;
      const project = projects.for(file);
      const entry = project?.declsFor(file);
      const live = entry?.decls.find((d) => d.key === decl.key);
      if (!project || !entry || !live?.nameNode) continue;
      // Where to ask for references: the declaration, plus (for a lifted service function) the
      // `return { patchGrant }` shorthand that callers actually reach through `store.patchGrant(...)`.
      const positions = [live.nameNode.getStart(entry.sf)];
      if (live.container) {
        const holder = entry.decls.find((d) => d.key === live.container);
        const visit = (n: ts.Node) => {
          if (ts.isShorthandPropertyAssignment(n) && n.name.text === live.name) positions.push(n.name.getStart(entry.sf));
          ts.forEachChild(n, visit);
        };
        if (holder) visit(holder.node);
      }
      const refs: ts.ReferencedSymbol[] = [];
      for (const at of positions) {
        try {
          refs.push(...(project.service.findReferences(project.abs(file), at) ?? []));
        } catch {
          /* a reference search that throws just finds nothing */
        }
      }
      let count = 0;
      for (const group of refs) {
        for (const ref of group.references) {
          if (ref.isDefinition || count >= MAX_CALLERS) continue;
          const rel = project.rel(ref.fileName);
          if (rel === null) continue;
          const callerEntry = project.declsFor(rel);
          if (!callerEntry) continue;
          const pos = ref.textSpan.start;
          const caller = enclosing(callerEntry.decls, callerEntry.sf, pos);
          if (!caller) continue;
          const callerId = symbolId(rel, caller.key);
          if (callerId === symbol.id) continue;
          const kind = refKind(callerEntry.sf, pos);
          if (!kind) continue;
          if (kind === "uses" && symbol.kind !== "interface" && symbol.kind !== "type") continue;
          const line = callerEntry.sf.getLineAndCharacterOfPosition(pos).line + 1;
          const callerAdded = input.hunks.get(rel)?.added ?? [];
          if (!symbols.has(callerId)) symbols.set(callerId, toSymbol(rel, caller, "context"));
          addEdge(callerId, symbol.id, kind, line, inRanges(line, callerAdded) ? "added" : "same");
          count++;
        }
      }
    }

    // 4. Calls that disappeared: compare call names across sides.
    for (const s of symbols.values()) {
      if ((s.status !== "modified" && s.status !== "removed") || !s.oldRange || !input.oldSrc || !isTsLike(s.file)) continue;
      const oldText = input.oldSrc.read(s.oldFile ?? s.file);
      if (!oldText) continue;
      const oldSf = parse(s.oldFile ?? s.file, oldText);
      const oldDecl = extractDecls(oldSf).find((d) => symbolId(s.file, d.key) === s.id);
      if (!oldDecl) continue;
      const before = calleeNames(oldSf, oldDecl.node);
      let after = new Map<string, number>();
      if (s.status === "modified" && s.range) {
        const newText = input.newSrc.read(s.file);
        const newSf = newText ? parse(s.file, newText) : null;
        const newDecl = newSf ? extractDecls(newSf).find((d) => symbolId(s.file, d.key) === s.id) : null;
        if (newSf && newDecl) after = calleeNames(newSf, newDecl.node);
      }
      for (const [name, line] of before) {
        if (after.has(name)) continue;
        const target = [...symbols.values()].find((t) => t.name === name && t.id !== s.id && (t.file === s.file || t.status !== "context"));
        if (target) addEdge(s.id, target.id, "calls", line, "removed");
      }
    }
  }

  lap("callers+removed");
  if (pyChanged.length) {
    const index = input.pyIndex ?? new PyIndex(input.newSrc.files(), (f) => input.newSrc.read(f));
    pyEdges(input, index, pyChanged, symbols, toSymbol, addEdge);
    lap("python");
  }
  // 5. Doors: changed symbols nothing else in the change calls.
  const all = [...symbols.values()];
  const changed = new Set(all.filter((s) => s.status !== "context").map((s) => s.id));
  for (const s of all) {
    if (s.test || s.status === "removed" || s.kind === "type" || s.kind === "interface" || s.kind === "module" || s.kind === "const") continue;
    const scope = input.mode === "teach" ? true : changed.has(s.id);
    if (!scope) continue;
    const incoming = [...edges.values()].filter(
      (e) => e.to === s.id && e.kind !== "uses" && e.change !== "removed" && !symbols.get(e.from)?.test && (input.mode === "teach" || changed.has(e.from)),
    );
    s.entry = incoming.length === 0 && s.name !== "constructor" && (input.mode === "diff" || s.exported || s.kind === "route");
  }

  return { symbols: all, edges: [...edges.values()] };
}

function refKind(sf: ts.SourceFile, pos: number): EdgeKind | null {
  let node = findToken(sf, pos);
  if (!node) return null;
  // Walk up through property access so obj.method() counts as a call of method.
  while (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) node = node.parent;
  const p = node.parent;
  if (!p) return null;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return null;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === node) return "calls";
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(node as ts.Expression)) return "calls";
  if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) return ts.isJsxClosingElement(p) ? null : "renders";
  if (ts.isTypeReferenceNode(p) || ts.isExpressionWithTypeArguments(p)) return "uses";
  if (ts.isTaggedTemplateExpression(p)) return "calls";
  return null;
}

function findToken(sf: ts.SourceFile, pos: number): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || pos >= n.getEnd()) return;
    found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Non-TS files get one symbol covering their changed region; the agent can split it. */
function moduleSymbol(f: FileChange, hunks: Hunks, input: GraphInput): [string, CodeSymbol] {
  const text = f.status === "deleted" ? null : input.newSrc.read(f.path);
  const total = text?.split("\n").length ?? 0;
  const span = (ranges: Range[], max: number): Range | null => {
    if (!ranges.length) return null;
    const start = Math.max(1, Math.min(...ranges.map((r) => r.start)) - 3);
    const end = Math.min(max || Infinity, Math.max(...ranges.map((r) => r.end)) + 3);
    return { start, end: Math.max(start, end) };
  };
  const status = f.status === "added" ? "added" : f.status === "deleted" ? "removed" : input.mode === "teach" ? "context" : "modified";
  const range = status === "removed" ? null : input.mode === "teach" ? { start: 1, end: Math.max(1, total) } : span(hunks.added, total) ?? { start: 1, end: Math.min(Math.max(total, 1), 40) };
  const id = symbolId(f.path, "module");
  return [
    id,
    {
      id,
      name: path.posix.basename(f.path),
      container: null,
      kind: "module",
      file: f.path,
      range,
      oldFile: f.oldPath,
      oldRange: span(hunks.deleted, Infinity),
      status,
      signature: null,
      exported: false,
      entry: false,
      summary: null,
      changedLines: f.additions + f.deletions,
      test: isTestFile(f.path),
    },
  ];
}

function timer() {
  let t = performance.now();
  return (label: string) => {
    if (process.env.DS_DEBUG) console.error(`[graph] ${label}: ${Math.round(performance.now() - t)}ms`);
    t = performance.now();
  };
}
