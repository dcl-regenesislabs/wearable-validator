/** What an operator (the Slack bot) asks for; counts come from the run index, rebuilt from the folders after a restart. */
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import type { StoredRun } from "./run-store.js";

export interface StatsInput {
  runs: StoredRun[];
  running: number;
  waiting: number;
  averageRunMs: number | null;
  maxConcurrentRuns: number;
  serverStartedAt: number;
}

export interface Stats {
  runs: { total: number; passed: number; failed: number; noVerdict: number; running: number; waiting: number };
  byDay: { date: string; runs: number; passed: number; failed: number }[];
  byOwner: { owner: string; runs: number }[];
  averageRunMs: number | null;
  maxConcurrentRuns: number;
  firstRunAt: number | null;
  serverStartedAt: number;
  rulesVersion: string;
}

export function computeStats(input: StatsInput): Stats {
  const all = input.runs;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const byDay = new Map<string, { runs: number; passed: number; failed: number }>();
  const byOwner = new Map<string, number>();
  for (const run of all) {
    const bucket = byDay.get(day(run.startedAt)) ?? { runs: 0, passed: 0, failed: 0 };
    bucket.runs++;
    if (run.passed === true) bucket.passed++;
    if (run.passed === false) bucket.failed++;
    byDay.set(day(run.startedAt), bucket);
    byOwner.set(run.owner, (byOwner.get(run.owner) ?? 0) + 1);
  }
  return {
    runs: {
      total: all.length,
      passed: all.filter((run) => run.passed === true).length,
      failed: all.filter((run) => run.passed === false).length,
      noVerdict: all.filter((run) => run.done && run.passed === null).length,
      running: input.running,
      waiting: input.waiting
    },
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([date, counts]) => ({ date, ...counts })),
    byOwner: [...byOwner].sort(([, a], [, b]) => b - a).map(([owner, runs]) => ({ owner, runs })),
    averageRunMs: input.averageRunMs,
    maxConcurrentRuns: input.maxConcurrentRuns,
    firstRunAt: all.length ? Math.min(...all.map((run) => run.startedAt)) : null,
    serverStartedAt: input.serverStartedAt,
    rulesVersion: manifest.version
  };
}
