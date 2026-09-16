import assert from "node:assert/strict";
import { describe, test } from "node:test";
import worker, { type Env } from "../worker.js";

function fakeAssets(): Env["ASSETS"] & { served: Request[] } {
  const served: Request[] = [];
  return {
    served,
    fetch: async (request) => {
      served.push(request);
      return new Response("asset", { status: 200 });
    }
  };
}

describe("site worker", () => {
  test("forwards /api requests to API_ORIGIN keeping method, headers and body", async () => {
    const assets = fakeAssets();
    const forwarded: Request[] = [];
    const env: Env = {
      ASSETS: assets,
      API_ORIGIN: "https://api.example.test",
      fetch: async (request) => {
        forwarded.push(request);
        return Response.json({ id: "abc" }, { status: 202, headers: { "x-upstream": "yes" } });
      }
    };
    const request = new Request("https://review.example.test/api/x?y=1", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": "token-value", cookie: "CF_Authorization=cookie-value", "content-type": "application/zip" },
      body: "zip bytes"
    });

    const response = await worker.fetch(request, env);

    assert.equal(forwarded.length, 1);
    const [upstream] = forwarded;
    assert.equal(upstream.url, "https://api.example.test/api/x?y=1");
    assert.equal(upstream.method, "POST");
    assert.equal(upstream.headers.get("cf-access-jwt-assertion"), "token-value");
    assert.equal(upstream.headers.get("cookie"), "CF_Authorization=cookie-value");
    assert.equal(upstream.headers.get("content-type"), "application/zip");
    assert.equal(await upstream.text(), "zip bytes");
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-upstream"), "yes");
    assert.deepEqual(await response.json(), { id: "abc" });
    assert.equal(assets.served.length, 0);
  });

  test("answers 404 JSON on /api when no API_ORIGIN is configured", async () => {
    const assets = fakeAssets();
    const env: Env = { ASSETS: assets, fetch: async () => assert.fail("nothing may be forwarded without API_ORIGIN") };

    const response = await worker.fetch(new Request("https://public.example.test/api/health"), env);

    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), { message: "No run server is configured for this site." });
    assert.equal(assets.served.length, 0);
  });

  test("serves everything else from ASSETS, even with API_ORIGIN set", async () => {
    const assets = fakeAssets();
    const env: Env = { ASSETS: assets, API_ORIGIN: "https://api.example.test", fetch: async () => assert.fail("static paths are never forwarded") };

    for (const path of ["/", "/index.html", "/samples/upper_body.zip", "/api", "/apix/y"]) {
      const response = await worker.fetch(new Request(`https://review.example.test${path}`), env);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), "asset", path);
    }
    assert.deepEqual(assets.served.map((request) => new URL(request.url).pathname), ["/", "/index.html", "/samples/upper_body.zip", "/api", "/apix/y"]);
  });
});
