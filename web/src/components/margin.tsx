// The margin: what goes to GitHub on top, then your private threads with the
// agent, plus a way to ask more. The agent hears what's written here through
// `downstream wait`; nobody else reads a thread unless its blue card says so.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Lock, RotateCcw, X } from "lucide-react";
import type { Note, Presence } from "@domain/model.ts";
import { goesOut } from "@domain/outgoing.ts";
import type { AgentView } from "@domain/agent.ts";
import { delivery, type Delivery } from "@domain/delivery.ts";
import { action } from "../lib/api.ts";
import { useReview } from "../lib/review.tsx";
import { displayName, severityRank } from "../lib/graph.ts";
import { AuthorTag, NoteKindTag, NoteNumber, SeverityMark } from "./marks.tsx";
import { Markdown } from "./markdown.tsx";
import { useHover } from "./hover.tsx";
import { timeAgo } from "../lib/time.ts";
import { navigate } from "../lib/route.ts";
import { Approvals, MoveToTerminal, STATUS_TEXT, StatusDot } from "./agent.tsx";
import { AuthorCard, Outbox, PostCard } from "./outbox.tsx";

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

export function Margin({ agent, onSend }: { agent: AgentView | null; onSend: () => void }) {
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
      {agent && <AgentStrip agent={agent} />}
      <Outbox onSend={onSend} />
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <Lock size={12} className="text-ink-4" />
        <h2 className="text-[13px] font-medium text-ink-2">You and the agent</h2>
        <span className="font-mono text-2xs text-ink-4">{openCount} open</span>
        {notes.length > openCount && (
          <button type="button" onClick={() => setFilter((f) => (f === "open" ? "all" : "open"))} aria-pressed={filter === "all"} className="press ml-auto rounded-md px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink-2">
            {filter === "open" ? "Show settled" : "Hide settled"}
          </button>
        )}
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
            <p className="mt-1 text-[12.5px] text-ink-3">Select lines in the code and ask below.</p>
          </div>
        ) : (
          <>
            {here.length > 0 && <Group label="On this trail" notes={here} />}
            {elsewhere.length > 0 && <Group label={here.length ? "Elsewhere" : null} notes={elsewhere} folded={here.length > 0 && !elsewhere.some((n) => n.id === noteId)} />}
          </>
        )}
      </div>
      <Composer />
    </aside>
  );
}

function Group({ label, notes, folded = false }: { label: string | null; notes: Note[]; folded?: boolean }) {
  const [open, setOpen] = useState(!folded);
  useEffect(() => setOpen(!folded), [folded]);
  return (
    <section className="mb-3">
      {label &&
        (folded ? (
          <button type="button" onClick={() => setOpen((o) => !o)} className="press eyebrow flex w-full items-center gap-1.5 px-2 pb-1 pt-2 hover:text-ink-2" aria-expanded={open}>
            {label} <span className="font-mono normal-case tracking-normal text-ink-4">{notes.length}</span>
            <span className="ml-auto font-mono normal-case tracking-normal">{open ? "hide" : "show"}</span>
          </button>
        ) : (
          <h3 className="eyebrow px-2 pb-1 pt-2">{label}</h3>
        ))}
      {open && <ul className="space-y-1">
        {notes.map((n) => (
          <Thread key={n.id} note={n} />
        ))}
      </ul>}
    </section>
  );
}

