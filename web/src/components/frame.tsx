// A frame is one symbol on the trail: who it is, why it exists, its code
// scoped to just itself, and the calls you can follow out of it.
import { useEffect, useMemo, useRef, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { ChevronsDownUp, ChevronsUpDown, CornerDownRight, X } from "lucide-react";
import type { CodeSymbol, Edge, Note } from "@domain/model.ts";
import { action, fetchDefinition, fetchFrame, type Frame as FrameData } from "../lib/api.ts";
import { useReview } from "../lib/review.tsx";
import { displayName } from "../lib/graph.ts";
import { buildPatch, foldFrame, parseFrame, windowAround } from "../lib/patch.ts";
import { useHover } from "./hover.tsx";
import { EdgeMark, KindTag, NoteKindTag, SeverityMark, StatusMark } from "./marks.tsx";
import { Markdown } from "./markdown.tsx";

const IDENT = /^[A-Za-z_$][\w$]*$/;

const SHADOW_CSS = `
  [data-ds-link] { text-decoration: underline dotted color-mix(in srgb, currentColor 45%, transparent); text-underline-offset: 3px; cursor: pointer; }
  [data-ds-link]:hover { text-decoration-style: solid; }
  [data-ds-next] { text-decoration: underline solid #f2a63b !important; text-decoration-thickness: 1.5px !important; }
`;

export function FrameView({ symbol, next, compact, onToggleCompact, onClose, first }: {
  symbol: CodeSymbol;
  next: string | null;
  compact: boolean;
  onToggleCompact: () => void;
  onClose: (() => void) | null;
  first: boolean;
}) {
  const { index, version, openSymbol, openWhenReady, setTrail, trail, openNote, noteId, focus, selection, setSelection } = useReview();
  const hover = useHover();
  const [data, setData] = useState<FrameData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    fetchFrame(symbol.id, version)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [symbol.id, version]);

  const outgoing = useMemo(() => (index?.out.get(symbol.id) ?? []).filter((e) => e.kind !== "uses"), [index, symbol.id]);
  const incoming = useMemo(() => (index?.into.get(symbol.id) ?? []).filter((e) => e.kind !== "uses"), [index, symbol.id]);
  const usesTypes = useMemo(() => (index?.out.get(symbol.id) ?? []).filter((e) => e.kind === "uses"), [index, symbol.id]);
  const notes = index?.notesBySymbol.get(symbol.id) ?? [];
  const nextEdge = next ? outgoing.find((e) => e.to === next) : undefined;

  // Links on each line: which tokens lead to which symbol.
  const linksByLine = useMemo(() => {
    const m = new Map<number, { name: string; id: string; side: "new" | "old" }[]>();
    for (const e of outgoing) {
      if (e.line == null) continue;
      const t = index?.byId.get(e.to);
      if (!t) continue;
      const list = m.get(e.line) ?? [];
      list.push({ name: t.name, id: t.id, side: e.change === "removed" ? "old" : "new" });
      m.set(e.line, list);
    }
    return m;
  }, [outgoing, index]);

  const removed = symbol.status === "removed";
  const parsed = useMemo(() => (data ? parseFrame(data.patch) : null), [data]);
  const big = (parsed?.rows.length ?? 0) > 60;
  const { patch, hidden } = useMemo(() => {
    if (!data || !parsed) return { patch: null, hidden: 0 };
    if (compact && nextEdge?.line) return { patch: buildPatch(parsed, windowAround(parsed, nextEdge.line, nextEdge.change === "removed" ? "old" : "new")), hidden: 0 };
    if (!big || showAll) return { patch: data.patch, hidden: 0 };
    const keep = new Set<number>();
    for (const e of outgoing) if (e.line != null) keep.add(e.line);
    for (const n of notes) if (n.lines) for (let l = n.lines.start; l <= n.lines.end; l++) keep.add(l);
    const want = focus?.symbolId === symbol.id ? focus.lines : null;
    if (want) for (let l = want.start; l <= want.end; l++) keep.add(l);
    if (selection?.symbolId === symbol.id) for (let l = selection.lines.start; l <= selection.lines.end; l++) keep.add(l);
    return foldFrame(parsed, keep);
  }, [data, parsed, compact, nextEdge, big, showAll, outgoing, notes, focus, selection, symbol.id]);

  const lineNotes = notes.filter((n) => n.lines);
  const looseNotes = notes.filter((n) => !n.lines && n.kind !== "question");
  const annotations: DiffLineAnnotation<Note>[] = useMemo(
    () =>
      lineNotes
        .filter((n) => n.status === "open" || n.id === noteId)
        .map((n) => ({ side: n.side === "old" ? "deletions" : "additions", lineNumber: n.lines!.end, metadata: n })),
    [lineNotes, noteId],
  );

  const selected: SelectedLineRange | null = useMemo(() => {
    if (selection && selection.symbolId === symbol.id) return { start: selection.lines.start, end: selection.lines.end, side: selection.side === "old" ? "deletions" : "additions" };
    if (focus?.symbolId === symbol.id && focus.lines) return { start: focus.lines.start, end: focus.lines.end, side: "additions" };
    const active = notes.find((n) => n.id === noteId && n.lines);
    if (active?.lines) return { start: active.lines.start, end: active.lines.end, side: active.side === "old" ? "deletions" : "additions" };
    if (nextEdge?.line) return { start: nextEdge.line, end: nextEdge.line, side: nextEdge.change === "removed" ? "deletions" : "additions" };
    return null;
  }, [selection, focus, symbol.id, notes, noteId, nextEdge]);

  useEffect(() => {
    if (focus?.symbolId === symbol.id) rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, symbol.id]);

  // Mark tokens that lead to another symbol, once Pierre has rendered.
  const decorate = (node: HTMLElement) => {
    const root = node.shadowRoot ?? node;
    for (const [line, links] of linksByLine) {
      const rows = root.querySelectorAll(`[data-line="${line}"]`);
      rows.forEach((row) => {
        row.querySelectorAll("span").forEach((span) => {
          if (span.children.length) return;
          const text = span.textContent?.trim();
          const hit = links.find((l) => l.name === text);
          if (!hit) return;
          span.setAttribute("data-ds-link", hit.id);
          if (hit.id === next) span.setAttribute("data-ds-next", "");
        });
      });
    }
  };

  const tokenTarget = (props: { lineNumber: number; tokenText: string; side?: "additions" | "deletions" }) => {
    const text = props.tokenText.trim();
    const link = linksByLine.get(props.lineNumber)?.find((l) => l.name === text);
    return { text, link, side: props.side === "deletions" ? ("old" as const) : ("new" as const) };
  };

  return (
    <article ref={rootRef} className="scroll-mt-16 rounded-lg border border-line-subtle bg-pane" aria-label={displayName(symbol)}>
      <header className="flex items-start gap-3 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusMark status={symbol.status} />
            <h3 className={`font-mono text-[14.5px] font-medium tracking-tight ${removed ? "text-ink-3 line-through" : "text-ink"}`}>{displayName(symbol)}</h3>
            <KindTag kind={symbol.kind} />
            {symbol.entry && <span className="rounded-sm border border-line px-1 font-mono text-2xs text-ink-2">entry</span>}
            <span className="truncate font-mono text-2xs text-ink-3">
              {symbol.file}
              {symbol.range ? `:${symbol.range.start}–${symbol.range.end}` : symbol.oldRange ? ` (was :${symbol.oldRange.start}–${symbol.oldRange.end})` : ""}
            </span>
          </div>
          {symbol.summary && (
            <div className="voice mt-2 max-w-[70ch]">
              <Markdown text={symbol.summary} className="prose-ds text-[13px]" />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {big && !compact && (hidden > 0 || showAll) && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="press rounded-md px-2 py-1 font-mono text-2xs text-ink-3 hover:bg-overlay hover:text-ink">
              {showAll ? "fold unchanged" : `show ${hidden} hidden lines`}
            </button>
          )}
          {nextEdge?.line && (
            <button type="button" onClick={onToggleCompact} className="press rounded-md p-1.5 text-ink-3 hover:bg-overlay hover:text-ink" title={compact ? "Show the whole symbol" : "Collapse to the call"}>
              {compact ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className="press rounded-md p-1.5 text-ink-3 hover:bg-overlay hover:text-ink" title="Close this frame and everything after it">
              <X size={14} />
            </button>
          )}
        </div>
      </header>

      {first && incoming.length > 0 && (
        <EdgeRow
          label="reached from"
          edges={incoming}
          pick={(e) => e.from}
          onOpen={(id) => setTrail([id, ...trail])}
        />
      )}

      {looseNotes.length > 0 && (
        <ul className="mx-4 mb-2 space-y-1">
          {looseNotes.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => openNote(n.id)} className={`press flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-overlay ${n.id === noteId ? "bg-overlay" : ""}`}>
                {n.kind === "finding" ? <SeverityMark severity={n.severity} author={n.author} /> : null}
                <NoteKindTag note={n} />
                <span className={`text-[13px] ${n.status === "open" ? "text-ink" : "text-ink-3 line-through"}`}>{n.title}</span>
                {n.replies.length > 0 && <span className="ml-auto font-mono text-2xs text-ink-3">{n.replies.length}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="ds-code overflow-hidden border-y border-line-subtle">
        {error ? (
          <p className="px-4 py-3 font-mono text-xs text-del">Couldn't load {symbol.file}: {error}</p>
        ) : !patch ? (
          <div className="space-y-2 px-4 py-3" aria-busy>
            {[62, 48, 71, 39].map((w, i) => (
              <div key={i} className="h-3 rounded bg-raised" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : (
          <PatchDiff<Note, undefined>
            patch={patch}
            lineAnnotations={annotations}
            selectedLines={selected}
            renderAnnotation={(a) => <Pin note={a.metadata!} active={a.metadata!.id === noteId} onOpen={() => openNote(a.metadata!.id)} />}
            options={{
              theme: "pierre-dark",
              themeType: "dark",
              diffStyle: "unified",
              disableFileHeader: true,
              hunkSeparators: "simple",
              overflow: "scroll",
              lineDiffType: "word",
              diffIndicators: "bars",
              unsafeCSS: SHADOW_CSS,
              lineHoverHighlight: "both",
              enableLineSelection: true,
              // Only gestures: onLineSelected also echoes the controlled selection back.
              onLineSelectionEnd: (r) => {
                if (!r) return setSelection(null);
                setSelection({
                  symbolId: symbol.id,
                  file: symbol.file,
                  lines: { start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) },
                  side: r.side === "deletions" ? "old" : "new",
                });
              },
              onPostRender: (node) => decorate(node),
              onTokenEnter: (props) => {
                const t = tokenTarget(props);
                if (!IDENT.test(t.text)) return;
                hover.show(props.tokenElement.getBoundingClientRect(), {
                  type: "token",
                  file: t.side === "old" ? (symbol.oldFile ?? symbol.file) : symbol.file,
                  line: props.lineNumber,
                  col: props.lineCharStart,
                  side: t.side,
                  text: t.text,
                  symbolId: t.link?.id ?? null,
                });
              },
              onTokenLeave: () => hover.hide(),
              onTokenClick: (props) => {
                const t = tokenTarget(props);
                hover.hide();
                if (t.link) return openSymbol(t.link.id, { after: symbol.id });
                if (!IDENT.test(t.text)) return;
                void fetchDefinition(t.side === "old" ? (symbol.oldFile ?? symbol.file) : symbol.file, props.lineNumber, props.lineCharStart, t.side).then(async (def) => {
                  if (!def) return;
                  if (def.symbolId) return openSymbol(def.symbolId, { after: symbol.id });
                  // Not on the map yet: put it there (the agent sees it too) and follow it.
                  const added = await action<CodeSymbol>("symbol.add", { file: def.file, name: t.text, line: def.line, status: "context" }).catch(() => null);
                  if (added) openWhenReady(added.id, symbol.id);
                });
              },
            }}
          />
        )}
      </div>

      {(outgoing.length > 0 || usesTypes.length > 0) && (
        <EdgeRow label="calls" edges={outgoing} pick={(e) => e.to} active={next} onOpen={(id) => openSymbol(id, { after: symbol.id })} extra={usesTypes} />
      )}
    </article>
  );
}

function EdgeRow({ label, edges, pick, onOpen, active, extra = [] }: { label: string; edges: Edge[]; pick: (e: Edge) => string; onOpen: (id: string) => void; active?: string | null; extra?: Edge[] }) {
  const { index } = useReview();
  const hover = useHover();
  const chip = (e: Edge, quiet = false) => {
    const id = pick(e);
    const s = index?.byId.get(id);
    if (!s) return null;
    return (
      <li key={e.id}>
        <button
          type="button"
          onClick={() => onOpen(id)}
          onPointerEnter={(ev) => hover.show(ev.currentTarget.getBoundingClientRect(), { type: "symbol", id })}
          onPointerLeave={hover.hide}
          className={`press flex items-center gap-1.5 rounded-md border px-2 py-1 ${active === id ? "border-agent-line bg-agent-wash" : "border-line-subtle hover:border-line hover:bg-overlay"} ${quiet ? "opacity-70" : ""}`}
        >
          <StatusMark status={s.status} />
          <span className={`font-mono text-[12px] ${e.change === "removed" ? "text-ink-3 line-through" : "text-ink"}`}>{displayName(s)}</span>
          {e.kind === "renders" && <span className="font-mono text-2xs text-ink-3">&lt;/&gt;</span>}
          {e.kind === "uses" && <span className="font-mono text-2xs text-ink-3">type</span>}
          {e.label && <span className="text-2xs text-ink-3">{e.label}</span>}
          <EdgeMark edge={e} />
          {e.line != null && <span className="font-mono text-2xs text-ink-4">:{e.line}</span>}
        </button>
      </li>
    );
  };
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className="eyebrow mt-1.5 w-[6.5rem] shrink-0 whitespace-nowrap">{label}</span>
      <ul className="flex flex-wrap gap-1.5">
        {edges.map((e) => chip(e))}
        {extra.map((e) => chip(e, true))}
      </ul>
    </div>
  );
}

function Pin({ note, active, onOpen }: { note: Note; active: boolean; onOpen: () => void }) {
  const agent = note.author === "agent";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`press my-1 ml-2 mr-3 flex max-w-[calc(100%-1.25rem)] items-center gap-2 rounded-md border px-2.5 py-1.5 text-left font-sans ${
        active ? "border-agent-line bg-agent-wash" : agent ? "border-agent-line/50 bg-agent-wash hover:border-agent-line" : "border-line bg-raised hover:border-ink-4"
      }`}
    >
      <CornerDownRight size={12} className={agent ? "text-agent" : "text-ink-3"} />
      {note.kind === "finding" && <SeverityMark severity={note.severity} author={note.author} />}
      <NoteKindTag note={note} />
      <span className="truncate text-[12.5px] text-ink">{note.title}</span>
      {note.replies.length > 0 && <span className="font-mono text-2xs text-ink-3">{note.replies.length}</span>}
    </button>
  );
}
