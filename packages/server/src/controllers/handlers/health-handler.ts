import { manifest } from "@dcl-regenesislabs/wearable-validator";
import type { HandlerContextWithPath } from "../../types.js";

/** What the site can offer and who the server thinks is calling; the only route without identity, so a failed sign-in is just `owner: null`. */
export async function healthHandler(context: Pick<HandlerContextWithPath<"identity" | "renderer" | "reviewer" | "runs" | "buildInfo", "/api/health">, "components" | "request">) {
  const { identity, renderer, reviewer, runs, buildInfo } = context.components;
  const caller = await identity.identify(context.request).catch(() => undefined);
  const person = caller && caller.kind !== "service" ? caller : undefined;
  return {
    status: 200,
    body: {
      ok: true,
      visual: { renderer: renderer.available, reviewer: reviewer.kind },
      checks: runs.visualChecks,
      rulesVersion: manifest.version,
      build: { version: buildInfo.version, commit: buildInfo.commit, builtAt: buildInfo.builtAt, startedAt: buildInfo.startedAt },
      // a service token is not a person: the site never greets it, and a leaked token reveals no owner name here
      owner: person ? person.owner : null,
      operator: person?.operator ?? false
    }
  };
}
