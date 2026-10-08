// The flow map: the change as a system, laid out left to right from its doors.
import { useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import { Maximize2 } from "lucide-react";
import type { CodeSymbol, Edge } from "@domain/model.ts";
import { useReview } from "../lib/review.tsx";
import { displayName, openFindings } from "../lib/graph.ts";
import { useHover } from "./hover.tsx";

type Laid = {
  nodes: { s: CodeSymbol; x: number; y: number; w: number; h: number }[];
  edges: { e: Edge; d: string; mid: { x: number; y: number } }[];
  width: number;
  height: number;
};

const NODE_H = 48;
const charW = 7.3;

function layout(symbols: CodeSymbol[], edges: Edge[]): Laid {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 16, ranksep: 64, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const s of symbols) {
    const w = Math.min(300, Math.max(150, Math.max(displayName(s).length * charW + 46, shortFile(s.file).length * 6.1 + 30)));
    g.setNode(s.id, { width: w, height: NODE_H });
  }
  for (const e of edges) g.setEdge(e.from, e.to, { weight: e.change === "added" ? 3 : 1, minlen: 1 }, e.id);
  dagre.layout(g);
  const nodes = symbols.map((s) => {
    const n = g.node(s.id);
    return { s, x: n.x - n.width / 2, y: n.y - n.height / 2, w: n.width, h: n.height };
  });
  const laidEdges = edges.map((e) => {
    const pts = (g.edge({ v: e.from, w: e.to, name: e.id })?.points ?? []) as { x: number; y: number }[];
    return { e, d: smooth(pts), mid: pts[Math.floor(pts.length / 2)] ?? { x: 0, y: 0 } };
  });
  const gr = g.graph();
  return { nodes, edges: laidEdges, width: gr.width ?? 800, height: gr.height ?? 600 };
}

function smooth(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
  }
  return d;
}

const shortFile = (f: string) => f.split("/").slice(-2).join("/");

