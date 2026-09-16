import type { CheckStatus } from "@dcl-regenesislabs/wearable-validator";
import type { RunSummary } from "./api.js";

/** The status chip of one row in "Your runs": null is no verdict (no reviewer, cancelled, interrupted), never a failure. */
export function runChip(run: RunSummary): { status: CheckStatus; label: string } {
  if (!run.done) return { status: "skipped", label: run.queued ? "Waiting" : "Running" };
  if (run.passed === null) return { status: "skipped", label: "No verdict" };
  return run.passed ? { status: "passed", label: "Passed" } : { status: "failed", label: "Needs attention" };
}
