import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRequest } from "../src/api.js";

describe("run request", () => {
  it("uploads zip bytes under their file name", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const { url, init } = runRequest(bytes, "my item.zip", { model: true, standalone: false });
    assert.equal(url, "/api/runs");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "content-type": "application/zip", "x-file-name": "my%20item.zip" });
    assert.ok(init.body instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(init.body)], [0x50, 0x4b, 0x03, 0x04]);
  });

  it("sends a published item as a JSON reference the server fetches itself", () => {
    const reference = "urn:decentraland:matic:collections-v2:0xabc:12";
    const { url, init } = runRequest({ reference }, "Shirt", { model: false, standalone: true });
    assert.equal(url, "/api/runs?model=0&standalone=1");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "content-type": "application/json" });
    assert.equal(typeof init.body, "string");
    assert.deepEqual(JSON.parse(init.body as string), { reference });
  });
});
