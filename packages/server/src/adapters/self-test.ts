/**
 * Can this host render at all? A run that hangs looks the same whether WebGPU never came up or the content
 * servers refuse this network, so the server answers both questions at startup instead of leaving it to guesswork.
 * Previous hop: components.ts, once the port is open. Next hop: the operator log and GET /api/health.
 */
import { PREVIEW_URL, probeRenderEnvironment, type RenderEnvironment } from "@dcl-regenesislabs/wearable-validator/rendering";
import type { ILoggerComponent } from "@well-known-components/interfaces";
import { appLogger } from "./log-buffer.js";

export interface ReachabilityResult {
  url: string;
  status: number | null;
  ms: number;
  error?: string;
}

export interface SelfTestResult {
  environment: RenderEnvironment;
  reachability: ReachabilityResult[];
  ok: boolean;
}

/** The hosts a render needs: the pinned wrapper and the content servers the previewer loads the avatar from. */
export const RENDER_DEPENDENCIES = [`${PREVIEW_URL}index.html`, "https://peer.decentraland.org/content/status", "https://peer.decentraland.org/lambdas/status"];

async function reach(url: string, timeoutMs: number): Promise<ReachabilityResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return { url, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { url, status: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSelfTest(
  components: { logs: ILoggerComponent },
  options: { timeoutMs?: number; probe?: () => Promise<RenderEnvironment>; dependencies?: string[] } = {}
): Promise<SelfTestResult> {
  const log = appLogger(components.logs, "self-test");
  const timeoutMs = options.timeoutMs ?? 30000;
  const reachability = await Promise.all((options.dependencies ?? RENDER_DEPENDENCIES).map((url) => reach(url, Math.min(timeoutMs, 15000))));
  for (const result of reachability) {
    const fields = { url: result.url, status: result.status ?? "none", ms: result.ms, error: result.error };
    if (result.status && result.status < 400) log.info("dependency reachable", fields);
    else log.error("dependency unreachable: the previewer will hang waiting for it", fields);
  }
  const environment = await (options.probe ?? (() => probeRenderEnvironment({ timeoutMs })))();
  const fields = {
    browser: environment.browserVersion,
    adapter: environment.adapter ? `${environment.adapter.vendor}/${environment.adapter.architecture}${environment.adapter.isFallbackAdapter ? " (fallback)" : ""}` : "none",
    device: environment.device,
    ms: environment.ms,
    error: environment.error
  };
  if (environment.device) log.info("renderer self-test passed: WebGPU draws here", fields);
  else log.error("renderer self-test failed: no WebGPU device, every render will time out with an idle CPU", fields);
  return { environment, reachability, ok: environment.device && reachability.every((result) => result.status !== null && result.status < 400) };
}
