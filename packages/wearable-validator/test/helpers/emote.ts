import { validate } from "../../src/index.js";
import type { Finding, Result } from "../../src/index.js";
import { syntheticGlb, type SyntheticOptions } from "./synthetic.js";

/** Validate a synthetic bare GLB as an emote, restricted to the given checks. */
export async function runChecks(glbOptions: SyntheticOptions, checks: string[]): Promise<Result> {
  const glb = await syntheticGlb(glbOptions);
  return validate(glb, { checks, itemType: "emote" });
}

export function of(result: Result, check: string): Finding[] {
  return result.findings.filter((f) => f.check === check);
}
