import { getDefaultHttpMetrics } from "@dcl/http-server";
import { validateMetricsDeclaration } from "@dcl/metrics";
import { metricDeclarations as logsMetricDeclarations } from "@well-known-components/logger";
import { IMetricsComponent } from "@well-known-components/interfaces";

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logsMetricDeclarations,
  runs_accepted_total: {
    type: IMetricsComponent.CounterType,
    help: "Uploads accepted as runs"
  },
  runs_finished_total: {
    type: IMetricsComponent.CounterType,
    help: "Runs that concluded, by how they ended",
    labelNames: ["status"]
  },
  render_duration_seconds: {
    type: IMetricsComponent.HistogramType,
    help: "Wall time of a run from the render slot opening to its conclusion",
    buckets: [15, 30, 60, 120, 240, 480, 900]
  },
  refused_requests_total: {
    type: IMetricsComponent.CounterType,
    help: "Requests refused before a handler ran, by reason",
    labelNames: ["reason"]
  }
};

validateMetricsDeclaration(metricDeclarations);
