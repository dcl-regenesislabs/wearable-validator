import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { it } from "node:test";
import { localIdentity } from "../src/adapters/identity.js";
import { startTestServer } from "./components.js";

it("does not expose the local operator API to another browser origin", async () => {
  const server = await startTestServer({ identity: { kind: "local", identify: localIdentity() } });
  try {
    const run = await server.components.runs.accept({ identity: { owner: "local", kind: "local", operator: true, readOnly: false }, name: "unreleased.zip", bytes: new Uint8Array([1]), model: false, standalone: false });
    for (const path of ["/api/health", "/api/runs", `/api/runs/${run.id}/input.json`, "/api/logs", "/api/stats"]) {
      const crossSite = await fetch(server.base + path, { headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" } });
      assert.equal(crossSite.status, 403, path);
      assert.equal(crossSite.headers.get("access-control-allow-origin"), null, path);
      const legacy = await fetch(server.base + path, { headers: { origin: "https://attacker.example" } });
      assert.equal(legacy.headers.get("access-control-allow-origin"), null, path);
      const sameOrigin = await fetch(server.base + path, { headers: { "sec-fetch-site": "same-origin" } });
      assert.equal(sameOrigin.status, 200, path);
    }
    const preflight = await fetch(server.base + "/api/runs", { method: "OPTIONS", headers: { origin: "https://attacker.example", "access-control-request-method": "GET" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.stop();
    await rm(server.artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
