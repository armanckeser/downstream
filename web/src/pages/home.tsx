// Home: every pull request that needs you, sorted into the Eisenhower matrix.
// Downstream reads each one (urgent: a person is blocked on you; important:
// it's part of what you're working on); moving one replaces that read for good.
// The first thing in Do is the one thing to do now. Pressing a PR previews it;
// only the preview's button starts the agent.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CornerDownLeft, RotateCw } from "lucide-react";
import { WAITING_ON, type Item, type Quadrant, type Triaged } from "@domain/inbox.ts";
import { prKey } from "@domain/agent.ts";
import type { HomeView, PrSession } from "@domain/home.ts";
import { fetchHome, homeAction, subscribeHome } from "../lib/api.ts";
import { navigate } from "../lib/route.ts";
import { Mark } from "../components/brand.tsx";
import { Menu, MenuItem, Tip } from "../components/menu.tsx";
import { PrPreview } from "../components/pr-preview.tsx";
import { StaleCard, StaleSweep } from "../components/stale-sweep.tsx";
import { ago, Avatar, MOVE_ICON, PrLink, QUADRANT, QUADRANTS, QuadrantMenu, SessionLine, StackLine, verbOf, whyText } from "../components/pull-request.tsx";

export function Home() {
  const [view, setView] = useState<HomeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [starting, setStarting] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(() => {
    fetchHome()
      .then((v) => (setView(v), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout>;
    return subscribeHome({
      home: () => {
        clearTimeout(t);
        t = setTimeout(load, 100);
      },
      agent: () => {},
    });
  }, [load]);

  const inbox = view?.inbox ?? null;
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  // Folded sections stay out of j/k until you open them.
  const visible = useMemo(() => {
    if (!inbox) return [];
    const rest = (q: Quadrant) => inbox[q].filter((i) => i.key !== inbox.top?.key);
    return [...(inbox.top ? [inbox.top] : []), ...rest("do"), ...rest("next"), ...rest("delegate"), ...(open.someday ? inbox.someday : [])];
  }, [inbox, open.someday]);
  const all = useMemo(() => (inbox ? [...inbox.do, ...inbox.next, ...inbox.delegate, ...inbox.someday] : []), [inbox]);
  const previewed = preview ? (all.find((i) => i.key === preview) ?? null) : null;
  const show = (item: Triaged) => {
    // Focus stays off the preview's Start button: the ↵ that opened the preview must never also press Start.
    (document.activeElement as HTMLElement | null)?.blur();
    setPreview(item.key);
    const at = visible.findIndex((v) => v.key === item.key);
    if (at !== -1) setCursor(at);
  };
  const sessionOf = (item: Item): PrSession | null => view?.sessions[prKey(item.lead.repo, item.lead.number)] ?? null;

  const start = useCallback(async (item: Item) => {
    setStarting(item.key);
    setError(null);
    try {
      const where = await homeAction<{ path: string } | { url: string }>("home.start", { key: item.key });
      if ("url" in where) window.open(where.url, "_blank", "noreferrer");
      else navigate(where.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(null);
    }
  }, []);

  const choose = (item: Triaged, quadrant: Quadrant | null) => void homeAction("home.choose", { key: item.key, quadrant }).catch((e: Error) => setError(e.message));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // The sweep has its own keys.
      if (sweeping) return;
      if (target.closest("input, textarea, select, [role=menu]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
      if (step) {
        e.preventDefault();
        const next = Math.max(0, Math.min(visible.length - 1, cursor + step));
        setCursor(next);
        if (preview && visible[next]) setPreview(visible[next]!.key);
        return;
      }
      if (e.key === "Escape" && preview) return setPreview(null);
      if (e.key === "r") return void homeAction("home.refresh");
      const item = previewed ?? visible[cursor];
      if (!item) return;
      // A focused button or link answers ↵ itself; held-down ↵ never reaches Start.
      if (e.key === "Enter") return target.closest("button, a") || e.repeat ? undefined : previewed ? void start(previewed) : show(item);
      if (e.key === "o") return void window.open(item.lead.url, "_blank", "noreferrer");
      if (e.key === "u") return choose(item, null);
      const q = QUADRANTS.find((q) => q.key === e.key);
      if (q) choose(item, q.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, visible.length - 1))), [visible.length]);

  const rowProps = { visible, cursor, setCursor, sessionOf, show, previewing: preview, starting, choose };

  return (
    <div className={`mx-auto min-h-[100dvh] max-w-[48rem] px-5 pb-24 pt-6 transition-[margin] duration-200 ease-out md:px-8 ${preview ? "xl:mr-[33rem]" : ""}`}>
      <header className="flex items-center gap-3">
        <Mark />
        <span className="text-[14px] font-medium text-ink">Downstream</span>
        <div className="ml-auto flex items-center gap-1">
          {view && <AccountMenu view={view} />}
          <Tip label={view?.fetchedAt ? `Refresh (r) · updated ${ago(view.fetchedAt)}` : "Refresh (r)"} side="bottom">
            <button type="button" onClick={() => void homeAction("home.refresh")} className="press grid size-8 place-items-center rounded-md text-ink-3 hover:bg-pane hover:text-ink-2" aria-label="Refresh">
              <RotateCw size={14} className={view?.refreshing ? "animate-spin [animation-duration:900ms]" : ""} />
            </button>
          </Tip>
        </div>
      </header>

      {(error || view?.error) && <p className="mt-6 rounded-lg border border-del/30 px-3 py-2 text-[13px] text-del">{error ?? view?.error}</p>}

      {!inbox ? (
        <HomeSkeleton />
      ) : (
        <>
          <section className="mt-10" aria-label="First">
            {inbox.top ? (
              <TopCard item={inbox.top} session={sessionOf(inbox.top)} selected={cursor === 0} onOpen={() => show(inbox.top!)} onChoose={(q) => choose(inbox.top!, q)} />
            ) : (
              <InboxZero waiting={inbox.waiting.length} someday={inbox.someday.length} />
            )}
          </section>

          {(["do", "next", "delegate"] as const).map((q) => {
            const items = inbox[q].filter((i) => i.key !== inbox.top?.key);
            return items.length > 0 && <Section key={q} quadrant={q} items={items} {...rowProps} />;
          })}

          {inbox.someday.length > 0 && (
            <Fold label="Someday" title={QUADRANT.someday.hint} count={inbox.someday.length} open={!!open.someday} onToggle={() => toggle("someday")}>
              <ul>{inbox.someday.map((item) => <Row key={item.key} item={item} {...rowProps} />)}</ul>
            </Fold>
          )}

          {inbox.stale.length > 0 && <StaleCard count={inbox.stale.length} onOpen={() => (setPreview(null), setSweeping(true))} />}

          {inbox.waiting.length > 0 && (
            <Fold label="Waiting on others" title="Nothing for you to do until someone else moves" count={inbox.waiting.length} open={!!open.waiting} onToggle={() => toggle("waiting")}>
              <ul>
                {inbox.waiting.map((item) => (
                  <li key={item.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-1.5">
                    <Tip label={item.move.kind === "waiting" ? `Waiting on ${WAITING_ON[item.move.on]}` : "Waiting"}>
                      <span className="text-ink-4">{MOVE_ICON.waiting(14)}</span>
                    </Tip>
                    <span className="truncate text-[13px] text-ink-3">{item.lead.title}</span>
                    <PrLink item={item} />
                  </li>
                ))}
              </ul>
            </Fold>
          )}

          <p className="mt-16 hidden text-center font-mono text-2xs text-ink-4 md:block">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>↵</Kbd> preview · <Kbd>o</Kbd> GitHub · <Kbd>d</Kbd> <Kbd>n</Kbd> <Kbd>g</Kbd> <Kbd>s</Kbd> do, next, delegate, someday · <Kbd>u</Kbd> undo
          </p>
        </>
      )}

      {sweeping && inbox && <StaleSweep items={inbox.stale} onClose={() => setSweeping(false)} />}

      {previewed && (
        <PrPreview item={previewed} session={sessionOf(previewed)} starting={starting === previewed.key} onStart={() => void start(previewed)} onChoose={(q) => choose(previewed, q)} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function AccountMenu({ view }: { view: HomeView }) {
  const current = view.accounts.find((a) => a.login === view.account);
  if (!current) return null;
  const face = <Avatar src={current.avatar} name={current.login} size={22} />;
  if (view.accounts.length === 1) return <span className="flex items-center gap-2 px-2 text-[12.5px] text-ink-3" title={`Signed in to GitHub as ${current.login}`}>{face}</span>;
  return (
    <Menu label={`GitHub account: ${current.login}`} className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-[12.5px] text-ink-2 hover:bg-pane" trigger={<>{face}<span className="max-w-[11rem] truncate">{current.login}</span><ChevronDown size={13} className="text-ink-4" /></>}>
      {(close) =>
        view.accounts.map((a) => (
          <MenuItem key={a.login} checked={a.login === view.account} icon={<Avatar src={a.avatar} name={a.login} size={16} />} onSelect={() => (close(), void homeAction("home.account", { login: a.login }))}>
            {a.login}
          </MenuItem>
        ))
      }
    </Menu>
  );
}

function TopCard({ item, session, selected, onOpen, onChoose }: {
  item: Triaged;
  session: PrSession | null;
  selected: boolean;
  onOpen: () => void;
  onChoose: (q: Quadrant | null) => void;
}) {
  const pr = item.lead;
  return (
    <div className={`rounded-2xl border bg-pane px-5 pb-5 pt-4 transition-colors duration-150 ${selected ? "border-line" : "border-line-subtle"}`}>
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <Tip label={verbOf(item)} side="bottom">
          <span className="text-agent-ink">{MOVE_ICON[item.move.kind](14)}</span>
        </Tip>
        <span className="truncate">{whyText(item.why, item)}</span>
        <span className="ml-auto">
          <QuadrantMenu item={item} onChoose={onChoose} />
        </span>
      </div>
      <h1 className="mt-3 text-[21px] font-semibold leading-snug tracking-[-0.012em] text-ink">{pr.title}</h1>
      <div className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-3">
        <Avatar src={pr.authorAvatar} name={pr.author} size={16} />
        <span className="truncate">{pr.role === "author" ? "You" : (pr.authorName ?? pr.author)}</span>
        <span className="text-ink-4">·</span>
        <PrLink item={item} />
        <span className="text-ink-4">·</span>
        <span>{ago(pr.updatedAt)}</span>
      </div>
      {item.stack && <StackLine item={item} />}
      <SessionLine session={session} />
      <button type="button" onClick={onOpen} className="press mt-5 inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-[14px] font-medium text-page hover:bg-white">
        {verbOf(item)}
        <CornerDownLeft size={14} className="opacity-50" />
      </button>
    </div>
  );
}

type RowProps = {
  visible: Triaged[];
  cursor: number;
  setCursor: (i: number) => void;
  sessionOf: (i: Item) => PrSession | null;
  show: (i: Triaged) => void;
  /** The key of the PR in the preview, if one is open. */
  previewing: string | null;
  starting: string | null;
  choose: (i: Triaged, q: Quadrant | null) => void;
};

function Section({ quadrant, items, ...rowProps }: RowProps & { quadrant: Quadrant; items: Triaged[] }) {
  const q = QUADRANT[quadrant];
  return (
    <section className="mt-10">
      <h2 className="flex items-baseline gap-2 px-2 pb-1.5 text-[13px] font-medium text-ink-2" title={q.hint}>
        {q.label} <span className="font-mono text-2xs text-ink-4">{items.length}</span>
      </h2>
      <ul>{items.map((item) => <Row key={item.key} item={item} {...rowProps} />)}</ul>
    </section>
  );
}

function Row({ item, visible, cursor, setCursor, sessionOf, show, previewing, starting, choose }: RowProps & { item: Triaged }) {
  const index = visible.findIndex((v) => v.key === item.key);
  const selected = index !== -1 && index === cursor;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const session = sessionOf(item);
  const live = session?.agent && !["ended", "failed", "handed-off"].includes(session.agent.status);
  const needsYou = (session?.agent?.approvals ?? 0) > 0 || session?.review?.move.kind === "answer";
  const pr = item.lead;
  return (
    <li ref={ref} onPointerEnter={() => index !== -1 && setCursor(index)} aria-current={previewing === item.key || undefined} className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg pr-1 ${previewing === item.key ? "bg-overlay" : selected ? "bg-pane" : ""}`}>
      <button type="button" onClick={() => show(item)} className="press grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 py-2 pl-2 text-left">
        <Tip label={verbOf(item)}>
          <span className={selected ? "text-ink-2" : "text-ink-3"} aria-label={verbOf(item)}>
            {starting === item.key ? <RotateCw size={14} className="animate-spin" /> : MOVE_ICON[item.move.kind](15)}
          </span>
        </Tip>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`truncate text-[13.5px] ${selected ? "text-ink" : "text-ink-2"}`}>{pr.title}</span>
          {item.stack && (
            <Tip label={`Layer ${pr.stack?.position ?? 1} of a stack of ${item.stack.size}`}>
              <span className="shrink-0 font-mono text-2xs text-ink-4">{pr.stack?.position ?? 1}/{item.stack.size}</span>
            </Tip>
          )}
        </span>
        <span className="hidden items-center gap-1.5 text-[12px] text-ink-4 sm:flex">
          {(live || needsYou) && (
            <Tip label={needsYou ? "The agent needs you" : "The agent is working"}>
              <span className={`size-1.5 rounded-full ${needsYou ? "bg-agent" : "bg-agent/60"}`} />
            </Tip>
          )}
          <span className="max-w-[10rem] truncate">{whyText(item.why, item, true)}</span>
        </span>
      </button>
      <span className="flex items-center gap-2">
        <Tip label={pr.role === "author" ? "Yours" : `By ${pr.authorName ?? pr.author}`}>
          <Avatar src={pr.authorAvatar} name={pr.role === "author" ? "You" : (pr.authorName ?? pr.author)} size={18} />
        </Tip>
        <PrLink item={item} />
        <span className={`${selected ? "opacity-100" : "opacity-0 pointer-coarse:opacity-100"} transition-opacity duration-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100`}>
          <QuadrantMenu item={item} onChoose={(q) => choose(item, q)} />
        </span>
      </span>
    </li>
  );
}

function Fold({ label, title, count, open, onToggle, children }: { label: string; title: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="mt-10">
      <button type="button" onClick={onToggle} aria-expanded={open} title={title} className="press flex items-center gap-1.5 px-2 text-[13px] text-ink-3 hover:text-ink-2">
        <ChevronRight size={14} className={`transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`} />
        {label}
        <span className="font-mono text-2xs text-ink-4">{count}</span>
      </button>
      {open && <div className="fade-in mt-2">{children}</div>}
    </section>
  );
}

function InboxZero({ waiting, someday }: { waiting: number; someday: number }) {
  const rest = [waiting && `${waiting} waiting on others`, someday && `${someday} set aside`].filter(Boolean).join(", ");
  return (
    <div className="rounded-2xl border border-dashed border-line px-5 py-8 text-center">
      <p className="text-[15px] font-medium text-ink">Nothing needs you.</p>
      <p className="mt-1 text-[13px] text-ink-3">{rest ? `${rest}, below.` : "Every pull request is moving without you."}</p>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="mt-10 space-y-3" aria-busy>
      <div className="h-44 rounded-2xl bg-pane" />
      {[68, 54, 72, 60].map((w, i) => (
        <div key={i} className="h-4 rounded bg-pane" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