function Thread({ note }: { note: Note }) {
  const { noteId, openNote, index, state, presence } = useReview();
  const hover = useHover();
  const open = noteId === note.id;
  const ref = useRef<HTMLLIElement>(null);
  const symbol = note.symbolId ? index?.byId.get(note.symbolId) : null;
  const agent = note.author === "agent";
  const lastAuthor = note.replies.at(-1)?.author ?? note.author;
  const yourTurn = note.status === "open" && lastAuthor === "agent" && (note.kind === "question" || note.replies.length > 0);
  const standing = delivery(note, state?.readThrough ?? null, presence);

  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);

  return (
    <li ref={ref} className={`rounded-lg border ${open ? "border-line bg-pane" : "border-transparent hover:bg-pane/60"}`}>
      <button type="button" onClick={() => openNote(open ? null : note.id)} className="press flex w-full items-start gap-2 px-2.5 py-2 text-left" aria-expanded={open}>
        <span className="mt-[5px]">{note.kind === "finding" ? <SeverityMark severity={note.severity} author={note.author} /> : <span className={`block size-2 rounded-full ${agent ? "bg-agent/70" : "bg-ink-3"}`} />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <NoteNumber note={note} />
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
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {yourTurn && <span className="font-mono text-2xs text-agent">your turn</span>}
              {state?.review.pr && goesOut(note) && <span className="rounded border border-out-line px-1 font-mono text-2xs text-out" title="Its comment is in the review you send">in review</span>}
              {standing === "stalled" && <span className={`font-mono text-2xs ${DELIVERY_TAG.stalled.tone}`}>{DELIVERY_TAG.stalled.label}</span>}
            </span>
          </span>
          <span className={`mt-0.5 block text-[13.5px] leading-snug ${note.status === "open" ? "text-ink" : goesOut(note) ? "text-ink-2" : "text-ink-3 line-through decoration-ink-4"}`}>{note.title}</span>
        </span>
        {!open && note.replies.length > 0 && <span className="mt-0.5 font-mono text-2xs text-ink-3">{note.replies.length}</span>}
      </button>
      {open && <ThreadBody note={note} standing={standing} presence={presence} />}
    </li>
  );
}

const DELIVERY_TAG: Record<Delivery, { label: string; tone: string }> = {
  unread: { label: "unread", tone: "text-ink-3" },
  answering: { label: "answering…", tone: "text-agent" },
  read: { label: "read", tone: "text-ink-3" },
  stalled: { label: "stalled", tone: "text-del" },
};

/** The line under your last message: did the agent get it, and is it doing anything about it. */
function DeliveryLine({ standing, presence }: { standing: Delivery; presence: Presence }) {
  const wait = <code className="font-mono text-ink-2">downstream wait</code>;
  const text =
    standing === "answering" ? (
      "The agent has this and is working on it."
    ) : standing === "read" ? (
      "The agent read this."
    ) : standing === "stalled" ? (
      "The agent read this, then stopped before replying. Check its terminal."
    ) : presence.agent === "listening" ? (
      "Sending to the agent…"
    ) : presence.agent === "working" ? (
      <>The agent is busy. It reads this when it next runs {wait}.</>
    ) : (
      <>No agent is listening. It reads this on its next {wait}.</>
    );
  const dot = standing === "answering" ? "bg-agent motion-safe:animate-pulse" : standing === "stalled" ? "bg-del" : standing === "read" ? "bg-agent/50" : "bg-ink-4";
  return (
    <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-ink-3" role="status">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span>{text}</span>
    </p>
  );
}

