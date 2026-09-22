import { useCallback, useEffect, useRef, useState } from "react";
import { checks as checkRegistry } from "@dcl-regenesislabs/wearable-validator";
import { listRuns, queueState, visualHealth, type QueueState, type RunSummary, type VisualCapabilities, type VisualHealth } from "./api.js";

/**
 * The run server as both tabs see it: what it can do, who is signed in, the shared render line and the run list.
 * Polled while the server answers; without one (the static site) everything stays empty and nothing shows.
 */

const QUEUE_POLL_MS = 4000;
const HEALTH_RETRY_MS = 10_000;
const CLOCK_MS = 30_000;
const MAX_LISTED_RUNS = 50;
const NO_RUNS: RunSummary[] = [];

export interface Server {
  /** /api/health answered at least once. */
  known: boolean;
  capabilities: VisualCapabilities | null;
  /** Who the server thinks is calling; "local" without sign-in. */
  owner: string | null;
  operator: boolean;
  /** The server's model-backed checks — how many model calls a run makes at most. */
  aiChecks: string[];
  runs: RunSummary[];
  /** GET /api/runs answered at least once; until then `runs` is an empty placeholder, not an empty history. */
  runsLoaded: boolean;
  queue: QueueState | null;
  /** A clock the relative times are computed against; ticks every 30 s and on every poll. */
  now: number;
  refreshRuns: () => void;
  refreshHealth: () => Promise<VisualHealth | null>;
}

export function useServer(): Server {
  const [health, setHealth] = useState<VisualHealth | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const operatorRef = useRef(false);

  const refreshRuns = useCallback(() => {
    void listRuns({ all: operatorRef.current }).then((list) => {
      setRuns(list.slice(0, MAX_LISTED_RUNS));
      setNow(Date.now());
    });
  }, []);

  // a transient failure keeps the last good answer: the page stays connected, only startVisual sees the null
  const refreshHealth = useCallback(async () => {
    const next = await visualHealth();
    if (next) {
      operatorRef.current = next.operator;
      setHealth((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    }
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    void refreshHealth().then((next) => alive && next && refreshRuns());
    return () => {
      alive = false;
    };
  }, [refreshHealth, refreshRuns]);

  const known = health !== null;
  // opened during a server restart: keep asking until it answers
  useEffect(() => {
    if (known) return;
    const timer = setInterval(() => void refreshHealth().then((next) => next && refreshRuns()), HEALTH_RETRY_MS);
    return () => clearInterval(timer);
  }, [known, refreshHealth, refreshRuns]);

  useEffect(() => {
    if (!known) return;
    let alive = true;
    let last = "";
    const read = () =>
      void queueState().then((next) => {
        if (!alive) return;
        setQueue(next);
        setNow(Date.now());
        // the run list changes when the line does; while something runs, refresh it each poll so History stays current
        const shape = next ? [...next.running, ...next.waiting].map((entry) => `${entry.id ?? "?"}:${entry.position}`).join(",") : "";
        if (shape !== last || shape !== "") {
          last = shape;
          refreshRuns();
        }
      });
    read();
    const timer = setInterval(read, QUEUE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [known, refreshRuns]);

  // keep "3 minutes ago" honest while the list is on screen
  const listed = runs?.length ?? 0;
  useEffect(() => {
    if (listed === 0) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [listed]);

  return {
    known,
    capabilities: health?.visual ?? null,
    owner: health?.owner ?? null,
    operator: health?.operator === true,
    aiChecks: (health?.checks ?? []).filter((check) => checkRegistry[check]?.prompt !== undefined),
    runs: runs ?? NO_RUNS,
    runsLoaded: runs !== null,
    queue,
    now,
    refreshRuns,
    refreshHealth
  };
}
