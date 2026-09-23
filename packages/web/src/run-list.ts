import type { CheckStatus } from "@dcl-regenesislabs/wearable-validator";
import type { RunSummary } from "./api.js";

/** The status chip of one row in "Your runs": null is no verdict (no reviewer, cancelled, interrupted), never a failure. */
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

/** What to tell the curator when GET /api/runs/:id did not answer 200 (null = the server could not be reached). */
export function runLoadMessage(status: number | null): string {
  if (status === null) return "The run server is not reachable, so this run cannot be opened.";
  if (status === 404) return "This run does not exist or belongs to another curator.";
  if (status === 401) return "Sign in to open this run.";
  return `The run server answered ${status} while opening this run.`;
}
