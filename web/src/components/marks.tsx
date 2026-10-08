// Small marks that carry meaning by shape, so color stays reserved for the agent.
import type { Author, CodeSymbol, Edge, Note, Severity, SymbolKind, SymbolStatus } from "@domain/model.ts";

const statusLabel: Record<SymbolStatus, string> = { added: "added", modified: "modified", removed: "removed", context: "unchanged" };

export function StatusMark({ status, className = "" }: { status: SymbolStatus; className?: string }) {
  const common = { width: 10, height: 10, viewBox: "0 0 10 10", className: `shrink-0 ${className}`, "aria-label": statusLabel[status], role: "img" } as const;
  switch (status) {
    case "added":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="4" fill="var(--color-ink)" />
        </svg>
      );
    case "modified":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke="var(--color-ink)" strokeWidth="1.2" />
          <path d="M5 1.4 A3.6 3.6 0 0 1 5 8.6 Z" fill="var(--color-ink)" />
        </svg>
      );
    case "removed":
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke="var(--color-ink-3)" strokeWidth="1.2" />
          <path d="M2.4 7.6 L7.6 2.4" stroke="var(--color-ink-3)" strokeWidth="1.2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="2.6" fill="none" stroke="var(--color-ink-4)" strokeWidth="1.2" />
        </svg>
      );
  }
}

const kindShort: Record<SymbolKind, string> = {
  function: "fn",
  method: "method",
  class: "class",
  interface: "interface",
  type: "type",
  route: "route",
  component: "component",
  const: "const",
  module: "file",
};

export function KindTag({ kind }: { kind: SymbolKind }) {
  return <span className="font-mono text-2xs text-ink-3">{kindShort[kind]}</span>;
}

export function SeverityMark({ severity, author }: { severity: Severity | null; author: Author }) {
  const tone = author === "agent" ? "var(--color-agent)" : "var(--color-ink-2)";
  if (severity === "blocker") return <span className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: tone }} aria-label="blocker" />;
  if (severity === "concern") return <span className="inline-block size-2 shrink-0 rounded-[2px] border-[1.5px]" style={{ borderColor: tone }} aria-label="concern" />;
  return <span className="inline-block size-2 shrink-0 rounded-[2px] border border-ink-4" aria-label="nit" />;
}

const kindWord: Record<Note["kind"], string> = { why: "why", decision: "decision", finding: "finding", question: "question", comment: "comment" };

export function NoteKindTag({ note }: { note: Note }) {
  const agent = note.author === "agent";
  return (
    <span className={`font-mono text-2xs ${agent ? "text-agent-ink" : "text-ink-2"}`}>
      {note.kind === "finding" && note.severity ? note.severity : kindWord[note.kind]}
    </span>
  );
}

export function EdgeMark({ edge }: { edge: Edge }) {
  if (edge.change === "added") return <span className="font-mono text-2xs text-ink-2" title="new in this change">new</span>;
  if (edge.change === "removed") return <span className="font-mono text-2xs text-ink-3 line-through" title="removed in this change">gone</span>;
  return null;
}

export function AuthorTag({ author }: { author: Author }) {
  return author === "agent" ? (
    <span className="font-mono text-2xs font-medium text-agent">agent</span>
  ) : (
    <span className="font-mono text-2xs font-medium text-ink-2">you</span>
  );
}

export function lineLabel(s: CodeSymbol): string {
  const r = s.range ?? s.oldRange;
  return r ? `${s.file}:${r.start}` : s.file;
}
