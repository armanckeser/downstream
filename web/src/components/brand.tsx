// Downstream's mark: a path from a door (amber, where the agent starts you) down to where you are.
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Downstream" className="shrink-0">
      <path d="M9 7v6c0 3 2 5 5 5h4c3 0 5 2 5 5v2" fill="none" stroke="var(--color-ink)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="9" cy="7" r="3" fill="var(--color-agent)" />
      <circle cx="23" cy="25" r="2.8" fill="none" stroke="var(--color-ink)" strokeWidth="2.2" />
    </svg>
  );
}
