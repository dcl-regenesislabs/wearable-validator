/** Joint-name helpers shared by the skeleton and spring-bones checks. */
import type { CheckContext } from "../types.js";

export function isSpringBoneName(ctx: CheckContext, name: string): boolean {
  return name.toLowerCase().includes(ctx.manifest.skeleton.springBoneToken.toLowerCase());
}
