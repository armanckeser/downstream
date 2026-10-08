// A TypeScript language service over one side of the change. Used for call
// resolution, "who calls this", and IDE-grade hover in the review surface.
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FileSource } from "./git.ts";
import { WORKTREE } from "./git.ts";
import { extractDecls, type Decl, isTsLike } from "./ts-decls.ts";

const DEFAULTS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
  strict: false,
};

const MAX_PROJECT_FILES = 4000;

/** Disk outside the reviewed side (lib, node_modules) doesn't change during a review; probe it once. */
const fsCache = {
  files: new Map<string, boolean>(),
  dirs: new Map<string, boolean>(),
  subdirs: new Map<string, string[]>(),
  real: new Map<string, string>(),
  text: new Map<string, string | undefined>(),
};
function memo<T>(m: Map<string, T>, k: string, f: () => T): T {
  if (m.has(k)) return m.get(k)!;
  const v = f();
  m.set(k, v);
  return v;
}
export function clearFsCache() {
  for (const m of Object.values(fsCache)) m.clear();
}

export class TsProject {
  readonly service: ts.LanguageService;
  private readonly declCache = new Map<string, { sf: ts.SourceFile; decls: Decl[] }>();
  private readonly files: string[];

  constructor(
    readonly root: string,
    private readonly source: FileSource,
    rootFiles: string[],
    configPath: string | null,
    registry: ts.DocumentRegistry = ts.createDocumentRegistry(),
  ) {
    let options = DEFAULTS;
    let names = rootFiles.map((f) => this.abs(f));
    if (configPath) {
      const parsed = parseConfig(configPath, (p) => this.readAbs(p));
      if (parsed) {
        options = { ...DEFAULTS, ...parsed.options, noEmit: true, allowJs: true };
        if (parsed.fileNames.length > 0 && parsed.fileNames.length <= MAX_PROJECT_FILES) {
          names = [...new Set([...parsed.fileNames.map((f) => path.normalize(f)), ...names])];
        }
      }
    }
    this.files = names;
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.files,
      getScriptVersion: () => "1",
      getScriptSnapshot: (f) => {
        const text = this.readAbs(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => this.fileExists(f),
      readFile: (f) => this.readAbs(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: (d) => memo(fsCache.dirs, d, () => ts.sys.directoryExists(d)),
      getDirectories: (d) => memo(fsCache.subdirs, d, () => ts.sys.getDirectories(d)),
      realpath: (f) => memo(fsCache.real, f, () => ts.sys.realpath?.(f) ?? f),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.service = ts.createLanguageService(host, registry);
  }

  abs(rel: string): string {
    return path.normalize(path.join(this.root, rel));
  }

  rel(abs: string): string | null {
    const r = path.relative(this.root, path.normalize(abs)).split(path.sep).join("/");
    if (r.startsWith("..") || path.isAbsolute(r) || r.includes("node_modules/")) return null;
    return r;
  }

  /** Repo files come from the reviewed side; everything else (lib, node_modules) from disk. */
  private fileExists(abs: string): boolean {
    const rel = this.rel(abs);
    if (rel !== null && this.source.label !== WORKTREE) return this.source.exists(rel) || memo(fsCache.files, abs, () => ts.sys.fileExists(abs));
    return memo(fsCache.files, abs, () => ts.sys.fileExists(abs));
  }

  private readAbs(abs: string): string | undefined {
    const rel = this.rel(abs);
    if (rel !== null && this.source.label !== WORKTREE) {
      const text = this.source.read(rel);
      if (text !== null) return text;
    }
    const load = () => {
      try {
        return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
      } catch {
        return undefined;
      }
    };
    // Repo files in the working tree can change mid-review (fixes); only cache the rest.
    return rel === null ? memo(fsCache.text, abs, load) : load();
  }

  program(): ts.Program {
    return this.service.getProgram()!;
  }

  sourceFile(rel: string): ts.SourceFile | undefined {
    return this.program().getSourceFile(this.abs(rel));
  }

  /** Declarations for a repo file, extracted from the program's own AST so checker lookups line up. */
  declsFor(rel: string): { sf: ts.SourceFile; decls: Decl[] } | null {
    const hit = this.declCache.get(rel);
    if (hit) return hit;
    const sf = this.sourceFile(rel);
    if (!sf) return null;
    const entry = { sf, decls: extractDecls(sf) };
    this.declCache.set(rel, entry);
    return entry;
  }

  position(rel: string, line: number, col: number): number | null {
    const sf = this.sourceFile(rel);
    if (!sf) return null;
    const lineCount = sf.getLineStarts().length;
    if (line < 1 || line > lineCount) return null;
    const start = sf.getLineStarts()[line - 1]!;
    const lineEnd = line < lineCount ? sf.getLineStarts()[line]! - 1 : sf.text.length;
    return Math.min(start + col, lineEnd);
  }
}

function parseConfig(configPath: string, read: (p: string) => string | undefined): ts.ParsedCommandLine | null {
  const raw = ts.readConfigFile(configPath, (p) => read(p));
  if (raw.error) return null;
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath), undefined, configPath);
}

/** The tsconfig that actually includes a file: walk up, try the common names, honor `references`. */
export function findConfig(root: string, rel: string): string | null {
  const absFile = path.normalize(path.join(root, rel));
  let dir = path.dirname(absFile);
  const rootNorm = path.normalize(root);
  while (dir.startsWith(rootNorm)) {
    for (const name of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
      const candidate = path.join(dir, name);
      if (!existsSync(candidate)) continue;
      const parsed = parseConfig(candidate, (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined));
      if (!parsed) continue;
      if (parsed.fileNames.some((f) => path.normalize(f) === absFile)) return candidate;
      for (const ref of parsed.projectReferences ?? []) {
        const refPath = ref.path.endsWith(".json") ? ref.path : path.join(ref.path, "tsconfig.json");
        const sub = parseConfig(refPath, (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined));
        if (sub?.fileNames.some((f) => path.normalize(f) === absFile)) return refPath;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** One project per tsconfig, so monorepos resolve each package with its own settings. */
export class TsProjects {
  private readonly byConfig = new Map<string, TsProject>();
  private readonly configOf = new Map<string, string>();
  /** Shared so packages in one repo parse node_modules types once. */
  private readonly registry = ts.createDocumentRegistry();

  constructor(
    private readonly root: string,
    private readonly source: FileSource,
    private readonly seedFiles: string[],
  ) {}

  for(rel: string): TsProject | null {
    if (!isTsLike(rel)) return null;
    let key = this.configOf.get(rel);
    if (!key) {
      key = findConfig(this.root, rel) ?? "<none>";
      this.configOf.set(rel, key);
    }
    let project = this.byConfig.get(key);
    if (!project) {
      const seeds = this.seedFiles.filter((f) => isTsLike(f) && this.source.exists(f));
      project = new TsProject(this.root, this.source, seeds.length ? seeds : [rel], key === "<none>" ? null : key, this.registry);
      this.byConfig.set(key, project);
    }
    return project;
  }
}
