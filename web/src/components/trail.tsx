// The trail: frames stacked in call order, from a door down to where you are.
// Earlier frames fold to the line that called the next one, like a call stack
// you can read.
import { Fragment, useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight } from "lucide-react";
import { useReview } from "../lib/review.tsx";
import { displayName } from "../lib/graph.ts";
import { FrameView } from "./frame.tsx";
import { Markdown } from "./markdown.tsx";
import { StatusMark } from "./marks.tsx";
import { useHover } from "./hover.tsx";

export function Trail() {
  const { trail, index, setTrail, state, stepId, openStep, openSymbol } = useReview();
  const hover = useHover();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => setExpanded({}), [trail.join("|")]);

  if (!index || !state) return null;
  const symbols = trail.map((id) => index.byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  const step = state.steps.find((s) => s.id === stepId) ?? null;
  const stepIdx = step ? state.steps.indexOf(step) : -1;

  if (!symbols.length) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="eyebrow">Trail</p>
        <h2 className="mt-2 text-lg font-medium text-ink">Start from a door</h2>
        <p className="mt-1 text-ink-2">Pick an entry point. Each call you follow opens below it, so the change reads in the order it runs.</p>
        <ul className="mt-6 divide-y divide-line-subtle border-y border-line-subtle">
          {index.entries.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => openSymbol(s.id)} className="press flex w-full items-center gap-3 px-1 py-2.5 text-left hover:bg-pane">
                <StatusMark status={s.status} />
                <span className="font-mono text-[13px] text-ink">{displayName(s)}</span>
                <span className="truncate font-mono text-2xs text-ink-3">{s.file}</span>
                {s.summary && <span className="ml-auto max-w-[45%] truncate text-[13px] text-ink-3">{s.summary}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[68rem] px-5 pb-40 pt-3 md:px-8">
      <nav aria-label="Trail" className="sticky top-0 z-10 -mx-2 mb-3 flex flex-wrap items-center gap-1 bg-page/90 px-2 py-2 backdrop-blur">
        {symbols.map((s, i) => (
          <Fragment key={s.id}>
            {i > 0 && <ArrowRight size={12} className="text-ink-4" />}
            <button
              type="button"
              onClick={() => setTrail(trail.slice(0, i + 1))}
              onPointerEnter={(e) => hover.show(e.currentTarget.getBoundingClientRect(), { type: "symbol", id: s.id, hint: "click to cut the trail here" })}
              onPointerLeave={hover.hide}
              className={`press flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[12px] ${i === symbols.length - 1 ? "text-ink" : "text-ink-3 hover:text-ink-2"}`}
            >
              <StatusMark status={s.status} />
              {displayName(s)}
            </button>
          </Fragment>
        ))}
      </nav>

      {step && (
        <section className="fade-in mb-5 rounded-lg border border-agent-line/40 bg-agent-wash px-4 py-3" aria-label={`Step ${step.order}`}>
          <div className="flex items-center gap-3">
            <span className="font-mono text-2xs text-agent-ink">
              step {step.order} of {state.steps.length}
            </span>
            <h2 className="text-[14.5px] font-medium text-ink">{step.title}</h2>
            <div className="ml-auto flex items-center gap-1">
              <button type="button" disabled={stepIdx <= 0} onClick={() => openStep(state.steps[stepIdx - 1]!.id)} className="press rounded-md p-1.5 text-ink-2 hover:bg-overlay disabled:opacity-30" title="Previous step (k)">
                <ArrowLeft size={14} />
              </button>
              <button type="button" disabled={stepIdx >= state.steps.length - 1} onClick={() => openStep(state.steps[stepIdx + 1]!.id)} className="press rounded-md p-1.5 text-ink-2 hover:bg-overlay disabled:opacity-30" title="Next step (j)">
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
          {step.body && <Markdown text={step.body} className="prose-ds mt-1.5 max-w-[75ch] text-[13.5px]" />}
        </section>
      )}

      <div className="space-y-0">
        {symbols.map((s, i) => {
          const next = symbols[i + 1]?.id ?? null;
          const isLast = i === symbols.length - 1;
          const compact = !isLast && !expanded[s.id];
          const edge = next ? index.out.get(s.id)?.find((e) => e.to === next) : undefined;
          return (
            <Fragment key={s.id}>
              <FrameView
                symbol={s}
                next={next}
                first={i === 0}
                compact={compact}
                onToggleCompact={() => setExpanded((x) => ({ ...x, [s.id]: compact }))}
                onClose={i > 0 ? () => setTrail(trail.slice(0, i)) : null}
              />
              {next && (
                <div className="flex items-center gap-2 py-2 pl-6 font-mono text-2xs text-ink-3" aria-hidden>
                  <ArrowDown size={12} className="text-agent" />
                  {edge ? (
                    <span>
                      {edge.kind === "renders" ? "renders" : "calls"} <span className="text-ink-2">{displayName(symbols[i + 1]!)}</span>
                      {edge.line ? ` at line ${edge.line}` : ""}
                      {edge.change === "added" ? " · new in this change" : edge.change === "removed" ? " · removed in this change" : ""}
                      {edge.label ? ` · ${edge.label}` : ""}
                    </span>
                  ) : (
                    <span>then</span>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
