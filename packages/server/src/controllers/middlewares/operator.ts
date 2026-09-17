import type { IHttpServerComponent } from "@dcl/core-commons";
import type { GlobalContext } from "../../types.js";
import { callerOf, type IdentityContext } from "./identity.js";
import { refused } from "./refusal.js";

export function operatorOnly(message: string): IHttpServerComponent.IRequestHandler<GlobalContext & IdentityContext> {
  return async (context, next) => (callerOf(context).operator ? next() : refused(context.components, 403, "not-operator", message));
}
