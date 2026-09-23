import type { MouseEvent } from "react";
import type { CheckStatus } from "@dcl-regenesislabs/wearable-validator";
import type { RunSummary } from "./api.js";

/** A click meant for the browser (new tab, window, download): in-app links let it fall through to their real href. */
export const isModifiedClick = (e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button">): boolean =>
  e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

/** The status chip of one row in History: null is no verdict (no reviewer, cancelled, interrupted), never a failure. */
export function runChip(run: RunSummary): { status: CheckStatus; label: string } {
  if (!run.done) return { status: "skipped", label: run.queued ? "Waiting" : "Running" };
  if (run.passed === null) return { status: "skipped", label: "No verdict" };
  return run.passed ? { status: "passed", label: "Passed" } : { status: "failed", label: "Needs attention" };
}

/** Server run ids are 32 hex chars; anything path-safe is accepted so the id can be put in `/api/runs/<id>` as is. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The run a `?run=<id>` deep link asks for, or null when the query names none (or a malformed one). */
export function runIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get("run")?.trim() ?? "";
  return RUN_ID.test(id) ? id : null;
}

/** The shareable link of a run: the site's root with `?run=<id>`, so the page opens the run on load. */
export function runUrl(id: string): string {
  return `/?run=${encodeURIComponent(id)}`;
}

export type Tab = "validate" | "history";

/** Which tab the URL opens: `?tab=history` or any `?run=<id>` is History, everything else Validate. */
export function tabFrom(search: string): Tab {
  if (runIdFrom(search) !== null) return "history";
  return new URLSearchParams(search).get("tab") === "history" ? "history" : "validate";
}

/** The page's URL state: the tab, the History run on screen, the catalyst item on Validate. */
export interface Route {
  tab: Tab;
  run: string | null;
  urn: string | null;
}

export function routeFrom(search: string): Route {
  const urn = new URLSearchParams(search).get("urn")?.trim() || null;
  return { tab: tabFrom(search), run: runIdFrom(search), urn };
}

/** The URL of a route: `/`, `/?tab=history`, `/?run=<id>`, `/?urn=<urn>` — a run implies History, so `tab` is left out then. */
export function routeUrl(route: Route): string {
  const params = new URLSearchParams();
  if (route.urn) params.set("urn", route.urn);
  if (route.run) params.set("run", route.run);
  else if (route.tab === "history") params.set("tab", "history");
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

/** What to tell the curator when GET /api/runs/:id did not answer 200 (null = the server could not be reached). */
export function runLoadMessage(status: number | null): string {
  if (status === null) return "The run server is not reachable, so this run cannot be opened.";
  if (status === 404) return "This run does not exist or belongs to another curator.";
  if (status === 401) return "Sign in to open this run.";
  return `The run server answered ${status} while opening this run.`;
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];

/** "3 minutes ago", "yesterday": the largest unit that fits, "now" under a minute. */
export function relativeTime(startedAt: number, now: number): string {
  if (startedAt <= 0) return "earlier";
  const elapsed = now - startedAt;
  for (const [unit, ms] of TIME_UNITS) {
    if (elapsed >= ms) return RELATIVE_TIME.format(-Math.round(elapsed / ms), unit);
  }
  return RELATIVE_TIME.format(0, "second");
}

/** "40 s" / "3 min" for how long an item has been in its state. */
export function elapsedText(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** "about 2 min", "under a minute": the wait estimate the server derives from its last renders; "" when it has none. */
export function waitText(etaMs: number | null): string {
  if (etaMs === null) return "";
  if (etaMs < 60_000) return "under a minute";
  return `about ${Math.max(1, Math.round(etaMs / 60_000))} min`;
}

/** One History table row: `sentBy` only when the server named an owner (operators listing everyone's runs). */
export interface HistoryRow {
  id: string;
  name: string;
  sentBy?: string;
  when: string;
  startedAt: number;
  live: boolean;
  chip: { status: CheckStatus; label: string };
}

export function historyRow(run: RunSummary, now: number): HistoryRow {
  return {
    id: run.id,
    name: run.name,
    ...(run.owner ? { sentBy: run.owner } : {}),
    when: relativeTime(run.startedAt, now),
    startedAt: run.startedAt,
    live: !run.done,
    chip: runChip(run)
  };
}
