// One hover card for the whole app. Anything that names code (a token, a chip,
// a node on the map, a backticked name in a note) can ask it to explain itself.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fetchHover, type Hover } from "../lib/api.ts";
import { useReview } from "../lib/review.tsx";
import { displayName, openFindings } from "../lib/graph.ts";
import { KindTag, StatusMark } from "./marks.tsx";
import { Markdown } from "./markdown.tsx";

export type HoverTarget =
  | { type: "symbol"; id: string; hint?: string }
  | { type: "token"; file: string; line: number; col: number; side: "new" | "old"; text: string; symbolId: string | null };

type Ctx = { show: (rect: DOMRect, target: HoverTarget) => void; hide: () => void };
const HoverContext = createContext<Ctx | null>(null);
export const useHover = () => useContext(HoverContext)!;

export function HoverProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ rect: DOMRect; target: HoverTarget } | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((rect: DOMRect, target: HoverTarget) => {
    clearTimeout(hideTimer.current);
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setOpen({ rect, target }), 220);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(showTimer.current);
    hideTimer.current = setTimeout(() => setOpen(null), 140);
  }, []);
  const keep = () => clearTimeout(hideTimer.current);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    const onScroll = () => setOpen(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  return (
    <HoverContext.Provider value={{ show, hide }}>
      {children}
      {open && createPortal(<Card rect={open.rect} target={open.target} onEnter={keep} onLeave={hide} />, document.body)}
    </HoverContext.Provider>
  );
}

function Card({ rect, target, onEnter, onLeave }: { rect: DOMRect; target: HoverTarget; onEnter: () => void; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [ts, setTs] = useState<Hover | "loading">(target.type === "token" ? "loading" : null);

  useEffect(() => {
    if (target.type !== "token") return;
    const ctrl = new AbortController();
    fetchHover(target.file, target.line, target.col, target.side, ctrl.signal)
      .then(setTs)
      .catch(() => setTs(null));
    return () => ctrl.abort();
  }, [target]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - 12);
    left = Math.max(12, left);
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 6);
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  });

  const symbolId = target.type === "symbol" ? target.id : target.symbolId;
  if (target.type === "token" && !symbolId && (ts === null || (ts !== "loading" && !ts.display))) return null;

  return (
    <div
      ref={ref}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className={`fade-in fixed z-50 ${symbolId ? "w-[min(30rem,calc(100vw-24px))]" : "w-max max-w-[min(34rem,calc(100vw-24px))]"} rounded-lg border border-line bg-raised shadow-[0_12px_40px_-12px_rgb(0_0_0/0.7)]`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      role="tooltip"
    >
      {symbolId ? <SymbolBody id={symbolId} ts={ts} hint={target.type === "symbol" ? target.hint : undefined} /> : <TsBody ts={ts} />}
    </div>
  );
}

function TsBody({ ts }: { ts: Hover | "loading" }) {
  if (ts === "loading") return <div className="px-3 py-2 font-mono text-xs text-ink-3">reading types…</div>;
  if (!ts) return null;
  return (
    <div className="max-h-80 overflow-auto px-3 py-2.5">
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-ink">{ts.display}</pre>
      {ts.docs && <p className="mt-2 border-t border-line-subtle pt-2 text-[12.5px] leading-5 text-ink-2">{ts.docs}</p>}
      {ts.tags.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-3">
          {ts.tags.map((t, i) => (
            <li key={i}>
              <span className="font-mono">@{t.name}</span> {t.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SymbolBody({ id, ts, hint }: { id: string; ts: Hover | "loading"; hint?: string }) {
  const { index } = useReview();
  const s = index?.byId.get(id);
  if (!s || !index) return null;
  const callers = (index.into.get(id) ?? []).filter((e) => e.kind !== "uses");
  const calls = (index.out.get(id) ?? []).filter((e) => e.kind !== "uses");
  const notes = index.notesBySymbol.get(id) ?? [];
  const findings = openFindings(notes);
  const decisions = notes.filter((n) => n.kind === "decision" || n.kind === "why");
  const signature = ts && ts !== "loading" && ts.display ? ts.display : s.signature;
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StatusMark status={s.status} />
        <span className="font-mono text-[13px] font-medium text-ink">{displayName(s)}</span>
        <KindTag kind={s.kind} />
        {s.entry && <span className="rounded-sm border border-line px-1 font-mono text-2xs text-ink-2">entry</span>}
        <span className="ml-auto truncate font-mono text-2xs text-ink-3">
          {s.file}
          {s.range ? `:${s.range.start}` : ""}
        </span>
      </div>
      {signature && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[18px] text-ink-2">{signature}</pre>}
      {ts && ts !== "loading" && ts.docs && <p className="mt-1.5 text-[12.5px] text-ink-2">{ts.docs}</p>}
      {s.summary && (
        <div className="voice mt-2.5">
          <Markdown text={s.summary} className="prose-ds text-[12.5px]" />
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle pt-2 font-mono text-2xs text-ink-3">
        <span>
          <span className="text-ink-2">{callers.length}</span> caller{callers.length === 1 ? "" : "s"}
        </span>
        <span>
          calls <span className="text-ink-2">{calls.length}</span>
        </span>
        {s.changedLines > 0 && (
          <span>
            <span className="text-ink-2">{s.changedLines}</span> lines changed
          </span>
        )}
        {findings.length > 0 && <span className="text-agent">{findings.length} open finding{findings.length === 1 ? "" : "s"}</span>}
        {decisions.length > 0 && <span>{decisions.length} rationale</span>}
        <span className="ml-auto text-ink-4">{hint ?? "click to follow"}</span>
      </div>
    </div>
  );
}
