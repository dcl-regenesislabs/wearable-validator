export { validate } from "./validate.js";
export { checks, registry, resolveCheck } from "./registry.js";
export { explanations } from "./explanations.js";
export { manifest, effectiveTriangleLimit, AVATAR_BONE_NAMES, AVATAR_CORE_BONE_NAMES } from "./manifest/index.js";
export type {
  Input, Options, Result, Finding, CheckResult, CheckDefinition, CheckContext,
  Group, Severity, CheckStatus, ItemType, NormalizedItem, ParsedModel
} from "./types.js";
