import type { IFetchComponent, IHttpServerComponent } from "@dcl/core-commons";
import type { IBaseComponent, IConfigComponent, ILoggerComponent, IMetricsComponent } from "@well-known-components/interfaces";
import type { CaptureRecord } from "@dcl-regenesislabs/wearable-validator";
import type { IIdentityComponent } from "./adapters/identity.js";
import type { ILogBufferComponent } from "./adapters/log-buffer.js";
import type { IRendererComponent } from "./adapters/renderer.js";
import type { IReviewerComponent } from "./adapters/reviewer.js";
import type { IBuildInfoComponent } from "./adapters/build-info.js";
import type { ISiteComponent } from "./adapters/site.js";
import type { IQueueComponent } from "./logic/queue.js";
import type { IRunStoreComponent } from "./logic/run-store.js";
import type { IRunsComponent } from "./logic/runs.js";
import type { metricDeclarations } from "./metrics.js";

export type GlobalContext = {
  components: BaseComponents;
};

export type BaseComponents = {
  config: IConfigComponent;
  logs: ILoggerComponent;
  logBuffer: ILogBufferComponent;
  server: IHttpServerComponent<GlobalContext>;
  metrics: IMetricsComponent<keyof typeof metricDeclarations> & { registry: IMetricsComponent.Registry };
  identity: IIdentityComponent;
  renderer: IRendererComponent;
  reviewer: IReviewerComponent;
  runStore: IRunStoreComponent;
  queue: IQueueComponent;
  runs: IRunsComponent;
  site: ISiteComponent;
  buildInfo: IBuildInfoComponent;
};

export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent;
};

export type TestComponents = BaseComponents & {
  localFetch: IFetchComponent;
};

export type HandlerContextWithPath<ComponentNames extends keyof AppComponents, Path extends string = string> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{ components: Pick<AppComponents, ComponentNames> }>,
  Path
>;

export type Context<Path extends string = string> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>;

export interface Identity {
  owner: string;
  kind: "local" | "access" | "service";
  /** Sees every run, the stats and the log: service tokens (the Slack bot) and the emails in OPERATORS. Local runs are always operators. */
  operator: boolean;
  /** Service identities read everything and change nothing: they never start or cancel a run. */
  readOnly: boolean;
}

export type RunEventType = "check" | "gate" | "stage" | "queue" | "capture" | "review" | "done" | "error";

export interface RunEvent {
  id: number;
  type: RunEventType;
  data: unknown;
}

export interface RunSink {
  id: string;
  dir: string;
  emit(type: RunEventType, data: unknown): void;
  capture(capture: CaptureRecord): Promise<void>;
}

/** One of the caller's runs, as GET /api/runs lists them; `owner` only when an operator asked for everyone's. */
export interface RunSummary {
  id: string;
  name: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
  queued: boolean;
  owner?: string;
}

/** position 0 means running. */
export interface QueuePosition {
  position: number;
  ahead: number;
  running: number;
  averageRunMs: number | null;
  etaMs: number | null;
}

export interface QueueEntry {
  position: number;
  mine: boolean;
  /** Only your own items are named; another curator's item is just "an item". */
  id?: string;
  name?: string;
  since: number;
}

export interface QueueState {
  running: QueueEntry[];
  waiting: QueueEntry[];
  averageRunMs: number | null;
  maxConcurrentRuns: number;
}
