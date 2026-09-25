import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

it("never lets a file from a published item run as a page on the site's origin", async () => {
  const server = await startTestServer({ identity: { kind: "local", identify: localIdentity() } });
  const owner = { owner: "local", kind: "local", operator: true, readOnly: false } as const;
  try {
    const { id } = await server.components.runs.accept({ identity: owner, name: "item.zip", bytes: new Uint8Array([1]), model: false, standalone: false });
    const run = await server.components.runs.find(id, owner);
    assert.ok(run);
    await mkdir(join(run.dir, "item"), { recursive: true });
    await writeFile(join(run.dir, "item", "x.html"), "<script>fetch('/api/logs')</script>");
    await writeFile(join(run.dir, "item", "x.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    await writeFile(join(run.dir, "thumbnail.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const get = (path: string) => fetch(`${server.base}/api/runs/${id}/${path}`, { headers: { "sec-fetch-site": "same-origin" } });
    for (const path of ["item/x.html", "item/x.svg", "item/../item/x.html"]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), "application/octet-stream", path);
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment/, path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox/, path);
    }
    const image = await get("thumbnail.png");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("content-disposition"), null);
    assert.equal(image.headers.get("cache-control"), "private, no-store");
  } finally {
    await server.stop();
    await rm(server.artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
