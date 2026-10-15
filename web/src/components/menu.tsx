// A small dropdown: a button that opens a list of choices below it. Escape or
// a click elsewhere closes it; arrow keys move between choices.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";

export function Menu({ label, trigger, className = "", align = "end", children }: {
  label: string;
  trigger: ReactNode;
  className?: string;
  align?: "start" | "end";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setOpen(false);
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio],[role=menuitem]") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative" onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)} className={`press ${className}`}>
        {trigger}
      </button>
      {open && (
        <div role="menu" className={`fade-in absolute top-full z-30 mt-1 min-w-[12rem] rounded-xl border border-line bg-overlay p-1 shadow-[0_12px_32px_rgb(0_0_0/0.45)] ${align === "end" ? "right-0" : "left-0"}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ checked, icon, hint, onSelect, children }: { checked?: boolean; icon?: ReactNode; hint?: string; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      onClick={onSelect}
      className="press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-2 hover:bg-pane hover:text-ink focus:bg-pane focus:text-ink focus:outline-none pointer-coarse:min-h-11"
    >
      {icon && <span className="grid size-4 shrink-0 place-items-center text-ink-3">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="kbd shrink-0">{hint}</span>}
      {checked !== undefined && <Check size={13} className={checked ? "text-ink" : "invisible"} />}
    </button>
  );
}

/**
 * A label that appears on hover or keyboard focus, shortly after the pointer
 * settles: icons say what they mean without making you wait for the browser's
 * own tooltip.
 */
export function Tip({ label, children, side = "top" }: { label: string; children: ReactNode; side?: "top" | "bottom" }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-overlay px-2 py-1 text-[11.5px] font-normal text-ink opacity-0 shadow-[0_6px_16px_rgb(0_0_0/0.4)] transition-opacity duration-100 group-hover/tip:opacity-100 group-hover/tip:delay-300 group-focus-within/tip:opacity-100 ${side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
      >
        {label}
      </span>
    </span>
  );
}
