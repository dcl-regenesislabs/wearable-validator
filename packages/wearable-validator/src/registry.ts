import type { CheckDefinition } from "./types.js";
import { filesChecks } from "./checks/files.js";
import { modelMaterialChecks } from "./checks/model-materials.js";
import { modelGeometryChecks } from "./checks/model-geometry.js";
import { emoteChecks } from "./checks/emote.js";
import { qrCodeCheck } from "./checks/qr-code.js";

/**
 * Registry order IS execution and reporting order — stable across runs
 * (files → model → emote → content; within a group, rule-book table order).
 */
export const registry: CheckDefinition[] = [
  ...filesChecks,
  ...modelMaterialChecks,
  ...modelGeometryChecks,
  ...emoteChecks,
  qrCodeCheck
];

const byName = new Map(registry.map((c) => [c.name, c]));
const byRule = new Map(registry.map((c) => [c.rule.toLowerCase(), c]));

/** Resolve a check name or a rule-book ID alias ('M-01') to its definition. */
export function resolveCheck(nameOrRule: string): CheckDefinition | undefined {
  return byName.get(nameOrRule) ?? byRule.get(nameOrRule.toLowerCase());
}

export const checks: Record<string, CheckDefinition> = Object.fromEntries(byName);
