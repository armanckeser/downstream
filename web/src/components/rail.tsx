// The rail: ways in. Doors (entry points), the agent's walkthrough, and files.
import { useEffect, useMemo, useState } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { useReview } from "../lib/review.tsx";
import { byPosition, displayName, openFindings } from "../lib/graph.ts";
import { StatusMark } from "./marks.tsx";
import { useHover } from "./hover.tsx";

export function Rail() {
  const { state, index, openSymbol, openStep, stepId, trail } = useReview();
  const hover = useHover();
  if (!state || !index) return <RailSkeleton />;
  const current = trail.at(-1);

  return (
    <nav className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain" aria-label="Ways in">
      <section className="px-3 pb-2 pt-3">
        <h2 className="eyebrow px-2 pb-1.5">Doors</h2>
        {index.entries.length === 0 ? (
          <p className="px-2 text-[12.5px] text-ink-3">No entry points marked.</p>
        ) : (
          <ul>
            {index.entries.map((s) => {
              const findings = openFindings(index.notesBySymbol.get(s.id));
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => openSymbol(s.id)}
                    onPointerEnter={(e) => hover.show(e.currentTarget.getBoundingClientRect(), { type: "symbol", id: s.id })}
                    onPointerLeave={hover.hide}
                    className={`press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${trail[0] === s.id ? "bg-overlay" : "hover:bg-pane"}`}
                  >
                    <StatusMark status={s.status} />
                    <span className="truncate font-mono text-[12.5px] text-ink">{displayName(s)}</span>
                    {findings.length > 0 && <span className="ml-auto font-mono text-2xs text-agent">{findings.length}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="border-t border-line-subtle px-3 pb-2 pt-3">
        <div className="flex items-baseline px-2 pb-1.5">
          <h2 className="eyebrow">Walkthrough</h2>
          {state.steps.length > 0 && <span className="ml-auto font-mono text-2xs text-ink-4">j / k</span>}
        </div>
        {state.steps.length === 0 ? (
          <p className="px-2 text-[12.5px] leading-relaxed text-ink-3">The agent hasn't written one yet. It lays out the change in the order it runs, door first.</p>
        ) : (
          <ol>
            {state.steps.map((st) => {
              const active = st.id === stepId;
              return (
                <li key={st.id}>
                  <button type="button" onClick={() => openStep(st.id)} className={`press flex w-full items-baseline gap-2.5 rounded-md px-2 py-1.5 text-left ${active ? "bg-agent-wash" : "hover:bg-pane"}`}>
                    <span className={`w-4 shrink-0 text-right font-mono text-2xs ${active ? "text-agent" : "text-ink-4"}`}>{st.order}</span>
                    <span className={`text-[13px] leading-snug ${active ? "text-ink" : "text-ink-2"}`}>{st.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <Files current={current ?? null} />
    </nav>
  );
}

function Files({ current }: { current: string | null }) {
  const { state, index, openSymbol } = useReview();
  const files = useMemo(() => {
    const set = new Set<string>(state?.files.map((f) => f.path) ?? []);
    for (const s of state?.symbols ?? []) set.add(s.file);
    return [...set].sort();
  }, [state]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      (state?.files ?? [])
        .filter((f) => f.status !== "context")
        .map((f) => ({ path: f.path, status: f.status === "deleted" ? "deleted" : f.status === "added" ? "added" : f.status === "renamed" ? "renamed" : "modified" })),
    [state],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const { model } = useFileTree({
    paths: files,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    gitStatus,
    density: "compact",
    onSelectionChange: (paths) => setSelected(paths.at(-1) ?? null),
  } as Parameters<typeof useFileTree>[0]);

  useEffect(() => {
    model.resetPaths?.(files);
  }, [model, files]);
  useEffect(() => {
    model.setGitStatus?.(gitStatus);
  }, [model, gitStatus]);

  const currentFile = current ? index?.byId.get(current)?.file : null;
  const file = selected ?? currentFile ?? null;
  const symbols = useMemo(() => (state?.symbols ?? []).filter((s) => s.file === file).sort(byPosition), [state, file]);

  return (
    <section className="border-t border-line-subtle px-3 pt-3">
      <h2 className="eyebrow px-2 pb-1.5">Files</h2>
      <div className="ds-tree -mx-1">
        <FileTree model={model} style={{ height: Math.min(260, 28 + files.length * 24) }} />
      </div>
      {file && symbols.length > 0 && (
        <ul className="mb-3 mt-1 border-l border-line-subtle pl-2">
          {symbols.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => openSymbol(s.id)} className={`press flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${s.id === current ? "bg-overlay" : "hover:bg-pane"}`}>
                <StatusMark status={s.status} />
                <span className="truncate font-mono text-[12px] text-ink-2">{displayName(s)}</span>
                {s.range && <span className="ml-auto font-mono text-2xs text-ink-4">{s.range.start}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RailSkeleton() {
  return (
    <div className="space-y-2 p-5" aria-busy>
      {[70, 54, 62, 40, 66].map((w, i) => (
        <div key={i} className="h-3.5 rounded bg-pane" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
