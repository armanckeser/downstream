// A pull request's small parts, shared by the home list and the preview: what
// its next move looks like, why it's where it is, who wrote it, where it lives.
import type { ReactNode } from "react";
import { ArrowUpRight, ChevronDown, CircleX, Clock, Eye, GitCompareArrows, GitMerge, GitPullRequestDraft, MessageSquareReply, ScanEye } from "lucide-react";
import { MOVES, type Item, type MoveKind, type Quadrant, type Triaged, type TurnBack, type Why } from "@domain/inbox.ts";
import type { PrSession } from "@domain/home.ts";
import type { ReviewMove } from "@domain/next-move.ts";
import { timeAgo } from "../lib/time.ts";
import { Menu, MenuItem } from "./menu.tsx";

export const MOVE_ICON: Record<MoveKind, (size: number) => ReactNode> = {
  merge: (s) => <GitMerge size={s} />,
  review: (s) => <Eye size={s} />,
  rereview: (s) => <ScanEye size={s} />,
  "address-feedback": (s) => <MessageSquareReply size={s} />,
  "resolve-conflicts": (s) => <GitCompareArrows size={s} />,
  "fix-checks": (s) => <CircleX size={s} />,
  "finish-draft": (s) => <GitPullRequestDraft size={s} />,
  waiting: (s) => <Clock size={s} />,
};

export const QUADRANTS: { id: Quadrant; label: string; key: string; hint: string }[] = [
  { id: "do", label: "Do", key: "d", hint: "Someone needs you, or you're in the middle of it" },
  { id: "next", label: "Next", key: "n", hint: "Yours or your agents' work, nobody blocked yet: once Do is empty" },
  { id: "delegate", label: "Delegate", key: "g", hint: "Someone's waiting, outside what you're working on: let the agent take the first pass" },
  { id: "someday", label: "Someday", key: "s", hint: "Out of sight until something happens on it: drafts you haven't opened lately" },
];
export const QUADRANT = Object.fromEntries(QUADRANTS.map((q) => [q.id, q])) as Record<Quadrant, (typeof QUADRANTS)[number]>;

