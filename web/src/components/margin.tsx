// The margin: everything said about the code, threaded, plus a way to say more.
// The agent hears what's written here through `downstream wait`.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, RotateCcw, X } from "lucide-react";
import type { Note, Severity } from "@domain/model.ts";
import { action } from "../lib/api.ts";
import { useReview } from "../lib/review.tsx";
import { displayName, severityRank } from "../lib/graph.ts";
import { AuthorTag, NoteKindTag, SeverityMark } from "./marks.tsx";
import { Markdown } from "./markdown.tsx";
import { useHover } from "./hover.tsx";

type Filter = "open" | "all";

function rank(n: Note): number {
  const waiting = n.status === "open" && (n.replies.at(-1)?.author ?? n.author) === "agent" && (n.kind === "question" || n.replies.length > 0) ? -1 : 0;
  if (n.status !== "open") return 10;
  if (n.kind === "finding") return severityRank[n.severity ?? "concern"] + waiting;
  if (n.kind === "question") return 3 + waiting;
  if (n.kind === "decision") return 4;
  if (n.kind === "why") return 5;
  return 6;
}

export function Margin() {
  const { state, trail, noteId } = useReview();
  const [filter, setFilter] = useState<Filter>("open");
  const notes = state?.notes ?? [];
  const onTrail = new Set(trail);

  const sorted = useMemo(
    () => [...notes].filter((n) => filter === "all" || n.status === "open" || n.id === noteId).sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt)),
    [notes, filter, noteId],
  );
  const here = sorted.filter((n) => n.symbolId && onTrail.has(n.symbolId));
  const elsewhere = sorted.filter((n) => !(n.symbolId && onTrail.has(n.symbolId)));
  const openCount = notes.filter((n) => n.status === "open").length;

  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label="Conversation">
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
        <h2 className="eyebrow">Conversation</h2>
        <span className="font-mono text-2xs text-ink-3">{openCount} open</span>
        <div className="ml-auto flex rounded-md border border-line-subtle p-0.5">
          {(["open", "all"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={`press rounded-[4px] px-2 py-0.5 text-[12px] capitalize ${filter === f ? "bg-overlay text-ink" : "text-ink-3 hover:text-ink-2"}`}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {!state ? (
          <div className="space-y-2 p-2">
            {[80, 64, 72].map((w, i) => (
              <div key={i} className="h-12 rounded-md bg-pane" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="px-3 py-8">
            <p className="text-[13px] text-ink-2">{notes.length ? "Every thread is settled." : "Nothing said yet."}</p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Select lines in a frame and ask below. The agent writes here with <code className="font-mono text-ink-2">downstream note</code> and answers with{" "}
              <code className="font-mono text-ink-2">downstream reply</code>.
            </p>
          </div>
        ) : (
          <>
            {here.length > 0 && <Group label="On this trail" notes={here} />}
            {elsewhere.length > 0 && <Group label={here.length ? "Elsewhere" : null} notes={elsewhere} />}
          </>
        )}
      </div>
      <Composer />
    </aside>
  );
}

function Group({ label, notes }: { label: string | null; notes: Note[] }) {
  return (
    <section className="mb-3">
      {label && <h3 className="eyebrow px-2 pb-1 pt-2">{label}</h3>}
      <ul className="space-y-1">
        {notes.map((n) => (
          <Thread key={n.id} note={n} />
        ))}
      </ul>
    </section>
  );
}

function Thread({ note }: { note: Note }) {
  const { noteId, openNote, index } = useReview();
  const hover = useHover();
  const open = noteId === note.id;
  const ref = useRef<HTMLLIElement>(null);
  const symbol = note.symbolId ? index?.byId.get(note.symbolId) : null;
  const agent = note.author === "agent";
  const lastAuthor = note.replies.at(-1)?.author ?? note.author;
  const yourTurn = note.status === "open" && lastAuthor === "agent" && (note.kind === "question" || note.replies.length > 0);

  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);

  return (
    <li ref={ref} className={`rounded-lg border ${open ? "border-line bg-pane" : "border-transparent hover:bg-pane/60"}`}>
      <button type="button" onClick={() => openNote(open ? null : note.id)} className="press flex w-full items-start gap-2 px-2.5 py-2 text-left" aria-expanded={open}>
        <span className="mt-[5px]">{note.kind === "finding" ? <SeverityMark severity={note.severity} author={note.author} /> : <span className={`block size-2 rounded-full ${agent ? "bg-agent/70" : "bg-ink-3"}`} />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <NoteKindTag note={note} />
            {symbol && (
              <span
                className="truncate font-mono text-2xs text-ink-3"
                onPointerEnter={(e) => hover.show(e.currentTarget.getBoundingClientRect(), { type: "symbol", id: symbol.id })}
                onPointerLeave={hover.hide}
              >
                {displayName(symbol)}
                {note.lines ? `:${note.lines.start}` : ""}
              </span>
            )}
            {yourTurn && <span className="ml-auto shrink-0 font-mono text-2xs text-agent">your turn</span>}
          </span>
          <span className={`mt-0.5 block text-[13.5px] leading-snug ${note.status === "open" ? "text-ink" : "text-ink-3 line-through decoration-ink-4"}`}>{note.title}</span>
        </span>
        {!open && note.replies.length > 0 && <span className="mt-0.5 font-mono text-2xs text-ink-3">{note.replies.length}</span>}
      </button>
      {open && <ThreadBody note={note} />}
    </li>
  );
}

function ThreadBody({ note }: { note: Note }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await action("note.reply", { noteId: note.id, body: draft.trim() });
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status = async (s: Note["status"]) => {
    setError(null);
    try {
      await action("note.status", { noteId: note.id, status: s, reason: draft.trim() || undefined });
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="fade-in px-3 pb-3">
      <div className={`flex items-center gap-2 ${note.body ? "pb-1.5" : ""}`}>
        <AuthorTag author={note.author} />
        <span className="font-mono text-2xs text-ink-4">{timeAgo(note.createdAt)}</span>
      </div>
      {note.body && <div className={note.author === "agent" ? "voice" : ""}><Markdown text={note.body} /></div>}
      {note.alternatives.length > 0 && (
        <div className="mt-2.5 rounded-md border border-line-subtle">
          <p className="eyebrow border-b border-line-subtle px-2.5 py-1.5">Considered instead</p>
          <ul className="divide-y divide-line-subtle">
            {note.alternatives.map((a, i) => (
              <li key={i} className="px-2.5 py-2">
                <p className="text-[13px] text-ink">{a.option}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-3">{a.tradeoff}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.suggestion && (
        <div className="mt-2.5">
          <p className="eyebrow pb-1">
            Suggested for lines {note.suggestion.lines.start}–{note.suggestion.lines.end}
          </p>
          <pre className="overflow-x-auto rounded-md border border-line-subtle bg-code px-2.5 py-2 font-mono text-[12px] leading-5 text-ink-2">{note.suggestion.code}</pre>
        </div>
      )}
      {note.replies.length > 0 && (
        <ol className="mt-3 space-y-2.5 border-t border-line-subtle pt-2.5">
          {note.replies.map((r) => (
            <li key={r.id} className={r.author === "agent" ? "voice" : "pl-[calc(0.75rem+2px)]"}>
              <div className="flex items-center gap-2 pb-0.5">
                <AuthorTag author={r.author} />
                <span className="font-mono text-2xs text-ink-4">{timeAgo(r.createdAt)}</span>
              </div>
              <Markdown text={r.body} />
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3">
        <label className="sr-only" htmlFor={`reply-${note.id}`}>
          Reply
        </label>
        <textarea
          id={`reply-${note.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          rows={2}
          placeholder={note.kind === "decision" ? "Push back, or agree…" : note.author === "agent" ? "Reply to the agent…" : "Add to this…"}
          className="block w-full resize-none rounded-md border border-line bg-page px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
        />
        {error && <p className="mt-1 text-[12px] text-del">{error}</p>}
        <div className="mt-1.5 flex items-center gap-1">
          {note.status === "open" ? (
            <>
              <button type="button" onClick={() => void status("resolved")} className="press flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-overlay hover:text-ink" title={draft ? "Resolve, with your text as the reason" : "Resolve"}>
                <Check size={13} /> Resolve
              </button>
              <button type="button" onClick={() => void status("dismissed")} className="press flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink-2">
                <X size={13} /> Dismiss
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void status("open")} className="press flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-overlay">
              <RotateCcw size={12} /> Reopen
            </button>
          )}
          <button
            type="button"
            disabled={!draft.trim() || busy}
            onClick={() => void send()}
            className="press ml-auto flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 text-[12px] font-medium text-page hover:bg-white disabled:opacity-30"
          >
            Reply <span className="font-mono text-[10px] opacity-60">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

type Mode = "ask" | "flag" | "note";

function Composer() {
  const { selection, trail, index, presence, setSelection, openNote } = useReview();
  const [mode, setMode] = useState<Mode>("ask");
  const [severity, setSeverity] = useState<Severity>("concern");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const focusSymbol = selection?.symbolId ?? trail.at(-1) ?? null;
  const s = focusSymbol ? index?.byId.get(focusSymbol) : null;
  const anchor = selection ? `${s ? displayName(s) : selection.file} · lines ${selection.lines.start}–${selection.lines.end}` : s ? displayName(s) : "the whole change";

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const where = { symbolId: s?.id ?? null, file: selection?.file ?? s?.file ?? null, lines: selection?.lines ?? null, side: selection?.side ?? "new" };
      const title = body.split("\n")[0]!.slice(0, 120);
      const rest = body.length > title.length ? body : "";
      const note =
        mode === "ask"
          ? await action<Note>("ask", { body, ...where })
          : await action<Note>("note.add", { kind: mode === "flag" ? "finding" : "comment", severity: mode === "flag" ? severity : null, title, body: rest, ...where });
      setDraft("");
      setSelection(null);
      openNote(note.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const presenceText =
    presence.agent === "listening" ? (
      "The agent is listening and will answer here."
    ) : presence.agent === "working" ? (
      "The agent is working. It'll see this when it next checks in."
    ) : (
      <>
        The agent isn't listening. It reads this on its next <code className="font-mono text-ink-2">downstream wait</code>.
      </>
    );

  return (
    <div className="border-t border-line-subtle bg-pane px-3 pb-3 pt-2.5">
      <div className="flex items-center gap-1 pb-2">
        {(
          [
            ["ask", "Ask"],
            ["flag", "Flag"],
            ["note", "Note"],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={`press rounded-md px-2 py-0.5 text-[12px] ${mode === m ? "bg-overlay text-ink" : "text-ink-3 hover:text-ink-2"}`}>
            {label}
          </button>
        ))}
        {mode === "flag" && (
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className="ml-1 rounded-md border border-line bg-page px-1.5 py-0.5 font-mono text-2xs text-ink-2 focus:outline-none" aria-label="Severity">
            <option value="blocker">blocker</option>
            <option value="concern">concern</option>
            <option value="nit">nit</option>
          </select>
        )}
        <span className="ml-auto truncate pl-2 font-mono text-2xs text-ink-3" title={anchor}>
          on {anchor}
        </span>
        {selection && (
          <button type="button" onClick={() => setSelection(null)} className="press rounded p-0.5 text-ink-4 hover:text-ink-2" title="Clear selection">
            <X size={12} />
          </button>
        )}
      </div>
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <div className="relative">
        <textarea
          id="composer"
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          rows={3}
          placeholder={mode === "ask" ? "Why is it like this? What calls this? Is this the right abstraction?" : mode === "flag" ? "What's wrong here?" : "A note for the record…"}
          className="block w-full resize-none rounded-md border border-line bg-page px-2.5 py-2 pr-11 text-[13px] text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!draft.trim() || busy}
          className="press absolute bottom-2 right-2 grid size-7 place-items-center rounded-md bg-ink text-page hover:bg-white disabled:opacity-25"
          title="Send (⌘↵)"
        >
          <ArrowUp size={14} />
        </button>
      </div>
      {error && <p className="mt-1 text-[12px] text-del">{error}</p>}
      <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
        <span className={`size-1.5 rounded-full ${presence.agent === "listening" ? "bg-agent" : presence.agent === "working" ? "bg-agent/50" : "bg-ink-4"}`} />
        {presenceText}
      </p>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 50) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