function ThreadBody({ note, standing, presence }: { note: Note; standing: Delivery | null; presence: Presence }) {
  const { state } = useReview();
  const posts = (state?.review.posts ?? []).filter((p) => p.noteId === note.id);
  // Going out in the agent's own words: the note is the comment, so it's shown once, as the card.
  const asWritten = !!state?.review.pr && goesOut(note) && !note.outgoing?.body.trim();
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

  return (
    <div className="fade-in px-3 pb-3">
      <div className={`flex items-center gap-2 ${note.body ? "pb-1.5" : ""}`}>
        <AuthorTag author={note.author} />
        <span className="font-mono text-2xs text-ink-4">{timeAgo(note.createdAt)}</span>
      </div>
      {asWritten ? (
        <AuthorCard note={note} onError={setError} />
      ) : (
        <>
          {note.body && <div className={note.author === "agent" ? "voice" : ""}><Markdown text={note.body} /></div>}
          {note.fix && <Labeled label="Fix" text={note.fix} />}
          {note.impact && <Labeled label="If we skip it" text={note.impact} />}
        </>
      )}
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
      {note.suggestion && !asWritten && <SuggestionBlock suggestion={note.suggestion} />}
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
      {standing && <DeliveryLine standing={standing} presence={presence} />}
      {!asWritten && <AuthorCard note={note} onError={setError} />}
      {posts.map((p) => (
        <div key={p.id} className="mt-2">
          <PostCard post={p} />
        </div>
      ))}
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
          placeholder="Reply to the agent (private)…"
          className="block w-full resize-none rounded-md border border-line bg-page px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
        />
        {error && <p className="mt-1 text-[12px] text-del">{error}</p>}
        <div className="mt-1.5 flex items-center gap-1">
          <Settle note={note} reason={draft} onSettled={() => setDraft("")} onError={setError} />
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

function Composer() {
  const { selection, trail, index, setSelection, openNote } = useReview();
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
      const note = await action<Note>("ask", { body, symbolId: s?.id ?? null, file: selection?.file ?? s?.file ?? null, lines: selection?.lines ?? null, side: selection?.side ?? "new" });
      setDraft("");
      setSelection(null);
      openNote(note.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-line-subtle bg-pane px-3 pb-3 pt-2.5">
      <div className="flex items-center gap-1.5 pb-2">
        <Lock size={11} className="shrink-0 text-ink-4" />
        <span className="shrink-0 text-[12px] text-ink-2">Ask the agent</span>
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
        Ask the agent
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
          placeholder="Private to you and the agent. To tell the author something, ask the agent to draft it."
          className="block w-full resize-none rounded-md border border-line bg-page px-2.5 py-2 pr-11 text-[13px] text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!draft.trim() || busy}
          className="press absolute bottom-2 right-2 grid size-7 place-items-center rounded-md bg-ink text-page hover:bg-white disabled:opacity-25"
          title="Ask (⌘↵)"
        >
          <ArrowUp size={14} />
        </button>
      </div>
      {error && <p className="mt-1 text-[12px] text-del">{error}</p>}
    </div>
  );
}

/** The agent Downstream is running for this review: what it's doing, and anything waiting on your approval. */
function AgentStrip({ agent }: { agent: AgentView }) {
  const last = [...agent.activity].reverse().find((a) => a.kind === "tool" || a.kind === "text");
  const line = last ? (last.kind === "tool" ? last.summary : last.kind === "text" ? last.text.split("\n")[0] : "") : "";
  return (
    <section className="space-y-2 border-b border-line-subtle px-3 py-2.5" aria-label="Agent">
      <div className="flex items-center gap-2">
        <StatusDot status={agent.status} />
        <button type="button" onClick={() => navigate(`/s/${encodeURIComponent(agent.key)}`)} className="press min-w-0 flex-1 truncate text-left text-[12.5px] text-ink-3 hover:text-ink-2" title="Everything the agent did">
          <span className="text-ink-2">{STATUS_TEXT[agent.status]}</span>
          {line && agent.status !== "idle" ? ` · ${line}` : ""}
        </button>
        <MoveToTerminal view={agent} />
      </div>
      <Approvals view={agent} />
    </section>
  );
}

function Labeled({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-2.5">
      <p className="eyebrow pb-0.5">{label}</p>
      <Markdown text={text} />
    </div>
  );
}

/**
 * Settling ends the conversation in a thread; it doesn't change whether the
 * author sees it (that's the blue card). The server pins that choice on settle.
 */
function Settle({ note, reason, onSettled, onError }: { note: Note; reason: string; onSettled: () => void; onError: (e: string | null) => void }) {
  const change = async (status: "resolved" | "open") => {
    onError(null);
    try {
      await action("note.status", { noteId: note.id, status, reason: status === "resolved" ? reason.trim() || undefined : undefined });
      onSettled();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return note.status === "open" ? (
    <button type="button" onClick={() => void change("resolved")} className="press flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink" title={reason.trim() ? "Settle, with your text as the last word" : "Nothing left to discuss here"}>
      <Check size={12} /> Settle
    </button>
  ) : (
    <button type="button" onClick={() => void change("open")} className="press flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink">
      <RotateCcw size={11} /> {note.status === "dismissed" ? "Dismissed" : "Settled"} · reopen
    </button>
  );
}

function SuggestionBlock({ suggestion }: { suggestion: NonNullable<Note["suggestion"]> }) {
  const [open, setOpen] = useState(false);
  const lines = suggestion.code.split("\n").length;
  return (
    <div className="mt-2.5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="press eyebrow flex items-center gap-1.5 hover:text-ink-2" aria-expanded={open}>
        Suggested change <span className="font-mono normal-case tracking-normal text-ink-4">lines {suggestion.lines.start}–{suggestion.lines.end} · {lines} line{lines === 1 ? "" : "s"}</span>
        <span className="font-mono normal-case tracking-normal">{open ? "hide" : "show"}</span>
      </button>
      {open && <pre className="mt-1 overflow-x-auto rounded-md border border-line-subtle bg-code px-2.5 py-2 font-mono text-[12px] leading-5 text-ink-2">{suggestion.code}</pre>}
    </div>
  );
}