export function FlowMap() {
  const { state, index, openSymbol, trail } = useReview();
  const hover = useHover();
  const [showContext, setShowContext] = useState(true);
  const [showTypes, setShowTypes] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const { symbols, edges } = useMemo(() => {
    if (!state) return { symbols: [], edges: [] };
    const typeKinds = new Set(["type", "interface"]);
    let syms = state.symbols.filter((s) => (showContext || s.status !== "context") && (showTypes || !typeKinds.has(s.kind)));
    const ids = new Set(syms.map((s) => s.id));
    const es = state.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && (showTypes || e.kind !== "uses"));
    // Drop unchanged symbols that ended up with nothing to connect to.
    const linked = new Set(es.flatMap((e) => [e.from, e.to]));
    syms = syms.filter((s) => s.status !== "context" || linked.has(s.id));
    return { symbols: syms, edges: es };
  }, [state, showContext, showTypes]);

  const laid = useMemo(() => layout(symbols, edges), [symbols, edges]);

  const fit = () => {
    const el = wrap.current;
    if (!el) return;
    const k = Math.min(1.15, Math.min((el.clientWidth - 40) / laid.width, (el.clientHeight - 40) / laid.height));
    setView({ k, x: (el.clientWidth - laid.width * k) / 2, y: Math.max(20, (el.clientHeight - laid.height * k) / 2) });
  };
  useEffect(fit, [laid]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        setView((v) => {
          const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.01)));
          return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
        });
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!state || !index) return null;
  const neighbors = hot ? new Set([hot, ...(index.out.get(hot) ?? []).map((e) => e.to), ...(index.into.get(hot) ?? []).map((e) => e.from)]) : null;
  const onTrail = new Set(trail);

  if (!symbols.length) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <p className="eyebrow">Map</p>
        <h2 className="mt-2 text-lg font-medium text-ink">Nothing to draw yet</h2>
        <p className="mt-1 text-ink-2">
          The analyzer found no symbols in this change. The agent can add them by hand: <code className="font-mono text-ink">downstream do symbol.add</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[24rem]">
      <div
        ref={wrap}
        className="absolute inset-0 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={(e) => {
          if ((e.target as Element).closest("[data-node]")) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <svg width="100%" height="100%" className="block select-none">
          <defs>
            {["ink", "muted", "agent"].map((t) => (
              <marker key={t} id={`arrow-${t}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0.5 L7.5,4 L0,7.5 Z" fill={t === "ink" ? "var(--color-ink-2)" : t === "agent" ? "var(--color-agent)" : "var(--color-ink-4)"} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {laid.edges.map(({ e, d, mid }) => {
              const dim = neighbors && !(neighbors.has(e.from) && neighbors.has(e.to) && (e.from === hot || e.to === hot));
              const trailEdge = onTrail.has(e.from) && onTrail.has(e.to) && trail.indexOf(e.to) === trail.indexOf(e.from) + 1;
              const stroke = trailEdge ? "var(--color-agent)" : e.change === "added" ? "var(--color-ink-2)" : e.change === "removed" ? "var(--color-del)" : "var(--color-ink-4)";
              return (
                <g key={e.id} opacity={dim ? 0.15 : 1} style={{ transition: "opacity 150ms" }}>
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={trailEdge ? 1.8 : e.change === "added" ? 1.4 : 1}
                    strokeDasharray={e.change === "removed" ? "4 4" : e.kind === "uses" ? "1 4" : undefined}
                    markerEnd={`url(#arrow-${trailEdge ? "agent" : e.change === "added" ? "ink" : "muted"})`}
                  />
                  {e.label && (
                    <text x={mid.x} y={mid.y - 6} textAnchor="middle" className="fill-ink-3 font-mono text-[10px]">
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
            {laid.nodes.map(({ s, x, y, w, h }) => {
              const findings = openFindings(index.notesBySymbol.get(s.id));
              const agentFindings = findings.filter((n) => n.author === "agent");
              const dim = neighbors && !neighbors.has(s.id);
              const context = s.status === "context";
              return (
                <g
                  key={s.id}
                  data-node
                  transform={`translate(${x},${y})`}
                  opacity={dim ? 0.3 : 1}
                  style={{ transition: "opacity 150ms", cursor: "pointer" }}
                  onPointerEnter={(ev) => {
                    setHot(s.id);
                    hover.show((ev.currentTarget as SVGGElement).getBoundingClientRect(), { type: "symbol", id: s.id, hint: "click to walk here from its door" });
                  }}
                  onPointerLeave={() => {
                    setHot(null);
                    hover.hide();
                  }}
                  onClick={() => {
                    hover.hide();
                    openSymbol(s.id);
                  }}
                >
                  {s.entry && (
                    <text x={2} y={-6} className="fill-ink-3 font-sans text-[9.5px] uppercase tracking-[0.08em]">
                      entry
                    </text>
                  )}
                  <rect
                    width={w}
                    height={h}
                    rx={8}
                    fill={onTrail.has(s.id) ? "var(--color-raised)" : context ? "var(--color-page)" : "var(--color-pane)"}
                    stroke={onTrail.has(s.id) ? "var(--color-agent-line)" : context ? "var(--color-line-subtle)" : "var(--color-line)"}
                    strokeDasharray={context ? "3 3" : undefined}
                  />
                  {s.entry && <rect x={0} y={10} width={2.5} height={h - 20} rx={1} fill="var(--color-ink)" />}
                  <g transform="translate(14,18)">
                    <NodeMark status={s.status} />
                  </g>
                  <text x={26} y={22} className={`font-mono text-[12.5px] ${s.status === "removed" ? "fill-ink-3" : context ? "fill-ink-2" : "fill-ink"}`} textDecoration={s.status === "removed" ? "line-through" : undefined}>
                    {displayName(s)}
                  </text>
                  <text x={26} y={37} className="fill-ink-3 font-mono text-[10px]">
                    {shortFile(s.file)}
                  </text>
                  {findings.length > 0 && (
                    <g transform={`translate(${w - 10},${-7})`}>
                      <rect x={-12} width={20} height={15} rx={4} fill={agentFindings.length ? "var(--color-agent)" : "var(--color-ink-2)"} />
                      <text x={-2} y={11} textAnchor="middle" className="fill-page font-mono text-[10px] font-semibold">
                        {findings.length}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-wrap items-end justify-between gap-3">
        <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-line bg-pane/95 p-1 backdrop-blur">
          <Toggle on={showContext} onClick={() => setShowContext((v) => !v)} label="Unchanged neighbors" />
          <Toggle on={showTypes} onClick={() => setShowTypes((v) => !v)} label="Types" />
          <button type="button" onClick={fit} className="press rounded-md p-1.5 text-ink-3 hover:bg-overlay hover:text-ink" title="Fit to view">
            <Maximize2 size={13} />
          </button>
        </div>
        <Legend />
      </div>
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`press rounded-md px-2 py-1 text-[12px] ${on ? "bg-overlay text-ink" : "text-ink-3 hover:text-ink-2"}`}>
      {label}
    </button>
  );
}

function NodeMark({ status }: { status: CodeSymbol["status"] }) {
  if (status === "added") return <circle r={4} fill="var(--color-ink)" />;
  if (status === "modified")
    return (
      <g>
        <circle r={3.6} fill="none" stroke="var(--color-ink)" strokeWidth={1.2} />
        <path d="M0 -3.6 A3.6 3.6 0 0 1 0 3.6 Z" fill="var(--color-ink)" />
      </g>
    );
  if (status === "removed")
    return (
      <g stroke="var(--color-ink-3)" strokeWidth={1.2} fill="none">
        <circle r={3.6} />
        <path d="M-2.6 2.6 L2.6 -2.6" />
      </g>
    );
  return <circle r={2.6} fill="none" stroke="var(--color-ink-4)" strokeWidth={1.2} />;
}

function Legend() {
  const item = (mark: React.ReactNode, label: string) => (
    <span className="flex items-center gap-1.5">
      {mark}
      {label}
    </span>
  );
  const line = (stroke: string, dash?: string) => (
    <svg width="18" height="6">
      <path d="M1 3 H17" stroke={stroke} strokeWidth={1.4} strokeDasharray={dash} />
    </svg>
  );
  const dot = (status: CodeSymbol["status"]) => (
    <svg width="10" height="10" viewBox="-5 -5 10 10">
      <NodeMark status={status} />
    </svg>
  );
  return (
    <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-pane/95 px-3 py-1.5 font-mono text-2xs text-ink-3 backdrop-blur">
      {item(dot("added"), "added")}
      {item(dot("modified"), "modified")}
      {item(dot("removed"), "removed")}
      {item(dot("context"), "unchanged")}
      <span className="h-3 w-px bg-line" />
      {item(line("var(--color-ink-2)"), "new call")}
      {item(line("var(--color-ink-4)"), "existing")}
      {item(line("var(--color-del)", "3 3"), "removed")}
      {item(line("var(--color-agent)"), "your trail")}
      <span className="h-3 w-px bg-line" />
      <span>⌘/ctrl + scroll to zoom</span>
    </div>
  );
}
