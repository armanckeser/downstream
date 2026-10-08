// Python without a type checker: declarations from indentation, calls resolved
// through each file's imports. Good enough to draw the flow and answer
// "what is this?" on hover; the agent fills in what static reading can't see.
import path from "node:path";
import type { Range, SymbolKind } from "../../domain/model.ts";

export const isPy = (file: string) => file.endsWith(".py") || file.endsWith(".pyi");

export type PyDecl = {
  key: string;
  name: string;
  container: string | null;
  kind: SymbolKind;
  range: Range;
  /** The line holding `def`/`class`, after decorators. */
  defLine: number;
  signature: string;
  doc: string;
  exported: boolean;
  memberRanges: Range[];
};

export type PyCall = { chain: string; line: number; col: number };
export type PyImport = { module: string; name: string | null };

export type PyFile = {
  file: string;
  decls: PyDecl[];
  /** Local name → what it refers to. `import a.b as x` → x: {a.b, null}; `from a import f as g` → g: {a, f}. */
  imports: Map<string, PyImport>;
  calls: PyCall[];
  code: string[];
};

const ROUTE = /^\s*@\s*[\w.]+\.(get|post|put|patch|delete|head|options|route|api_route|websocket)\s*\(\s*(?:path\s*=\s*)?["']([^"']+)["']/;
const COMMAND = /^\s*@\s*[\w.]*\b(command|group|task|shared_task|receiver|on_event|listener|handler)\b/;
const NOT_CALLS = new Set([
  "if", "elif", "while", "for", "return", "yield", "not", "and", "or", "in", "is", "lambda", "with", "assert", "del", "await", "print", "len", "range",
  "str", "int", "float", "bool", "dict", "list", "set", "tuple", "frozenset", "bytes", "isinstance", "issubclass", "super", "getattr", "setattr", "hasattr",
  "type", "object", "enumerate", "zip", "map", "filter", "sorted", "reversed", "min", "max", "sum", "any", "all", "abs", "round", "open", "repr", "iter", "next",
  "id", "hash", "vars", "dir", "callable", "except", "raise", "def", "class", "import", "from", "as", "pass", "else", "try", "finally", "case", "match",
]);

/** Blank out strings and comments, keeping every character's position, so regexes see only code. */
export function stripPy(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") (out += " "), i++;
      continue;
    }
    if (c === '"' || c === "'") {
      // Prefixes like f"", rb'' were already emitted as identifiers; that's fine.
      const triple = text.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      out += quote.replace(/./g, " ");
      i += quote.length;
      while (i < text.length && !text.startsWith(quote, i)) {
        if (text[i] === "\\") (out += "  "), (i += 2);
        else if (!triple && text[i] === "\n") break;
        else (out += text[i] === "\n" ? "\n" : " "), i++;
      }
      if (text.startsWith(quote, i)) (out += quote.replace(/./g, " ")), (i += quote.length);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

export function parsePy(file: string, text: string): PyFile {
  const raw = text.split("\n");
  const code = stripPy(text).split("\n");
  const decls: PyDecl[] = [];

  type Open = PyDecl & { indent: number; isClass: boolean; kept: boolean };
  const stack: Open[] = [];
  for (let i = 0; i < code.length; i++) {
    const line = code[i]!;
    const m = line.match(/^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1) ?? null;

    // Header: until the colon that closes the signature.
    let depth = 0;
    let headerEnd = i;
    for (let j = i; j < code.length; j++) {
      for (const ch of code[j]!) depth += ch === "(" || ch === "[" ? 1 : ch === ")" || ch === "]" ? -1 : 0;
      headerEnd = j;
      if (depth <= 0 && /:\s*$/.test(code[j]!.trimEnd())) break;
    }
    // Body: every following line indented deeper (blank and comment lines don't end it).
    let end = headerEnd;
    for (let j = headerEnd + 1; j < code.length; j++) {
      if (!code[j]!.trim()) continue;
      if (indentOf(code[j]!) > indent) end = j;
      else break;
    }
    // Decorators sit directly above.
    let start = i;
    while (start > 0 && /^\s*@/.test(code[start - 1]!) && indentOf(code[start - 1]!) === indent) start--;

    const isClass = m[2] === "class";
    const name = m[3]!;
    const decorators = raw.slice(start, i).join("\n");
    const routeMatch = raw.slice(start, i).map((d) => d.match(ROUTE)).find(Boolean);
    const command = raw.slice(start, i).some((d) => COMMAND.test(d));
    const kind: SymbolKind = isClass ? "class" : routeMatch || command ? "route" : parent?.isClass ? "method" : "function";
    const signature = (decorators ? decorators + "\n" : "") + raw.slice(i, headerEnd + 1).join("\n").trimEnd();
    const decl: Open = {
      key: parent ? `${parent.key}.${name}` : name,
      name,
      container: parent ? parent.key : null,
      kind,
      range: { start: start + 1, end: end + 1 },
      defLine: i + 1,
      signature: routeMatch ? `${routeMatch[1]!.toUpperCase()} ${routeMatch[2]}\n${signature}` : signature,
      doc: docstring(raw, headerEnd + 1),
      exported: !name.startsWith("_"),
      memberRanges: [],
      indent,
      isClass,
      kept: false,
    };
    // Nested functions inside functions are part of their parent, unless the parent is a big container.
    // Helpers defined inside a test belong to that test.
    const keep = !parent || (parent.kept && (parent.isClass || (parent.range.end - parent.range.start >= 40 && !parent.name.startsWith("test"))));
    decl.kept = keep;
    if (keep) {
      if (parent) parent.memberRanges.push(decl.range);
      decls.push(decl);
    }
    stack.push(decl);
  }

  const imports = new Map<string, PyImport>();
  const joined = code.join("\n");
  for (const m of joined.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    for (const part of m[2]!.replace(/[()\\]/g, " ").split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name && name !== "*") imports.set((alias ?? name).trim(), { module: m[1]!, name: name.trim() });
    }
  }
  for (const m of joined.matchAll(/^[ \t]*import\s+([^\n]+)/gm)) {
    for (const part of m[1]!.split(",")) {
      const [mod, alias] = part.trim().split(/\s+as\s+/);
      if (!mod) continue;
      if (alias) imports.set(alias.trim(), { module: mod.trim(), name: null });
      else imports.set(mod.trim().split(".")[0]!, { module: mod.trim().split(".")[0]!, name: null });
    }
  }

  const calls: PyCall[] = [];
  code.forEach((line, idx) => {
    if (/^\s*(async\s+def|def|class)\s/.test(line)) return;
    for (const m of line.matchAll(/(?<![\w.])([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)) {
      const chain = m[1]!.replace(/\s+/g, "");
      if (NOT_CALLS.has(chain)) continue;
      calls.push({ chain, line: idx + 1, col: m.index! });
    }
    // Call on a fresh instance: GrantService().create(1) reads as GrantService.create.
    for (const m of line.matchAll(/(?<![\w.])([A-Za-z_][\w.]*)\s*\([^()]*\)\s*\.\s*([A-Za-z_]\w*)\s*\(/g)) {
      calls.push({ chain: `${m[1]}.${m[2]}`, line: idx + 1, col: m.index! + m[0].lastIndexOf(m[2]!) });
    }
  });
  return { file, decls, imports, calls, code };
}

function docstring(raw: string[], from: number): string {
  for (let j = from; j < raw.length && j < from + 3; j++) {
    const t = raw[j]!.trim();
    if (!t) continue;
    const q = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
    if (!q) return "";
    const rest = t.slice(3);
    if (rest.includes(q)) return rest.slice(0, rest.indexOf(q)).trim();
    const lines = [rest];
    for (let k = j + 1; k < raw.length && k < j + 40; k++) {
      const l = raw[k]!;
      if (l.includes(q)) {
        lines.push(l.slice(0, l.indexOf(q)));
        break;
      }
      lines.push(l);
    }
    return dedent(lines).trim();
  }
  return "";
}

function dedent(lines: string[]): string {
  const ind = Math.min(...lines.slice(1).filter((l) => l.trim()).map(indentOf), 1e9);
  return [lines[0], ...lines.slice(1).map((l) => l.slice(ind === 1e9 ? 0 : ind))].join("\n");
}

export function enclosingPy(decls: PyDecl[], line: number): PyDecl | null {
  let best: PyDecl | null = null;
  for (const d of decls) {
    if (line < d.range.start || line > d.range.end) continue;
    if (!best || d.range.end - d.range.start < best.range.end - best.range.start) best = d;
  }
  return best;
}

/** Every Python file in the repo, parsed on demand, with module-path resolution. */
export class PyIndex {
  private parsed = new Map<string, PyFile | null>();
  private byModuleSuffix: Map<string, string[]>;

  constructor(
    private readonly files: string[],
    private readonly read: (file: string) => string | null,
  ) {
    this.byModuleSuffix = new Map();
    for (const f of files.filter(isPy)) {
      const mod = f.replace(/\.pyi?$/, "").replace(/\/__init__$/, "").split("/");
      // Index every suffix so `app.models` finds `src/app/models.py`.
      for (let i = 0; i < mod.length; i++) {
        const key = mod.slice(i).join(".");
        (this.byModuleSuffix.get(key) ?? this.byModuleSuffix.set(key, []).get(key)!).push(f);
      }
    }
  }

  all(): string[] {
    return this.files.filter(isPy);
  }

  get(file: string): PyFile | null {
    if (!this.parsed.has(file)) {
      const text = this.read(file);
      this.parsed.set(file, text === null ? null : parsePy(file, text));
    }
    return this.parsed.get(file)!;
  }

  moduleFile(fromFile: string, module: string): string | null {
    if (module.startsWith(".")) {
      const dots = module.match(/^\.+/)![0].length;
      let dir = path.posix.dirname(fromFile);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      const rest = module.slice(dots).replace(/\./g, "/");
      const base = rest ? `${dir}/${rest}` : dir;
      for (const cand of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`]) if (this.files.includes(cand.replace(/^\.\//, ""))) return cand.replace(/^\.\//, "");
      return null;
    }
    const hits = this.byModuleSuffix.get(module);
    if (!hits?.length) return null;
    return [...hits].sort((a, b) => a.length - b.length)[0]!;
  }

  /** What a call chain in a file refers to, as (file, decl). */
  resolve(file: string, chain: string, line: number): { file: string; decl: PyDecl } | null {
    const pf = this.get(file);
    if (!pf) return null;
    const parts = chain.split(".");
    const find = (f: string, key: string) => {
      const target = this.get(f);
      const d = target?.decls.find((x) => x.key === key) ?? null;
      // Calling a class runs its __init__ when it has one.
      if (d?.kind === "class") return target?.decls.find((x) => x.key === `${key}.__init__`) ?? d;
      return d;
    };

    if ((parts[0] === "self" || parts[0] === "cls") && parts.length === 2) {
      const here = enclosingPy(pf.decls, line);
      const cls = here?.container ?? (here?.kind === "class" ? here.key : null);
      if (cls) {
        const d = find(file, `${cls}.${parts[1]}`);
        if (d) return { file, decl: d };
      }
      return null;
    }
    if (parts.length === 1) {
      const local = find(file, parts[0]!);
      if (local && !local.container) return { file, decl: local };
    }
    const imp = pf.imports.get(parts[0]!);
    if (imp) {
      if (imp.name) {
        // from mod import name → name.rest...
        const target = this.moduleFile(file, imp.module);
        if (target) {
          const d = find(target, [imp.name, ...parts.slice(1)].join("."));
          if (d) return { file: target, decl: d };
        }
        // from pkg import submodule → submodule.func
        const sub = this.moduleFile(file, `${imp.module}${imp.module.endsWith(".") ? "" : "."}${imp.name}`);
        if (sub && parts.length > 1) {
          const d = find(sub, parts.slice(1).join("."));
          if (d) return { file: sub, decl: d };
        }
      } else {
        // import a.b as x → x.func, or import a → a.b.func
        for (let cut = parts.length - 1; cut >= 1; cut--) {
          const modPath = imp.module.split(".").length > 1 && parts.length - cut === 1 ? imp.module : [imp.module, ...parts.slice(1, cut)].join(".");
          const target = this.moduleFile(file, modPath);
          if (target) {
            const d = find(target, parts.slice(cut).join("."));
            if (d) return { file: target, decl: d };
          }
        }
      }
    }
    // obj.method(): if exactly one method by that name exists anywhere, it's almost surely that one.
    if (parts.length >= 2) {
      const method = parts.at(-1)!;
      if (method.startsWith("__")) return null;
      const hits: { file: string; decl: PyDecl }[] = [];
      for (const f of this.all()) {
        for (const d of this.get(f)?.decls ?? []) if (d.name === method && d.container) hits.push({ file: f, decl: d });
        if (hits.length > 1) return null;
      }
      return hits[0] ?? null;
    }
    return null;
  }

  /** Callee names inside a range, for diffing calls across sides. */
  static calleeNames(pf: PyFile, range: Range): Map<string, number> {
    const names = new Map<string, number>();
    for (const c of pf.calls) {
      if (c.line < range.start || c.line > range.end) continue;
      const name = c.chain.split(".").at(-1)!;
      if (!names.has(name)) names.set(name, c.line);
    }
    return names;
  }

  /** The identifier chain under a cursor, for hover and go-to-definition. */
  chainAt(file: string, line: number, col: number): string | null {
    const pf = this.get(file);
    const text = pf?.code[line - 1];
    if (!text) return null;
    let s = col;
    let e = col;
    while (s > 0 && /[\w.]/.test(text[s - 1]!)) s--;
    while (e < text.length && /\w/.test(text[e]!)) e++;
    const chain = text.slice(s, e).replace(/^\.+|\.+$/g, "");
    return chain || null;
  }
}
