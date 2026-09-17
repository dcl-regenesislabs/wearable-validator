import { manifest } from "@dcl-regenesislabs/wearable-validator";
import type { HandlerContextWithPath } from "../../types.js";

/** What the site can offer and who the server thinks is calling; the only route without identity, so a failed sign-in is just `owner: null`. */
export async function healthHandler(context: Pick<HandlerContextWithPath<"identity" | "renderer" | "reviewer" | "runs", "/api/health">, "components" | "request">) {
  const { identity, renderer, reviewer, runs } = context.components;
  const caller = await identity.identify(context.request).catch(() => undefined);
  return {
    status: 200,
    body: {
      ok: true,
      visual: { renderer: renderer.available, reviewer: reviewer.kind },
      checks: runs.visualChecks,
      rulesVersion: manifest.version,
      // a service token is not a person: the site never greets it, and a leaked token reveals no owner name here
      owner: caller && caller.kind !== "service" ? caller.owner : null
    }
  };
}
