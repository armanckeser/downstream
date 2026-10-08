// Markdown where `backticked` names of symbols on the map become links you can
// hover and follow, so prose about the code stays attached to the code.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useReview } from "../lib/review.tsx";
import { useHover } from "./hover.tsx";

export function Markdown({ text, className = "prose-ds" }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: Code, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Code({ children, className }: { children?: React.ReactNode; className?: string }) {
  const text = String(children ?? "");
  const { index, openSymbol } = useReview();
  const hover = useHover();
  if (className || text.includes("\n") || !index) return <code className={className}>{children}</code>;
  const bare = text.replace(/\(\)$/, "");
  const match =
    index.byId.get(bare) ??
    [...index.byId.values()].find((s) => s.name === bare || `${s.container}.${s.name}` === bare || s.id.endsWith(`#${bare}`));
  if (!match) return <code>{children}</code>;
  return (
    <button
      type="button"
      className="press rounded-[4px] bg-overlay px-[0.35em] py-[0.05em] font-mono text-[0.86em] text-ink underline decoration-ink-4 decoration-dotted underline-offset-[3px] hover:decoration-solid hover:decoration-ink-2"
      onClick={() => openSymbol(match.id)}
      onPointerEnter={(e) => hover.show(e.currentTarget.getBoundingClientRect(), { type: "symbol", id: match.id })}
      onPointerLeave={hover.hide}
    >
      {text}
    </button>
  );
}
