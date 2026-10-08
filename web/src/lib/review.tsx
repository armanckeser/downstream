// Client state for one review: the server's state, plus where the user is.
// Where the user is gets mirrored to the server (navigation/selection) so the
// agent can see it; the agent can move it back with `navigate` events.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NavigateCommand, Presence, Range, ReviewEvent, ReviewState } from "@domain/model.ts";
import { action, fetchState, subscribe } from "./api.ts";
import { buildIndex, pathFromEntry, type Index } from "./graph.ts";

export type View = "overview" | "trail" | "map";
export type Selection = { symbolId: string | null; file: string; lines: Range; side: "new" | "old" } | null;
export type Focus = { symbolId: string; lines: Range | null; nonce: number } | null;

type Ctx = {
  state: ReviewState | null;
  error: string | null;
  index: Index | null;
  version: number;
  live: boolean;
  presence: Presence;
  view: View;
  trail: string[];
  stepId: string | null;
  noteId: string | null;
  selection: Selection;
  focus: Focus;
  /** The last agent activity worth pointing at, for the presence line. */
  lastAgentEvent: ReviewEvent | null;
  setView: (v: View) => void;
  openSymbol: (id: string, opts?: { after?: string; lines?: Range | null }) => void;
  setTrail: (ids: string[]) => void;
  openStep: (id: string) => void;
  openNote: (id: string | null) => void;
  setSelection: (s: Selection) => void;
  /** Open a symbol that a just-run action created, once the next state arrives. */
  openWhenReady: (id: string, after?: string) => void;
  refresh: () => void;
};

const ReviewContext = createContext<Ctx | null>(null);

export function useReview(): Ctx {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error("useReview outside provider");
  return ctx;
}

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [live, setLive] = useState(false);
  const [presence, setPresence] = useState<Presence>({ agent: "away", lastAgentActivity: null });
  const [view, setView] = useState<View>("overview");
  const [trail, setTrailState] = useState<string[]>([]);
  const [stepId, setStepId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [selection, setSelectionState] = useState<Selection>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [lastAgentEvent, setLastAgentEvent] = useState<ReviewEvent | null>(null);

  const index = useMemo(() => (state ? buildIndex(state) : null), [state]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(() => {
    fetchState()
      .then((s) => {
        setState(s);
        setPresence(s.presence);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const openSymbol = useCallback((id: string, opts?: { after?: string; lines?: Range | null }) => {
    const idx = indexRef.current;
    if (!idx?.byId.has(id)) return;
    setTrailState((prev) => {
      if (opts?.after) {
        const at = prev.indexOf(opts.after);
        if (at >= 0) return [...prev.slice(0, at + 1), id];
      }
      const existing = prev.indexOf(id);
      if (existing >= 0) return prev.slice(0, existing + 1);
      return pathFromEntry(idx, id);
    });
    setView("trail");
    setFocus({ symbolId: id, lines: opts?.lines ?? null, nonce: Date.now() });
    // Leaving a step's ground ends the step.
    setStepId((sid) => (sid && stateRef.current?.steps.find((s) => s.id === sid)?.symbolId === id ? sid : null));
  }, []);

  const openStep = useCallback(
    (id: string) => {
      const step = stateRef.current?.steps.find((s) => s.id === id);
      if (!step) return;
      setStepId(id);
      if (step.symbolId) {
        const idx = indexRef.current;
        if (idx) setTrailState((prev) => (prev.includes(step.symbolId!) ? prev.slice(0, prev.indexOf(step.symbolId!) + 1) : pathFromEntry(idx, step.symbolId!)));
        setFocus({ symbolId: step.symbolId, lines: step.lines, nonce: Date.now() });
      }
      setView("trail");
    },
    [],
  );

  const openNote = useCallback(
    (id: string | null) => {
      setNoteId(id);
      if (!id) return;
      const note = stateRef.current?.notes.find((n) => n.id === id);
      if (note?.symbolId && indexRef.current?.byId.has(note.symbolId)) {
        const idx = indexRef.current;
        setTrailState((prev) => (prev.includes(note.symbolId!) ? prev.slice(0, prev.indexOf(note.symbolId!) + 1) : pathFromEntry(idx, note.symbolId!)));
        setFocus({ symbolId: note.symbolId, lines: note.lines, nonce: Date.now() });
        setStepId((sid) => (sid && stateRef.current?.steps.find((s) => s.id === sid)?.symbolId === note.symbolId ? sid : null));
        setView("trail");
      }
    },
    [],
  );

  const applyNavigate = useCallback(
    (cmd: NavigateCommand) => {
      if (cmd.stepId) openStep(cmd.stepId);
      else if (cmd.noteId) openNote(cmd.noteId);
      else if (cmd.symbolId) openSymbol(cmd.symbolId, { lines: cmd.lines });
      if (cmd.view && !cmd.symbolId && !cmd.stepId) setView(cmd.view);
    },
    [openNote, openStep, openSymbol],
  );

  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout>;
    return subscribe({
      change: (e) => {
        if (e.type === "navigate") return applyNavigate(e.payload as NavigateCommand);
        if (e.type === "review.reanalyzed" || e.type === "review.opened") setVersion((v) => v + 1);
        // Applied now, not on the debounced refresh, so a just-read message never flashes as unread.
        // The agent has left its wait to handle what it read; the presence event confirms it after.
        if (e.type === "agent.read") {
          const { through } = e.payload as { through: string };
          setState((s) => (s ? { ...s, readThrough: through } : s));
          setPresence((p) => ({ ...p, agent: "working" }));
        }
        if (e.actor === "agent") setLastAgentEvent(e);
        clearTimeout(timer);
        timer = setTimeout(refresh, 120);
      },
      presence: setPresence,
      status: (ok) => {
        setLive(ok);
        if (ok) refresh();
      },
    });
  }, [refresh, applyNavigate]);

  // Mirror what the user sees so `downstream screen` can answer "this".
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => void action("state.set", { key: "navigation", value: { view, trail, stepId, noteId } }).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [state === null, view, trail, stepId, noteId]);

  const setSelection = useCallback((s: Selection) => {
    setSelectionState(s);
    void action("state.set", { key: "selection", value: s }).catch(() => {});
  }, []);

  const pending = useRef<{ id: string; after?: string } | null>(null);
  const openWhenReady = useCallback((id: string, after?: string) => {
    pending.current = { id, after };
    refresh();
  }, [refresh]);
  useEffect(() => {
    const p = pending.current;
    if (p && index?.byId.has(p.id)) {
      pending.current = null;
      openSymbol(p.id, { after: p.after });
    }
  }, [index, openSymbol]);

  const value: Ctx = {
    state,
    error,
    index,
    version,
    live,
    presence,
    view,
    trail,
    stepId,
    noteId,
    selection,
    focus,
    lastAgentEvent,
    setView,
    openSymbol,
    setTrail: setTrailState,
    openStep,
    openNote,
    setSelection,
    openWhenReady,
    refresh,
  };
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}