/** Where this sits in the matrix. Shows Downstream's read when you've overridden it, so you can go back. */
export function QuadrantMenu({ item, onChoose }: { item: Triaged; onChoose: (q: Quadrant | null) => void }) {
  const chosen = item.why.kind === "you-chose";
  return (
    <Menu label="Move to…" className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink" trigger={<>{QUADRANT[item.quadrant].label}<ChevronDown size={12} /></>}>
      {(close) => (
        <>
          {QUADRANTS.map((q) => (
            <MenuItem key={q.id} checked={item.quadrant === q.id} hint={q.key} onSelect={() => (close(), onChoose(q.id))}>
              <span title={q.hint}>{q.label}</span>
            </MenuItem>
          ))}
          {chosen && (
            <>
              <div className="my-1 h-px bg-line-subtle" />
              <MenuItem hint="u" onSelect={() => (close(), onChoose(null))}>
                Back to Downstream's read: {QUADRANT[item.auto.quadrant].label}
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );
}

/** The PR on GitHub, as `repo#123`. */
export function PrLink({ item }: { item: Item }) {
  return (
    <a
      href={item.lead.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`${item.lead.repo}#${item.lead.number} on GitHub (o)`}
      className="press inline-flex items-center gap-0.5 rounded font-mono text-2xs text-ink-4 hover:text-ink-2 hover:underline"
    >
      {shortRepo(item.repo)}#{item.lead.number}
      <ArrowUpRight size={11} className="opacity-60" />
    </a>
  );
}

export function Avatar({ src, name, size }: { src: string | null; name: string; size: number }) {
  const style = { width: size, height: size };
  if (!src) return <span style={style} className="grid shrink-0 place-items-center rounded-full bg-overlay text-[9px] uppercase text-ink-3" title={name}>{name[0]}</span>;
  return <img src={src} alt={name} title={name} style={style} className="shrink-0 rounded-full bg-overlay" loading="lazy" />;
}

export const ago = (iso: string) => (timeAgo(iso) === "just now" ? "just now" : `${timeAgo(iso)} ago`);

export const HOW: Record<string, string> = { reviewed: "reviewed", commented: "commented", opened: "opened it", pushed: "pushed" };

/** What the author did that made a PR you reviewed yours again. */
const TURN: Record<TurnBack["how"], string> = { pushed: "Pushed", replied: "Replied", "re-requested": "Asked again" };

/** The reason in a few words; `short` for a row. */
export function whyText(why: Why, item: Item, short = false): string {
  switch (why.kind) {
    case "your-turn":
      return short ? `${TURN[why.how]} ${ago(why.at)}` : `${why.who} ${TURN[why.how].toLowerCase()} after your review`;
    case "in-focus":
      return `You ${HOW[why.how]} ${ago(why.at)}`;
    case "person-waiting":
      if (short) return `Waiting ${timeAgo(why.since)}`;
      return `${why.who} is waiting on you`;
    case "feedback-on-yours":
      return short ? "Feedback for you" : `Reviewers left feedback${item.move.kind === "address-feedback" && item.move.threads ? ` in ${item.move.threads} thread${item.move.threads === 1 ? "" : "s"}` : ""}`;
    case "ready-to-merge":
      return short ? "Approved" : "Approved and green: one click from done";
    case "yours":
      return "Yours";
    case "bot-work":
      return short ? "Agent's work" : `${why.who}'s work, ready for you`;
    case "draft":
      return short ? "Draft" : "A draft you haven't opened lately";
    case "you-chose":
      return short ? "You moved it" : `You moved it here; Downstream read it as ${QUADRANT[(item as Triaged).auto.quadrant].label}`;
  }
}

/** Where a Downstream review stands, in your terms. A review the agent never wrote into says nothing. */
const REVIEW_LINE: Record<ReviewMove["kind"], (m: ReviewMove) => string | null> = {
  sent: () => "Review sent",
  answer: () => "The agent asked you something",
  decide: () => "Read through, threads to settle",
  reading: () => null,
  walk: (m) => {
    const w = m as Extract<ReviewMove, { kind: "walk" }>;
    return w.order === 1 ? "Walkthrough ready" : `Walkthrough: step ${w.order} of ${w.total}`;
  },
  send: () => "Read through, ready to send",
  finish: () => "Walkthrough done",
};

export function SessionLine({ session }: { session: PrSession | null }) {
  if (!session) return null;
  const { agent, review } = session;
  const live = agent && !["ended", "failed", "handed-off"].includes(agent.status);
  const asking = !!agent && agent.approvals > 0;
  const answer = review?.move.kind === "answer";
  const text = asking
    ? "The agent is waiting for your approval"
    : answer
      ? "The agent asked you something"
      : live
        ? (agent.status === "idle" ? "The agent is waiting for you" : (agent.line ?? "The agent is working"))
        : agent?.status === "handed-off"
          ? "Continued in your terminal"
          : review
            ? REVIEW_LINE[review.move.kind](review.move)
            : null;
  if (!text) return null;
  const busy = live && (agent.status === "running" || agent.status === "starting");
  return (
    <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
      <span className={`size-1.5 shrink-0 rounded-full ${asking || answer ? "bg-agent" : busy ? "bg-agent/70 motion-safe:animate-pulse" : "bg-ink-4"}`} />
      <span className="truncate">{text}</span>
    </p>
  );
}

export function StackLine({ item }: { item: Item }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-1 font-mono text-[11.5px] text-ink-3" aria-label={`Stack of ${item.stack!.size}`}>
      <span className="mr-1 text-ink-4">stack</span>
      {item.prs.map((p, i) => (
        <span key={p.number} className="flex items-center gap-1">
          {i > 0 && <span className="text-ink-4">→</span>}
          <a href={p.url} target="_blank" rel="noreferrer" className={`hover:underline ${p.number === item.lead.number ? "rounded bg-overlay px-1 text-ink" : ""}`}>#{p.number}</a>
        </span>
      ))}
      {item.stack!.size > item.prs.length && <span className="text-ink-4">+{item.stack!.size - item.prs.length}</span>}
    </p>
  );
}

export const verbOf = (item: Item) => {
  const { move } = item;
  if (move.kind === "address-feedback" && move.threads > 0) return `Address ${move.threads} thread${move.threads === 1 ? "" : "s"}`;
  return MOVES[move.kind].verb;
};

/** `kensho/corsa-fe` → `corsa-fe`: the owner is the same on most rows. */
export const shortRepo = (repo: string) => repo.split("/")[1] ?? repo;
