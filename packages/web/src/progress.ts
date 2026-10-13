/**
 * The code-check stepper over the library's ProgressEvents, with no React in it so node tests cover it. Every step is
 * `{ label, state, detail }`.
 */
import { checks as checkRegistry, type Group, type ProgressEvent } from "@dcl-regenesislabs/wearable-validator";

export const GROUP_LABELS: Record<Group, string> = {
  files: "Files & metadata",
  model: "3D model",
  emote: "Animation",
  content: "Content",
  rendering: "Rendering"
};
/** The groups the browser runs, in registry order. */
export const CODE_GROUPS: Group[] = ["files", "model", "emote", "content"];

export type StepState = "todo" | "active" | "done" | "warning" | "skipped" | "failed";

export interface Step {
  key: string;
  label: string;
  state: StepState;
  detail?: string;
}

export const STATE_WORD: Record<StepState, string> = {
  done: "done",
  warning: "needs attention",
  active: "in progress",
  todo: "not started",
  skipped: "not applicable",
  failed: "failed"
};

/** What the stepper's live region says: it changes only when a step changes state, so per-check and per-view counters stay silent. */
export function stepAnnouncement(steps: Step[]): string {
  const active = steps.find((step) => step.state === "active");
  if (active) return `${active.label} ${STATE_WORD.active}`;
  const last = [...steps].reverse().find((step) => step.state !== "todo");
  return last ? `${last.label} ${STATE_WORD[last.state]}` : "";
}

export const checkTitle = (check: string): string => checkRegistry[check]?.title ?? check;
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One step per code group in registry order. Checks that do not apply never emit an event, so a group with none by
 * the time a later group starts (or the run ends) is "not applicable" — counts are shown as done, never n/N.
 */
export function codeSteps(events: ProgressEvent[], finished = false): Step[] {
  const running = new Map<Group, string>();
  const done = new Map<Group, number>();
  let current: Group | null = null;
  for (const event of events) {
    if (event.type === "check-started") {
      running.set(event.group, event.check);
      current = event.group;
    } else done.set(event.result.group, (done.get(event.result.group) ?? 0) + 1);
  }
  const currentIndex = current ? CODE_GROUPS.indexOf(current) : -1;
  return CODE_GROUPS.map((group, index) => {
    const label = GROUP_LABELS[group];
    const finishedCount = done.get(group) ?? 0;
    const check = running.get(group);
    if (check === undefined) {
      return finished || index < currentIndex ? { key: group, label, state: "skipped", detail: "Not applicable" } : { key: group, label, state: "todo" };
    }
    if (group === current && !finished) {
      return { key: group, label, state: "active", detail: finishedCount > 0 ? `Checking ${checkTitle(check)} · ${finishedCount} done` : `Checking ${checkTitle(check)}` };
    }
    return { key: group, label, state: "done", detail: count(finishedCount, "check") };
  });
}
