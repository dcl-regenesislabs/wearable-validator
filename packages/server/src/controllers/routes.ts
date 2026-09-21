/** The HTTP contract: errors → Host and same-site checks → health → identity and access log → API → site. */
import { Router } from "@dcl/http-server";
import type { GlobalContext } from "../types.js";
import { cancelRunHandler } from "./handlers/cancel-run-handler.js";
import { createRunHandler } from "./handlers/create-run-handler.js";
import { errorHandler } from "./handlers/error-handler.js";
import { getRunHandler } from "./handlers/get-run-handler.js";
import { healthHandler } from "./handlers/health-handler.js";
import { listRunsHandler } from "./handlers/list-runs-handler.js";
import { logsHandler } from "./handlers/logs-handler.js";
import { notFoundHandler } from "./handlers/not-found-handler.js";
import { queueHandler } from "./handlers/queue-handler.js";
import { runEventsHandler } from "./handlers/run-events-handler.js";
import { runFileHandler } from "./handlers/run-file-handler.js";
import { siteHandler } from "./handlers/site-handler.js";
import { statsHandler } from "./handlers/stats-handler.js";
import { accessLogMiddleware } from "./middlewares/access-log.js";
import { createHostCheckMiddleware } from "./middlewares/host-check.js";
import { identityMiddleware } from "./middlewares/identity.js";
import { operatorOnly } from "./middlewares/operator.js";
import { readOnlyServiceMiddleware } from "./middlewares/read-only-service.js";
import { sameSiteOnly } from "./middlewares/same-site.js";

export async function setupRouter({ components }: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>();
  router.use(errorHandler);
  router.use(await createHostCheckMiddleware(components));
  router.use("/api/(.*)", sameSiteOnly("Cross-site requests cannot access the run server."));

  router.get("/api/health", healthHandler);
  // registered after the health route so a probe never needs a caller; every other /api layer runs behind these two
  router.use("/api/(.*)", accessLogMiddleware, identityMiddleware);

  router.get("/api/runs", listRunsHandler);
  router.post("/api/runs", readOnlyServiceMiddleware, createRunHandler);
  router.get("/api/queue", queueHandler);
  router.get("/api/stats", operatorOnly("Only operators can read the stats."), statsHandler);
  router.get("/api/logs", operatorOnly("Only operators can read the log."), logsHandler);
  router.get("/api/runs/:id", getRunHandler);
  router.delete("/api/runs/:id", readOnlyServiceMiddleware, cancelRunHandler);
  router.get("/api/runs/:id/events", runEventsHandler);
  router.get("/api/runs/:id/(.*)", runFileHandler);
  router.all("/api/(.*)", notFoundHandler);

  router.get("/(.*)", siteHandler);
  return router;
}
