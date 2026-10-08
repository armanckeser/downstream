// Syntax-only declaration extraction. No type checker needed, so it runs on
// both sides of a change (the old side has no program to check against).
import ts from "typescript";
import type { Range, SymbolKind } from "../../domain/model.ts";

export type Decl = {
  key: string;
  name: string;
  container: string | null;
  kind: SymbolKind;
  node: ts.Node;
  nameNode: ts.Node | null;
  range: Range;
  exported: boolean;
  signature: string;
  /** For classes and object literals: member ranges, so "own" changes can be told apart from member changes. */
  memberRanges: Range[];
};

const TS_EXT = /\.(m|c)?(t|j)sx?$/;
export const isTsLike = (file: string) => TS_EXT.test(file) && !file.endsWith(".d.ts");

export function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

const HTTP = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);

/** Where a declaration really starts: its JSDoc belongs to it, and reviewers read docs too. */
function docStart(sf: ts.SourceFile, node: ts.Node): number {
  const holder = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && node.parent.declarations.length === 1 ? node.parent.parent : node;
  const docs = (holder as { jsDoc?: ts.Node[] }).jsDoc;
  return docs?.length ? Math.min(docs[0]!.getStart(sf), node.getStart(sf)) : node.getStart(sf);
}

function lines(sf: ts.SourceFile, node: ts.Node): Range {
  const start = sf.getLineAndCharacterOfPosition(docStart(sf, node)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { start, end };
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function headText(sf: ts.SourceFile, from: ts.Node, body: ts.Node | undefined): string {
  const start = from.getStart(sf);
  const end = body ? body.getStart(sf) : from.getEnd();
  const text = squash(sf.text.slice(start, end)).replace(/\s*(=>|\{)?\s*$/, "");
  return text.length > 240 ? text.slice(0, 237) + "…" : text;
}

function clip(text: string, maxLines = 14): string {
  const ls = text.split("\n");
  return ls.length > maxLines ? ls.slice(0, maxLines).join("\n") + "\n  …" : text;
}

function blockText(sf: ts.SourceFile, node: ts.Node, maxLines = 14): string {
  const text = sf.text.slice(node.getStart(sf), node.getEnd());
  const ls = text.split("\n");
  return ls.length > maxLines ? ls.slice(0, maxLines).join("\n") + "\n  …" : text;
}

function isFunctionLike(init: ts.Expression | undefined): init is ts.ArrowFunction | ts.FunctionExpression {
  return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

/** `memo(() => …)`, `forwardRef(function X() …)`, `defineAction({ run() … })`. */
function wrapsFunction(init: ts.Expression | undefined): boolean {
  if (!init || !ts.isCallExpression(init)) return false;
  return init.arguments.some((a) => isFunctionLike(a) || ts.isObjectLiteralExpression(a) || wrapsFunction(a));
}

export function extractDecls(sf: ts.SourceFile): Decl[] {
  const out: Decl[] = [];
  const jsx = sf.fileName.endsWith("x");
  const fnKind = (name: string): SymbolKind => (jsx && /^[A-Z]/.test(name) ? "component" : "function");

  const pushMembers = (container: string, members: readonly ts.Node[], exported: boolean): Range[] => {
    const ranges: Range[] = [];
    for (const m of members) {
      let name: string | null = null;
      let body: ts.Node | undefined;
      if (ts.isConstructorDeclaration(m)) {
        name = "constructor";
        body = m.body;
      } else if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name) {
        name = m.name.getText(sf);
        body = m.body;
      } else if ((ts.isPropertyDeclaration(m) || ts.isPropertyAssignment(m)) && isFunctionLike(m.initializer)) {
        name = m.name.getText(sf);
        body = m.initializer.body;
      }
      if (!name) continue;
      const range = lines(sf, m);
      ranges.push(range);
      out.push({
        key: `${container}.${name}`,
        name,
        container,
        kind: "method",
        node: m,
        nameNode: (m as { name?: ts.Node }).name ?? m.getFirstToken(sf) ?? null,
        range,
        exported,
        signature: headText(sf, m, body),
        memberRanges: [],
      });
    }
    return ranges;
  };

  for (const st of sf.statements) {
    const exported = isExported(st);
    if (ts.isFunctionDeclaration(st)) {
      const name = st.name?.text ?? "default";
      out.push({
        key: name,
        name,
        container: null,
        kind: fnKind(name),
        node: st,
        nameNode: st.name ?? null,
        range: lines(sf, st),
        exported,
        signature: headText(sf, st, st.body),
        memberRanges: [],
      });
    } else if (ts.isClassDeclaration(st)) {
      const name = st.name?.text ?? "default";
      const decl: Decl = {
        key: name,
        name,
        container: null,
        kind: "class",
        node: st,
        nameNode: st.name ?? null,
        range: lines(sf, st),
        exported,
        signature: clip(sf.text.slice(st.getStart(sf), st.members.pos).replace(/\s*\{\s*$/, "")),
        memberRanges: [],
      };
      out.push(decl);
      decl.memberRanges = pushMembers(name, st.members, exported);
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      out.push({
        key: st.name.text,
        name: st.name.text,
        container: null,
        kind: ts.isInterfaceDeclaration(st) ? "interface" : "type",
        node: st,
        nameNode: st.name,
        range: lines(sf, st),
        exported,
        signature: blockText(sf, st),
        memberRanges: [],
      });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const name = d.name.text;
        const init = d.initializer;
        const kind: SymbolKind = isFunctionLike(init)
          ? fnKind(name)
          : init && ts.isClassExpression(init)
            ? "class"
            : wrapsFunction(init) && jsx && /^[A-Z]/.test(name)
              ? "component"
              : "const";
        const range = lines(sf, st.declarationList.declarations.length === 1 ? st : d);
        const decl: Decl = {
          key: name,
          name,
          container: null,
          kind,
          node: d,
          nameNode: d.name,
          range,
          exported,
          signature: isFunctionLike(init)
            ? `${exported ? "export " : ""}const ${headText(sf, d, init.body)}`
            : squash(blockText(sf, d, 1)).slice(0, 160),
          memberRanges: [],
        };
        out.push(decl);
        if (init && ts.isObjectLiteralExpression(init)) {
          decl.memberRanges = pushMembers(name, init.properties.filter((p) => ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)), exported);
        } else if (init && ts.isClassExpression(init)) {
          decl.memberRanges = pushMembers(name, init.members, exported);
        }
      }
    } else if (ts.isExportAssignment(st) && isFunctionLike(st.expression)) {
      out.push({
        key: "default",
        name: "default",
        container: null,
        kind: fnKind("Default"),
        node: st,
        nameNode: null,
        range: lines(sf, st),
        exported: true,
        signature: headText(sf, st, st.expression.body),
        memberRanges: [],
      });
    }
  }

  // Route registrations anywhere in the file: app.get("/x", handler).
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP.has(node.expression.name.text) &&
      node.arguments.length >= 2 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      node.arguments[0].text.startsWith("/")
    ) {
      const method = node.expression.name.text.toUpperCase();
      const route = node.arguments[0].text;
      const name = `${method} ${route}`;
      out.push({
        key: `route:${name}`,
        name,
        container: null,
        kind: "route",
        node,
        nameNode: node.expression.name,
        range: lines(sf, node),
        exported: true,
        signature: `${node.expression.expression.getText(sf)}.${node.expression.name.text}("${route}", …)`,
        memberRanges: [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Innermost declaration containing a position. Routes and methods win over their enclosing function. */
export function enclosing(decls: Decl[], sf: ts.SourceFile, pos: number): Decl | null {
  let best: Decl | null = null;
  for (const d of decls) {
    if (pos < d.node.getStart(sf) || pos > d.node.getEnd()) continue;
    if (!best || d.node.getEnd() - d.node.getStart(sf) < best.node.getEnd() - best.node.getStart(sf)) best = d;
  }
  return best;
}

/** Names called inside a node. Used to diff call sets across sides without a checker. */
export function calleeNames(sf: ts.SourceFile, node: ts.Node): Map<string, number> {
  const names = new Map<string, number>();
  const visit = (n: ts.Node) => {
    let target: ts.Node | undefined;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) target = n.expression;
    else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) target = n.tagName;
    if (target) {
      const name = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isIdentifier(target) ? target.text : null;
      if (name && !names.has(name)) names.set(name, sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return names;
}
