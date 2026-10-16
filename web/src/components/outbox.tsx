// Everything that leaves Downstream, in blue, apart from the conversation.
// The threads are you and the agent; these cards are what other people read,
// shown in the exact words they'll get, before anything is sent.
import { useEffect, useState } from "react";
import { Check, ExternalLink, Lock, Pencil, RotateCcw, Send, Trash2 } from "lucide-react";
import type { Note, Post } from "@domain/model.ts";
import { commentBody, goesOut, unposted } from "@domain/outgoing.ts";
import { action } from "../lib/api.ts";
import { useReview } from "../lib/review.tsx";
import { Markdown } from "./markdown.tsx";

const VERDICT: Record<string, string> = { approve: "Approve", changes: "Request changes", comment: "Comment" };

/** The top of the margin: what's waiting to go out, and the one button that sends each. */
export function Outbox({ onSend }: { onSend: () => void }) {
  const { state } = useReview();
  if (!state) return null;
  const { review, notes } = state;
  const comments = notes.filter(goesOut).length;
  const posts = review.posts;
  const left = unposted(posts).length + (review.published || !review.pr ? 0 : 1);
  const verdict = (review.verdicts.find((v) => v.by === "user") ?? review.verdicts.find((v) => v.by === "agent"))?.value ?? "comment";

  return (
    <section className="border-b border-line-subtle px-3 py-2.5" aria-label="Outbox">
      <div className="flex items-baseline gap-2 pb-1.5">
        <h2 className="eyebrow text-out">Goes to GitHub</h2>
        <span className="text-[11.5px] text-ink-3">{left ? "nothing has left yet" : "all sent"}</span>
      </div>
      <ul className="space-y-1">
        {review.pr && (
          <li className="flex items-center gap-2 rounded-md border border-out-line bg-out-wash px-2.5 py-1.5">
            <Send size={12} className="shrink-0 text-out" />
            <span className="min-w-0 flex-1 text-[12.5px] leading-tight text-ink">
              Review on #{review.pr}
              <span className="block truncate text-[11.5px] text-ink-3">
                {VERDICT[review.published?.event === "APPROVE" ? "approve" : review.published?.event === "REQUEST_CHANGES" ? "changes" : review.published ? "comment" : verdict]} · body + {review.published?.comments ?? comments} comment{(review.published?.comments ?? comments) === 1 ? "" : "s"}
              </span>
            </span>
            {review.published ? (
              <a href={review.published.url} target="_blank" rel="noreferrer" className="press flex shrink-0 items-center gap-1 text-[12px] text-ink-2 hover:text-ink">
                <Check size={12} /> Sent <ExternalLink size={11} />
              </a>
            ) : (
              <button type="button" onClick={onSend} className="press shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium text-out hover:bg-overlay">
                Review & send…
              </button>
            )}
          </li>
        )}
        {posts.map((p) => (
          <li key={p.id}>
            <PostCard post={p} compact />
          </li>
        ))}
      </ul>
      {!review.pr && posts.length === 0 && <p className="text-[12px] text-ink-3">Not a pull request review: nothing here can be sent. Copy it as markdown from Send.</p>}
    </section>
  );
}

