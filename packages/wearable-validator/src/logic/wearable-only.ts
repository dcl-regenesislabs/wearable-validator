/** appliesTo predicates for wearable-only model checks; the reason is internal (inapplicable checks are absent from results). */
import type { CheckContext } from "../types.js";

export const wearableMaterialsOnly = (ctx: CheckContext): true | string =>
  ctx.itemType === "wearable" ? true : "wearable material rules don't apply to emotes (prop budgets are covered by the props check, E-07)";

export const wearableGeometryOnly = (ctx: CheckContext): true | string =>
  ctx.itemType === "wearable" ? true : "wearable-only check — this item is an emote";
