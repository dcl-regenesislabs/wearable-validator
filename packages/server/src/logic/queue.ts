/** The line in front of the renderer: MAX_CONCURRENT_RUNS slots, arrival order, a place and an estimate for every waiting item. */
import type { QueueEntry, QueuePosition, QueueState } from "../types.js";
import { QueueFullError, TooManyRunsError } from "./errors.js";

// the wait estimate averages the last few renders; the first run of a fresh server has no estimate
const DURATION_SAMPLES = 5;

export interface QueueItem {
  id: string;
  owner: string;
  name: string;
  /** When the item was accepted; running items report when their slot opened instead. */
  since: number;
}

export interface QueueOptions {
  maxConcurrent: number;
  maxWaiting: number;
  maxActivePerOwner: number;
}

/** Whether the run should count towards the wait estimate: a cancelled run's time says nothing about the next. */
export type QueueWork = () => Promise<"finished" | "cancelled">;

export interface IQueueComponent {
  readonly maxConcurrent: number;
  /** Throws TooManyRunsError / QueueFullError before the item enters. */
  enqueue(item: QueueItem, work: QueueWork): void;
  /** False when the item is running (it is stopped through its own signal) or unknown. */
  leave(id: string): boolean;
  waiting(): QueueItem[];
  running(): QueueItem[];
  activeCount(owner: string): number;
  hasRoom(): boolean;
  averageRunMs(): number | null;
  positionOf(id: string): QueuePosition | undefined;
  snapshot(owner: string): QueueState;
  onMove(listener: (item: QueueItem, position: QueuePosition) => void): void;
  drain(): QueueItem[];
}

interface Pending {
  item: QueueItem;
  work: QueueWork;
}

export function createQueueComponent(options: QueueOptions): IQueueComponent {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  const waiting: Pending[] = [];
  const running = new Map<string, QueueItem>();
  const durations: number[] = [];
  const listeners: ((item: QueueItem, position: QueuePosition) => void)[] = [];

  function averageRunMs(): number | null {
    return durations.length ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) : null;
  }

  function positionAt(index: number): QueuePosition {
    const average = averageRunMs();
    return { position: index + 1, ahead: running.size + index, running: running.size, averageRunMs: average, etaMs: average === null ? null : Math.ceil((index + 1) / maxConcurrent) * average };
  }

  function tell(item: QueueItem, position: QueuePosition): void {
    for (const listener of listeners) listener(item, position);
  }

  function broadcast(): void {
    waiting.forEach((pending, index) => tell(pending.item, positionAt(index)));
  }

  function pump(): void {
    while (running.size < maxConcurrent && waiting.length) {
      const next = waiting.shift()!;
      const began = Date.now();
      const item = { ...next.item, since: began };
      running.set(item.id, item);
      tell(item, { position: 0, ahead: 0, running: running.size, averageRunMs: averageRunMs(), etaMs: 0 });
      void next.work().then(
        (outcome) => {
          if (outcome === "finished") {
            durations.push(Date.now() - began);
            if (durations.length > DURATION_SAMPLES) durations.shift();
          }
        },
        () => undefined
      ).finally(() => {
        running.delete(item.id);
        pump();
        broadcast();
      });
    }
  }

  function activeCount(owner: string): number {
    return waiting.filter((pending) => pending.item.owner === owner).length + [...running.values()].filter((item) => item.owner === owner).length;
  }

  return {
    maxConcurrent,
    enqueue(item, work) {
      const active = activeCount(item.owner);
      if (active >= options.maxActivePerOwner) throw new TooManyRunsError(`You already have ${active} run${active === 1 ? "" : "s"} waiting or rendering. Wait for one to finish before starting another.`);
      if (waiting.length >= options.maxWaiting) throw new QueueFullError();
      waiting.push({ item, work });
      broadcast();
      pump();
    },
    leave(id) {
      const place = waiting.findIndex((pending) => pending.item.id === id);
      if (place < 0) return false;
      waiting.splice(place, 1);
      broadcast();
      return true;
    },
    waiting: () => waiting.map((pending) => pending.item),
    running: () => [...running.values()],
    activeCount,
    hasRoom: () => waiting.length < options.maxWaiting,
    averageRunMs,
    positionOf(id) {
      if (running.has(id)) return { position: 0, ahead: 0, running: running.size, averageRunMs: averageRunMs(), etaMs: 0 };
      const index = waiting.findIndex((pending) => pending.item.id === id);
      return index < 0 ? undefined : positionAt(index);
    },
    snapshot(owner) {
      const entry = (item: QueueItem, position: number): QueueEntry =>
        item.owner === owner ? { position, mine: true, id: item.id, name: item.name, since: item.since } : { position, mine: false, since: item.since };
      return {
        running: [...running.values()].map((item) => entry(item, 0)),
        waiting: waiting.map((pending, index) => entry(pending.item, index + 1)),
        averageRunMs: averageRunMs(),
        maxConcurrentRuns: maxConcurrent
      };
    },
    onMove: (listener) => void listeners.push(listener),
    drain: () => waiting.splice(0).map((pending) => pending.item)
  };
}
