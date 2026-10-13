import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, Finding, ProgressEvent } from "@dcl-regenesislabs/wearable-validator";
import { codeSteps, stepAnnouncement, type Step } from "../src/progress.js";

// ── recorded sequences ───────────────────────────────────────────────────────

const row = (check: string, group: CheckResult["group"], status: CheckResult["status"] = "passed"): CheckResult => ({ check, group, status, coverage: "complete" });
const finished = (check: string, group: CheckResult["group"], status: CheckResult["status"] = "passed", findings: Finding[] = []): ProgressEvent => ({ type: "check-finished", result: row(check, group, status), findings });
const started = (check: string, group: CheckResult["group"]): ProgressEvent => ({ type: "check-started", check, group });

const WEARABLE_CODE: ProgressEvent[] = [
  started("file-format", "files"), finished("file-format", "files"),
  started("gltf-valid", "files"), finished("gltf-valid", "files"),
  started("metadata", "files"), finished("metadata", "files"),
  started("texture-count", "model"), finished("texture-count", "model"),
  started("triangle-count", "model"), finished("triangle-count", "model"),
  started("qr-code", "content"), finished("qr-code", "content")
];
const EMOTE_CODE: ProgressEvent[] = [
  started("file-format", "files"), finished("file-format", "files"),
  started("duration", "emote"), finished("duration", "emote"),
  started("audio", "emote"), finished("audio", "emote"),
  started("qr-code", "content"), finished("qr-code", "content")
];

const at = (steps: Step[], key: string): Step => steps.find((step) => step.key === key)!;
const states = (steps: Step[]): string[] => steps.map((step) => step.state);

// ── code checks ──────────────────────────────────────────────────────────────

describe("code stepper", () => {
  it("is all dots before the first event", () => {
    assert.deepEqual(states(codeSteps([])), ["todo", "todo", "todo", "todo"]);
    assert.deepEqual(codeSteps([]).map((step) => step.label), ["Files & metadata", "3D model", "Animation", "Content"]);
  });

  it("names the running check by its title and counts what is done, never n/N", () => {
    const steps = codeSteps(WEARABLE_CODE.slice(0, 9));
    assert.equal(at(steps, "files").state, "done");
    assert.equal(at(steps, "files").detail, "3 checks");
    assert.equal(at(steps, "model").state, "active");
    assert.equal(at(steps, "model").detail, "Checking Triangle count · 1 done");
    assert.equal(at(steps, "emote").state, "todo");
    assert.match(at(steps, "model").detail!, /^Checking [A-Z]/);
    assert.doesNotMatch(at(steps, "model").detail!, /\d+\/\d+/);
  });

  it("marks a group with no checks as not applicable once a later group starts", () => {
    const steps = codeSteps(WEARABLE_CODE);
    assert.equal(at(steps, "emote").state, "skipped");
    assert.equal(at(steps, "emote").detail, "Not applicable");
    assert.equal(at(steps, "content").state, "active");
    assert.equal(at(steps, "content").detail, "Checking QR codes · 1 done");
  });

  it("closes the last group when the run finishes", () => {
    assert.deepEqual(states(codeSteps(WEARABLE_CODE, true)), ["done", "done", "skipped", "done"]);
    assert.deepEqual(states(codeSteps(EMOTE_CODE, true)), ["done", "skipped", "done", "done"]);
    assert.equal(at(codeSteps(EMOTE_CODE, true), "emote").detail, "2 checks");
    assert.equal(at(codeSteps(EMOTE_CODE, true), "content").detail, "1 check");
  });
});

describe("stepper announcement", () => {
  it("announces state changes only, never the counters", () => {
    const upto = (n: number, done = false) => stepAnnouncement(codeSteps(WEARABLE_CODE.slice(0, n), done));
    assert.equal(upto(0), "");
    assert.equal(upto(1), "Files & metadata in progress");
    assert.equal(upto(3), upto(1));
    assert.equal(upto(7), "3D model in progress");
    assert.equal(upto(WEARABLE_CODE.length, true), "Content done");
  });
});
