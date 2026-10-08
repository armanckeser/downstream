// The overview: the change in one breath, before any code.
import { ArrowRight } from "lucide-react";
import { useReview } from "../lib/review.tsx";
import { displayName, severityRank } from "../lib/graph.ts";
import { Markdown } from "./markdown.tsx";
import { NoteKindTag, SeverityMark, StatusMark } from "./marks.tsx";
import { useHover } from "./hover.tsx";

export function Overview() {
  const { state, index, openStep, openSymbol, openNote } = useReview();
  const hover = useHover();
  if (!state || !index) return <OverviewSkeleton />;
  const { review, files, symbols, notes, steps } = state;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const changed = symbols.filter((s) => s.status !== "context");
  const findings = notes.filter((n) => n.kind === "finding" && n.status === "open").sort((a, b) => severityRank[a.severity ?? "concern"] - severityRank[b.severity ?? "concern"]);
  const decisions = notes.filter((n) => n.kind === "decision" || n.kind === "why");
  const questions = notes.filter((n) => n.kind === "question" && n.status === "open");
  const counts = (["added", "modified", "removed"] as const).map((k) => [k, changed.filter((s) => s.status === k).length] as const).filter(([, n]) => n > 0);

  // The contracts this change introduces or alters: judge these before the code that fills them in.
  const shapes = symbols.filter((s) => (s.kind === "interface" || s.kind === "type" || s.kind === "class") && (review.mode === "teach" ? s.exported : s.status !== "context"));

  const start = () => (steps[0] ? openStep(steps[0].id) : index.entries[0] ? openSymbol(index.entries[0].id) : undefined);

  return (
    <div className="mx-auto max-w-[52rem] px-6 pb-24 pt-10 md:px-10">
      <p className="font-mono text-2xs text-ink-3">
        {review.mode === "teach" ? "teaching" : review.pr ? `pull request #${review.pr}` : "change"}
        {review.base && (
          <>
            {" "}
            · {review.base} … {review.head === "WORKTREE" ? "working tree" : review.head.slice(0, 10)}
          </>
        )}
      </p>
      <h1 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.015em] text-ink">{review.title}</h1>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-ink-3">
        {review.mode === "diff" && (
          <>
            <div>
              <dt className="sr-only">Lines</dt>
              <dd>
                <span className="text-add">+{additions}</span> <span className="text-del">−{deletions}</span>
              </dd>
            </div>
            <div>
              <dd>
                <span className="text-ink-2">{files.length}</span> files
              </dd>
            </div>
          </>
        )}
        {counts.map(([k, n]) => (
          <div key={k} className="flex items-center gap-1.5">
            <StatusMark status={k} />
            <dd>
              <span className="text-ink-2">{n}</span> {k}
            </dd>
          </div>
        ))}
      </dl>

      <section className="mt-8">
        {review.summary ? (
          <div className="voice">
            <Markdown text={review.summary} className="prose-ds max-w-[68ch] text-[14.5px] leading-[1.65]" />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-line px-4 py-3.5">
            <p className="text-[13.5px] text-ink-2">The agent is reading the change and hasn't written its summary yet.</p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              It will appear here as soon as it runs <code className="font-mono text-ink-2">downstream apply</code>. The map already works: the analyzer found {changed.length} changed symbols.
            </p>
          </div>
        )}
        <button type="button" onClick={start} disabled={!steps.length && !index.entries.length} className="press mt-6 inline-flex items-center gap-2 rounded-md bg-ink px-3.5 py-2 text-[13.5px] font-medium text-page hover:bg-white disabled:opacity-30">
          {steps.length ? `Walk through it, ${steps.length} steps` : "Start at the first door"}
          <ArrowRight size={15} />
        </button>
      </section>

      <div className="mt-12 grid gap-x-10 gap-y-10 md:grid-cols-[1.25fr_1fr]">
        <section>
          <h2 className="eyebrow border-b border-line-subtle pb-2">Doors into this change</h2>
          <ul className="divide-y divide-line-subtle">
            {index.entries.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => openSymbol(s.id)}
                  onPointerEnter={(e) => hover.show(e.currentTarget.getBoundingClientRect(), { type: "symbol", id: s.id })}
                  onPointerLeave={hover.hide}
                  className="press group w-full py-2.5 text-left"
                >
                  <span className="flex items-center gap-2">
                    <StatusMark status={s.status} />
                    <span className="font-mono text-[13px] text-ink group-hover:underline group-hover:decoration-ink-4 group-hover:underline-offset-4">{displayName(s)}</span>
                    <span className="truncate font-mono text-2xs text-ink-3">{s.file}</span>
                  </span>
                  {s.summary && <span className="mt-0.5 block pl-[18px] text-[13px] text-ink-3">{s.summary}</span>}
                </button>
              </li>
            ))}
            {index.entries.length === 0 && <li className="py-2.5 text-[13px] text-ink-3">None marked yet.</li>}
          </ul>
        </section>

        <section>
          <h2 className="eyebrow flex border-b border-line-subtle pb-2">
            Needs your eyes <span className="ml-auto font-mono normal-case tracking-normal text-ink-4">{findings.length + questions.length}</span>
          </h2>
          <ul className="divide-y divide-line-subtle">
            {[...findings, ...questions].map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => openNote(n.id)} className="press flex w-full items-baseline gap-2 py-2.5 text-left">
                  {n.kind === "finding" ? <SeverityMark severity={n.severity} author={n.author} /> : <span className="size-2 shrink-0 rounded-full bg-ink-3" />}
                  <span className="text-[13px] leading-snug text-ink">{n.title}</span>
                </button>
              </li>
            ))}
            {findings.length + questions.length === 0 && <li className="py-2.5 text-[13px] text-ink-3">Nothing flagged.</li>}
          </ul>

          {decisions.length > 0 && (
            <>
              <h2 className="eyebrow mt-8 border-b border-line-subtle pb-2">Choices made</h2>
              <ul className="divide-y divide-line-subtle">
                {decisions.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => openNote(n.id)} className="press flex w-full items-baseline gap-2 py-2.5 text-left">
                      <NoteKindTag note={n} />
                      <span className="text-[13px] leading-snug text-ink-2">{n.title}</span>
                      {n.alternatives.length > 0 && <span className="ml-auto shrink-0 font-mono text-2xs text-ink-4">vs {n.alternatives.length}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
      {shapes.length > 0 && (
        <section className="mt-12">
          <h2 className="eyebrow flex border-b border-line-subtle pb-2">
            Shapes {review.mode === "teach" ? "it exposes" : "this change introduces or alters"}
            <span className="ml-auto font-mono normal-case tracking-normal text-ink-4">{shapes.length}</span>
          </h2>
          <ul className="divide-y divide-line-subtle">
            {shapes.map((s) => {
              const users = (index.into.get(s.id) ?? []).length;
              const choice = (index.notesBySymbol.get(s.id) ?? []).find((n) => n.kind === "decision" || n.kind === "why");
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => openSymbol(s.id)}
                    onPointerEnter={(e) => hover.show(e.currentTarget.getBoundingClientRect(), { type: "symbol", id: s.id })}
                    onPointerLeave={hover.hide}
                    className="press grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <StatusMark status={s.status} />
                        <span className="font-mono text-[13px] text-ink">{s.name}</span>
                        <span className="truncate font-mono text-2xs text-ink-3">{s.file}</span>
                      </span>
                      {s.signature && <pre className="mt-1.5 max-h-28 overflow-hidden whitespace-pre-wrap pl-[18px] font-mono text-[11.5px] leading-[18px] text-ink-3">{s.signature}</pre>}
                      {choice && (
                        <span className="mt-1.5 flex items-baseline gap-2 pl-[18px]">
                          <NoteKindTag note={choice} />
                          <span className="text-[12.5px] text-ink-2">{choice.title}</span>
                        </span>
                      )}
                    </span>
                    <span className="pt-0.5 font-mono text-2xs text-ink-3">
                      {users ? (
                        <>
                          used by <span className="text-ink-2">{users}</span>
                        </>
                      ) : (
                        "unused yet"
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mx-auto max-w-[52rem] space-y-3 px-10 pt-12" aria-busy>
      <div className="h-3 w-40 rounded bg-pane" />
      <div className="h-7 w-2/3 rounded bg-pane" />
      <div className="mt-8 h-24 rounded bg-pane" />
    </div>
  );
}
