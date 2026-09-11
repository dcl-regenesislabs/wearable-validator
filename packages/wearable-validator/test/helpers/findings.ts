import type { CheckStatus, Finding, Result } from "../../src/types.js";

export function found(result: Result, check: string): Finding[] {
  return result.findings.filter((f) => f.check === check);
}

export function status(result: Result, check: string): CheckStatus | undefined {
  return result.checks.find((c) => c.check === check)?.status;
}

export function only(findings: Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}
