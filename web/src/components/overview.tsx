// The overview: the change in one breath, before any code. Only what needs a
// decision is open; everything else is one line until you ask for it.
import { useState, type ReactNode } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { CodeSymbol, Note } from "@domain/model.ts";
import { useReview } from "../lib/review.tsx";
import { displayName, severityRank } from "../lib/graph.ts";
import { Markdown } from "./markdown.tsx";
import { NoteKindTag, NoteNumber, SeverityMark, StatusMark } from "./marks.tsx";
import { useHover } from "./hover.tsx";

export function Overview() {
  const { state, index, openStep, openSymbol, openNote } = useReview();
  const hover = useHover();
  if (!state || !index) return <OverviewSkeleton />;
  const { review, files, symbols, notes, steps } = state;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const code = symbols.filter((s) => !s.test);
  const changed = code.filter((s) => s.status !== "context");
  const tests = symbols.filter((s) => s.test && s.status !== "context");
  const findings = notes.filter((n) => n.kind === "finding" && n.status === "open").sort((a, b) => severityRank[a.severity ?? "concern"] - severityRank[b.severity ?? "concern"] || a.number - b.number);
  const waiting = notes.filter((n) => n.kind === "question" && n.status === "open" && n.author === "agent");
  const decisions = notes.filter((n) => n.kind === "decision" || n.kind === "why");
  const counts = (["added", "modified", "removed"] as const).map((k) => [k, changed.filter((s) => s.status === k).length] as const).filter(([, n]) => n > 0);
  // The contracts this change introduces or alters: judge these before the code that fills them in.
  const shapes = code.filter((s) => (s.kind === "interface" || s.kind === "type" || s.kind === "class") && (review.mode === "teach" ? s.exported : s.status !== "context"));
  const nonCode = changed.filter((s) => s.kind === "module");

  const start = () => (steps[0] ? openStep(steps[0].id) : index.entries[0] ? openSymbol(index.entries[0].id) : undefined);
  const symbolButton = (s: CodeSymbol, children: ReactNode, className = "") => (
    <button
      type="button"
      onClick={() => openSymbol(s.id)}
      onPointerEnter={(e) => hover.show(e.currentTarget.getBoundingClientRect(), { type: "symbol", id: s.id })}
      onPointerLeave={hover.hide}
      className={`press w-full text-left ${className}`}
    >
      {children}
    </button>
  );

  return (
    <div className="mx-auto max-w-[50rem] px-6 pb-24 pt-10 md:px-10">
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
        {tests.length > 0 && (
          <div>
            <dd>
              <span className="text-ink-2">{tests.length}</span> test{tests.length === 1 ? "" : "s"}
            </dd>
          </div>
        )}
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
              It appears here as soon as it runs <code className="font-mono text-ink-2">downstream apply</code>. The map already works: {changed.length} changed symbols.
            </p>
          </div>
        )}
        <button type="button" onClick={start} disabled={!steps.length && !index.entries.length} className="press mt-6 inline-flex items-center gap-2 rounded-md bg-ink px-3.5 py-2 text-[13.5px] font-medium text-page hover:bg-white disabled:opacity-30">
          {steps.length ? `Walk through it, ${steps.length} steps` : "Start at the first door"}
          <ArrowRight size={15} />
        </button>
      </section>

      {(findings.length > 0 || waiting.length > 0) && (
        <section className="mt-12">
          <h2 className="eyebrow flex border-b border-line-subtle pb-2">
            Needs your eyes <span className="ml-auto font-mono normal-case tracking-normal text-ink-4">{findings.length + waiting.length}</span>
          </h2>
          <ul className="divide-y divide-line-subtle">
            {[...findings, ...waiting].map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => openNote(n.id)} className="press grid w-full grid-cols-[2.25rem_minmax(0,1fr)] items-baseline py-2.5 text-left">
                  <NoteNumber note={n} />
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-2">
                      {n.kind === "finding" ? <SeverityMark severity={n.severity} author={n.author} /> : <span className="size-2 shrink-0 rounded-full bg-agent/70" />}
                      <NoteKindTag note={n} />
                      <span className="text-[13.5px] leading-snug text-ink">{n.title}</span>
                    </span>
                    {n.kind === "question" && <span className="mt-0.5 block pl-4 text-[12.5px] text-ink-3">The agent needs your answer to judge this.</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="eyebrow border-b border-line-subtle pb-2">Doors into this change</h2>
        <ul className="divide-y divide-line-subtle">
          {index.entries.map((s) => (
            <li key={s.id}>
              {symbolButton(
                s,
                <>
                  <span className="flex items-center gap-2">
                    <StatusMark status={s.status} />
                    <span className="font-mono text-[13px] text-ink">{displayName(s)}</span>
                    <span className="truncate font-mono text-2xs text-ink-3">{s.file}</span>
                  </span>
                  {s.summary && <span className="mt-0.5 block pl-[18px] text-[13px] text-ink-3">{s.summary}</span>}
                </>,
                "py-2.5",
              )}
            </li>
          ))}
          {index.entries.length === 0 && <li className="py-2.5 text-[13px] text-ink-3">None marked yet.</li>}
        </ul>
      </section>

      <div className="mt-8 border-t border-line-subtle">
        {shapes.length > 0 && (
          <Fold label={review.mode === "teach" ? "Shapes it exposes" : "Shapes introduced or altered"} count={shapes.length} preview={shapes.map((s) => s.name).join(", ")}>
            <ul className="divide-y divide-line-subtle">
              {shapes.map((s) => {
                const users = (index.into.get(s.id) ?? []).filter((e) => !index.byId.get(e.from)?.test).length;
                const choice = (index.notesBySymbol.get(s.id) ?? []).find((n) => n.kind === "decision" || n.kind === "why");
                return (
                  <li key={s.id}>
                    {symbolButton(
                      s,
                      <span className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4">
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
                        <span className="pt-0.5 font-mono text-2xs text-ink-3">{users ? `used by ${users}` : "unused yet"}</span>
                      </span>,
                      "py-3",
                    )}
                  </li>
                );
              })}
            </ul>
          </Fold>
        )}
        {decisions.length > 0 && (
          <Fold label="Choices made" count={decisions.length} preview={decisions.map((n) => n.title).join(" · ")}>
            <NoteList notes={decisions} onOpen={openNote} />
          </Fold>
        )}
        {tests.length > 0 && (
          <Fold label="Tests" count={tests.length} preview={tests.map((s) => s.name).join(", ")}>
            <ul className="divide-y divide-line-subtle">
              {tests.map((s) => (
                <li key={s.id}>
                  {symbolButton(
                    s,
                    <span className="flex items-center gap-2">
                      <StatusMark status={s.status} />
                      <span className="font-mono text-[12.5px] text-ink-2">{displayName(s)}</span>
                      <span className="truncate font-mono text-2xs text-ink-4">{s.file}</span>
                    </span>,
                    "py-2",
                  )}
                </li>
              ))}
            </ul>
          </Fold>
        )}
        {nonCode.length > 0 && (
          <Fold label="Other files" count={nonCode.length} preview={nonCode.map((s) => s.file).join(", ")}>
            <ul className="divide-y divide-line-subtle">
              {nonCode.map((s) => (
                <li key={s.id}>{symbolButton(s, <span className="font-mono text-[12.5px] text-ink-2">{s.file}</span>, "py-2")}</li>
              ))}
            </ul>
          </Fold>
        )}
      </div>
    </div>
  );
}

/** One line until opened: label, count, and a preview of what's inside. */
function Fold({ label, count, preview, children }: { label: string; count: number; preview: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-b border-line-subtle">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="press grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-3 py-3 text-left">
        <span className="eyebrow flex items-center gap-1.5">
          <ChevronRight size={12} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          {label}
        </span>
        <span className="font-mono text-2xs text-ink-4">{count}</span>
        {!open && <span className="truncate text-[12.5px] text-ink-3">{preview}</span>}
      </button>
      {open && <div className="fade-in pb-4">{children}</div>}
    </section>
  );
}

function NoteList({ notes, onOpen }: { notes: Note[]; onOpen: (id: string) => void }) {
  return (
    <ul className="divide-y divide-line-subtle">
      {notes.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={() => onOpen(n.id)} className="press flex w-full items-baseline gap-2 py-2.5 text-left">
            <NoteNumber note={n} />
            <NoteKindTag note={n} />
            <span className="text-[13px] leading-snug text-ink-2">{n.title}</span>
            {n.alternatives.length > 0 && <span className="ml-auto shrink-0 font-mono text-2xs text-ink-4">vs {n.alternatives.length}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mx-auto max-w-[50rem] space-y-3 px-10 pt-12" aria-busy>
      <div className="h-3 w-40 rounded bg-pane" />
      <div className="h-7 w-2/3 rounded bg-pane" />
      <div className="mt-8 h-24 rounded bg-pane" />
    </div>
  );
}
