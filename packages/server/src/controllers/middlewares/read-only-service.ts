/** A service identity reads everything and changes nothing, so a leaked bot secret cannot spend renders or model calls. */
import type { IHttpServerComponent } from "@dcl/core-commons";
import type { GlobalContext } from "../../types.js";
import { callerOf, type IdentityContext } from "./identity.js";
import { refused } from "./refusal.js";

export async function readOnlyServiceMiddleware(
  context: IHttpServerComponent.DefaultContext<GlobalContext> & IdentityContext,
  next: () => Promise<IHttpServerComponent.IResponse>
): Promise<IHttpServerComponent.IResponse> {
  return callerOf(context).readOnly ? refused(context.components, 403, "read-only-service", "The operator token is read-only: it cannot start or cancel a run.") : next();
}
