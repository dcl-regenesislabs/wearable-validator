import type { Lifecycle } from "@well-known-components/interfaces";
import { setupRouter } from "./controllers/routes.js";
import type { AppComponents, GlobalContext, TestComponents } from "./types.js";

export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>): Promise<void> {
  const { components, startComponents } = program;
  const globalContext: GlobalContext = { components };
  const router = await setupRouter(globalContext);
  components.server.use(router.middleware());
  components.server.use(router.allowedMethods());
  components.server.setContext(globalContext);
  await startComponents();
}
