/** A cookie-riding call from another site never starts or cancels a run; the upload's content type is the second lock, for browsers too old to stamp Sec-Fetch-Site. */
import type { IHttpServerComponent } from "@dcl/core-commons";
import type { GlobalContext } from "../../types.js";
import { refused } from "./refusal.js";

export function sameSiteOnly(message: string): IHttpServerComponent.IRequestHandler<GlobalContext> {
  return async (context, next) => {
    const site = context.request.headers.get("sec-fetch-site");
    return site !== null && site !== "same-origin" && site !== "none" ? refused(context.components, 403, "cross-site", message) : next();
  };
}
