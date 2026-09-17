/** Nobody recognised → 401; the provider could not decide (Access certs unreachable) → 503, so a curator is asked to retry rather than told to sign in. */
import type { IHttpServerComponent } from "@dcl/core-commons";
import { NotAuthorizedError } from "@dcl/http-commons";
import { appLogger } from "../../adapters/log-buffer.js";
import { SignInUnavailableError } from "../../logic/errors.js";
import { apiSegment } from "../../logic/redact.js";
import type { GlobalContext, Identity } from "../../types.js";
import { refused } from "./refusal.js";

export const SIGN_IN_MESSAGE = "Sign in to use the run server.";

export type IdentityContext = { identity?: Identity };

export type ApiContext = IHttpServerComponent.DefaultContext<GlobalContext> & IdentityContext & { routerPath?: string };

/** The caller a handler behind the middleware can count on; a route mounted without it answers 401, never crashes. */
export function callerOf(context: IdentityContext): Identity {
  if (!context.identity) throw new NotAuthorizedError(SIGN_IN_MESSAGE);
  return context.identity;
}

export async function identityMiddleware(context: ApiContext, next: () => Promise<IHttpServerComponent.IResponse>): Promise<IHttpServerComponent.IResponse> {
  const { identity, logs } = context.components;
  let caller: Identity | undefined;
  try {
    caller = await identity.identify(context.request);
  } catch (error) {
    appLogger(logs, "http").warn("sign-in could not be verified", { error: error instanceof Error ? error.message : String(error) });
    throw new SignInUnavailableError();
  }
  if (!caller) return refused(context.components, 401, "no-identity", SIGN_IN_MESSAGE, { method: context.request.method, api: apiSegment(context.url.pathname) });
  context.identity = caller;
  return next();
}
