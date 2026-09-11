/** Facial-feature categories (eyebrows/eyes/mouth) ship PNG sets, not GLBs — mesh checks route on this. */
import type { CheckContext } from "../types.js";

export function isFacial(ctx: CheckContext): boolean {
  return ctx.category !== undefined && ctx.manifest.facialCategories.includes(ctx.category);
}