/** A comment for another pull request: drafted here, posted on its own, only when you press Post. */
export function PostCard({ post, compact = false }: { post: Post; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(post.body);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(post.body), [post.body]);
  const { state, openNote } = useReview();
  const from = post.noteId ? state?.notes.find((n) => n.id === post.noteId) : null;

  const run = async (name: string, input: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action(name, input);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-out-line bg-out-wash">
      <button type="button" onClick={() => setOpen((o) => !o)} className="press flex w-full items-center gap-2 px-2.5 py-1.5 text-left" aria-expanded={open}>
        <Send size={12} className="shrink-0 text-out" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
          Comment on {post.repo === state?.review.repo ? "" : post.repo}#{post.number}
          {compact && from && <span className="text-ink-3"> · from thread #{from.number}</span>}
        </span>
        {post.posted ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-2">
            <Check size={12} /> Posted
          </span>
        ) : (
          <span className="shrink-0 text-[12px] text-out">{open ? "hide" : "not posted"}</span>
        )}
      </button>
      {open && (
        <div className="border-t border-out-line px-2.5 pb-2.5 pt-2">
          {editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              className="block w-full resize-y rounded-md border border-line bg-page px-2.5 py-2 text-[12.5px] leading-5 text-ink focus:border-ink-4 focus:outline-none"
            />
          ) : (
            <div className="relative max-h-64 overflow-y-auto">
              <Markdown text={post.body} className="prose-ds text-[12.5px]" />
            </div>
          )}
          {error && <p className="mt-1.5 text-[12px] text-del">{error}</p>}
          {post.posted ? (
            <a href={post.posted.url} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink">
              Open on GitHub <ExternalLink size={11} />
            </a>
          ) : confirming ? (
            <div className="mt-2 flex items-center gap-1.5">
              <p className="flex-1 text-[12px] text-ink-2">
                Post this on #{post.number} as you? It's public and can't be unsent.
              </p>
              <button type="button" onClick={() => setConfirming(false)} className="press rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay">
                Back
              </button>
              <button type="button" disabled={busy} onClick={() => void run("post.send", { postId: post.id }).then(() => setConfirming(false))} className="press rounded-md bg-out px-2.5 py-1 text-[12px] font-medium text-page disabled:opacity-40">
                {busy ? "Posting…" : `Post to #${post.number}`}
              </button>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-1">
              {editing ? (
                <button type="button" onClick={() => void run("post.update", { postId: post.id, body: text }).then(() => setEditing(false))} disabled={!text.trim() || busy} className="press rounded px-2 py-1 text-[12px] text-ink hover:bg-overlay disabled:opacity-40">
                  Save wording
                </button>
              ) : (
                <button type="button" onClick={() => setEditing(true)} className="press flex items-center gap-1 rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink">
                  <Pencil size={11} /> Edit
                </button>
              )}
              <button type="button" onClick={() => void run("post.discard", { postId: post.id })} className="press flex items-center gap-1 rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink">
                <Trash2 size={11} /> Discard
              </button>
              {compact && from && (
                <button type="button" onClick={() => openNote(from.id)} className="press rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink">
                  Open thread
                </button>
              )}
              <button type="button" onClick={() => setConfirming(true)} disabled={editing} className="press ml-auto rounded-md border border-out-line px-2.5 py-1 text-[12px] font-medium text-out hover:bg-overlay disabled:opacity-40">
                Post to #{post.number}…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one answer each thread needs: does the author see it, and in what words.
 * In the review, it shows the comment exactly as it will be posted; private, it says so.
 */
export function AuthorCard({ note, onError }: { note: Note; onError: (e: string | null) => void }) {
  const { state } = useReview();
  const [editing, setEditing] = useState(false);
  const going = goesOut(note);
  const text = commentBody(note);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const reworded = !!note.outgoing?.body.trim();
  const pr = state?.review.pr;
  const sent = !!state?.review.published;

  const set = async (outgoing: { include: boolean; body: string } | null) => {
    onError(null);
    try {
      await action("note.update", { noteId: note.id, outgoing });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  if (!pr) return null;
  if (!going) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-md border border-dashed border-line px-2.5 py-1.5">
        <Lock size={12} className="shrink-0 text-ink-4" />
        <span className="flex-1 text-[12px] text-ink-3">Private. The author of #{pr} won't see this thread.</span>
        {!sent && (
          <button type="button" onClick={() => void set({ include: true, body: note.outgoing?.body ?? "" }).then(() => setEditing(true))} className="press shrink-0 rounded px-1.5 py-0.5 text-[12px] text-out hover:bg-overlay">
            Add to review
          </button>
        )}
      </div>
    );
  }

  const location = note.file ? `inline on ${note.file.split("/").at(-1)}${note.lines ? `:${note.lines.start}` : ""}` : "in the review body";
  // The finding as the agent wrote it is the comment; the thread shows it here once, not twice.
  return (
    <div className="mt-3 rounded-md border border-out-line bg-out-wash">
      <div className="flex items-baseline gap-2 border-b border-out-line px-2.5 py-1.5">
        <Send size={12} className="shrink-0 self-center text-out" />
        <span className="shrink-0 text-[12px] font-medium text-out">{sent ? "Sent to" : "The author of"} #{pr} {sent ? "" : "reads"}</span>
        <span className="min-w-0 truncate text-[11.5px] text-ink-3" title={location}>
          {location}
          {reworded ? " · your wording" : ""}
        </span>
      </div>
      {editing ? (
        <div className="p-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            autoFocus
            className="block w-full resize-y rounded-md border border-line bg-page px-2.5 py-2 text-[12.5px] leading-5 text-ink focus:border-ink-4 focus:outline-none"
          />
          <div className="mt-1.5 flex items-center gap-1">
            {reworded && (
              <button type="button" onClick={() => void set({ include: true, body: "" }).then(() => setEditing(false))} className="press flex items-center gap-1 rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink" title="Send the thread as the agent first wrote it">
                <RotateCcw size={11} /> Use original
              </button>
            )}
            <button type="button" onClick={() => (setDraft(text), setEditing(false))} className="press ml-auto rounded px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay">
              Cancel
            </button>
            <button type="button" disabled={!draft.trim()} onClick={() => void set({ include: true, body: draft === text && !reworded ? "" : draft }).then(() => setEditing(false))} className="press rounded-md border border-out-line px-2.5 py-1 text-[12px] font-medium text-out hover:bg-overlay disabled:opacity-40">
              Save wording
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="relative max-h-72 overflow-y-auto px-2.5 py-2">
            <Markdown text={text} className="prose-ds text-[12.5px]" />
          </div>
          {!sent && (
            <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
              <button type="button" onClick={() => setEditing(true)} className="press flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink" title="Change what the author reads">
                <Pencil size={11} /> Edit wording
              </button>
              <button type="button" onClick={() => void set({ include: false, body: note.outgoing?.body ?? "" })} className="press flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink" title="Take it out of the review; the thread stays between you and the agent">
                <Lock size={11} /> Make private
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
