import type { ReactNode } from "react";
import { Spinner } from "./rules.js";
import { STATE_WORD, stepAnnouncement, type Step, type StepState } from "./progress.js";

/** dcl-editor `.eui-publish-steps`: one list whose shape never changes underneath the creator; ✓ / Spinner / · per step. */

const MARK: Record<StepState, ReactNode> = {
  done: "✓",
  active: <Spinner size="sm" decorative />,
  todo: "·",
  skipped: "–",
  failed: "✕"
};

export function Stepper({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <div>
      <ol className="eui-publish-steps" aria-label={label}>
        {steps.map((step) => (
          <li key={step.key} className={`eui-publish-step ${step.state}`} aria-current={step.state === "active" ? "step" : undefined}>
            <span className="ic" aria-hidden="true">{MARK[step.state]}</span>
            <span className="lbl">{step.label}</span>
            <span className="eui-sr-only">{STATE_WORD[step.state]}</span>
            {step.detail && <span className="dt">{step.detail}</span>}
          </li>
        ))}
      </ol>
      <p className="eui-sr-only" role="status">{stepAnnouncement(steps)}</p>
    </div>
  );
}

/** The photo grid's empty slots while the renderer works: as many as the server planned, or a few until it says. */
export function PendingCaptures({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: Math.max(0, count) }, (_, index) => (
        <figure className="visual-figure pending" key={`pending-${index}`} aria-hidden="true">
          <div className="visual-placeholder" />
        </figure>
      ))}
    </>
  );
}
