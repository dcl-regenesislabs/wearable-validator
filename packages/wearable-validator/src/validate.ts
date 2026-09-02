import { loadInput } from "./loader.js";
import { registry, resolveCheck } from "./registry.js";
import type { CheckContext, CheckDefinition, CheckResult, Finding, Group, Input, Options, Result } from "./types.js";
import { docsUrl } from "./types.js";

const CORE_GROUPS: Group[] = ["files", "model", "emote", "content"];

export async function validate(input: Input, options: Options = {}): Promise<Result> {
  validateOptions(options);

  const loaded = await loadInput(input, options);
  if (loaded.fatal) {
    return {
      passed: false,
      checks: [{ check: "file-format", group: "files", status: "failed" }],
      findings: loaded.fatal,
      summary: { errors: loaded.fatal.length, warnings: 0, checked: 1, skipped: 0 }
    };
  }
  const ctx = loaded.ctx!;

  const selected = selectChecks(ctx, options);
  const findings: Finding[] = [];
  const checkResults: CheckResult[] = [];
  let skipped = 0;

  for (const check of selected) {
    const started = Date.now();
    const applicable = check.appliesTo ? check.appliesTo(ctx) : true;
    if (applicable !== true) continue; // inapplicable checks are ABSENT, not skipped

    if (check.categoryDependent && !ctx.category) {
      const finding: Finding = {
        check: check.name,
        group: check.group,
        severity: "warning",
        message: `Can't verify ${check.title.toLowerCase()} — the category is unknown and its limits depend on it. Pass --category (or metadata) to check exactly.`,
        data: { reason: "category-unknown" },
        rule: check.rule,
        docs: docsUrl(check.name)
      };
      findings.push(finding);
      checkResults.push({ check: check.name, group: check.group, status: "warning", durationMs: Date.now() - started });
      continue;
    }

    if (ctx.parseError && needsParsedModel(check) && ctx.models.length === 0) {
      checkResults.push({ check: check.name, group: check.group, status: "skipped", skipReason: ctx.parseError });
      skipped++;
      continue;
    }

    try {
      const checkFindings = await check.run(ctx);
      findings.push(...checkFindings);
      const hasError = checkFindings.some((f) => f.severity === "error");
      const hasWarning = checkFindings.some((f) => f.severity === "warning");
      checkResults.push({
        check: check.name,
        group: check.group,
        status: hasError ? "failed" : hasWarning ? "warning" : "passed",
        durationMs: Date.now() - started
      });
    } catch (err) {
      checkResults.push({
        check: check.name,
        group: check.group,
        status: "errored",
        skipReason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started
      });
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const checked = checkResults.filter((c) => c.status !== "skipped").length;

  return {
    passed: computePassed(ctx, options, selected, checkResults, errors),
    checks: checkResults,
    findings,
    summary: { errors, warnings, checked, skipped }
  };
}

function validateOptions(options: Options): void {
  for (const group of options.groups ?? []) {
    if (group === "rendering") throw new Error("The 'rendering' group needs the optional entry: npm i @dcl-regenesislabs/wearable-validator-rendering (not yet released — see the plan).");
    if (!["files", "model", "emote", "content"].includes(group)) throw new Error(`Unknown group "${group}". Valid: files, model, emote, content.`);
  }
  for (const name of options.checks ?? []) {
    if (!resolveCheck(name)) throw new Error(`Unknown check "${name}". Run \`wearable-validator checks\` to list them.`);
  }
}

function selectChecks(ctx: CheckContext, options: Options): CheckDefinition[] {
  if (options.checks && options.checks.length > 0) {
    const wanted = new Set(options.checks.map((c) => resolveCheck(c)!.name));
    return registry.filter((c) => wanted.has(c.name));
  }
  const groups = new Set<Group>(options.groups ?? CORE_GROUPS);
  return registry.filter((c) => groups.has(c.group));
}

function needsParsedModel(check: CheckDefinition): boolean {
  return check.group === "model" || check.group === "emote";
}

function computePassed(ctx: CheckContext, options: Options, selected: CheckDefinition[], results: CheckResult[], errors: number): boolean | null {
  if (ctx.inputKind === "glb" || ctx.inputKind === "png-set") return null; // bare inputs never mint a verdict
  const requestedSubset = Boolean(options.checks?.length) || Boolean(options.groups && options.groups.length < CORE_GROUPS.length);
  if (requestedSubset) return null; // partial run
  if (results.some((r) => r.status === "skipped" || r.status === "errored")) return null; // couldn't assert everything
  return errors === 0;
}
