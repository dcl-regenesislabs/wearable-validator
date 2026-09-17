import { PassThrough } from "node:stream";
import { NotFoundError } from "@dcl/http-commons";
import type { RunListener } from "../../logic/runs.js";
import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

const PING_MS = 15000;

/** Server-Sent Events for one run: replay after Last-Event-ID, then live until the run ends; a ping every 15 s keeps proxies from reaping the socket. */
export async function runEventsHandler(context: HandlerContextWithPath<"runs", "/api/runs/:id/events"> & IdentityContext) {
  const { runs } = context.components;
  const identity = callerOf(context);
  // replay everything after Last-Event-ID so a refresh or a late tab sees the whole run
  const after = Number(context.request.headers.get("last-event-id") ?? 0) || 0;
  const stream = new PassThrough();
  stream.write("retry: 2000\n\n");
  const listener: RunListener = {
    write: (chunk) => stream.write(chunk),
    end: () => stream.end(),
    once: (event, fn) => stream.once(event, fn),
    // an error, not a plain destroy: it is what makes the server close the socket under the stream
    destroy: () => stream.destroy(new Error("The event stream stopped draining."))
  };
  let detach: (() => void) | undefined;
  try {
    detach = await runs.follow(context.params.id, identity, after, listener);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (!detach) {
    stream.destroy();
    throw new NotFoundError("Unknown run.");
  }
  const ping = setInterval(() => {
    if (stream.writable) stream.write(": ping\n\n");
  }, PING_MS);
  ping.unref();
  stream.on("close", () => {
    clearInterval(ping);
    detach();
  });
  return { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }, body: stream };
}
