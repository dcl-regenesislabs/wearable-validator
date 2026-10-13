import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CheckResult, Finding, Result } from "@dcl-regenesislabs/wearable-validator";
import { Results } from "../src/results.js";
import { statusLabel } from "../src/rules.js";

/** The results page rendered once, without a browser. */

const row = (check: string, group: CheckResult["group"], status: CheckResult["status"] = "passed"): CheckResult => ({ check, group, status, coverage: "complete" });
const result = (passed: boolean | null): Result => ({ passed, checks: [row("file-format", "files", passed === false ? "failed" : "passed")], findings: [], captures: [], summary: { errors: passed === false ? 1 : 0, warnings: 0, checked: 1, skipped: 0 } });
const page = (res: Result, bare = false): string => renderToStaticMarkup(createElement(Results, { scope: "t", result: res, filter: "all", onFilter: () => undefined, bare }));

describe("results page", () => {
  it("stamps the code checks' own verdict and says the visual checks are not run here", () => {
    assert.match(page(result(true)), /stamp pass">Passed/);
    assert.match(page(result(false)), /stamp fail">Failed/);
    assert.match(page(result(null)), /stamp none">Incomplete/);
    assert.match(page(result(true)), /the 4 visual checks are not run here/);
    assert.doesNotMatch(page(result(true)), /visual review|run server/i);
  });

  it("calls a bare GLB's result an analysis, not a verdict", () => {
    assert.match(page(result(true), true), /stamp analysis">Model checks/);
  });
});

describe("statusLabel", () => {
  const finding = (severity: "error" | "warning"): Finding => ({ check: "texture-size", group: "model", severity, message: "", rule: "M-03", docs: "" });
  it("counts a failing rule's errors and a reviewed rule's warnings, so the list adds up to the verdict", () => {
    assert.equal(statusLabel("failed", Array.from({ length: 8 }, () => finding("error"))), "8 errors");
    assert.equal(statusLabel("failed", [finding("error")]), "1 error");
    assert.equal(statusLabel("warning", [finding("warning")]), "1 warning");
    assert.equal(statusLabel("passed", []), "Passed");
    assert.equal(statusLabel("skipped", []), "Not checked");
  });
});
