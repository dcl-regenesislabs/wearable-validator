import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { AccessVerifier } from "../src/access.js";
import { accessIdentity, firstOf, localIdentity, tokenIdentity } from "../src/identity.js";

function request(headers: Record<string, string>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  for (const [name, value] of Object.entries(headers)) req.headers[name] = value;
  return req;
}

/** Knows exactly one token; everything else is a stranger. */
const verifier: AccessVerifier = {
  verify: async (token) => (token === "good-token" ? { email: "curator@example.com", sub: "user-1" } : token === "bot-token" ? { serviceName: "slack-bot", sub: "" } : undefined)
};

describe("identity providers", () => {
  it("localIdentity names every caller the same owner", async () => {
    assert.deepEqual(await localIdentity()(request({})), { owner: "local", kind: "local", operator: true });
    assert.deepEqual(await localIdentity("anonymous")(request({ cookie: "CF_Authorization=good-token" })), { owner: "anonymous", kind: "local", operator: true });
  });

  it("accessIdentity reads the forwarded header, then the CF_Authorization cookie, and refuses the rest", async () => {
    const identify = accessIdentity(verifier);
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token" })), { owner: "curator@example.com", kind: "access", operator: false });
    assert.deepEqual(await identify(request({ cookie: "theme=dark; CF_Authorization=good-token; other=1" })), { owner: "curator@example.com", kind: "access", operator: false });
    assert.equal(await identify(request({})), undefined);
    assert.equal(await identify(request({ cookie: "CF_Authorization=bad-token" })), undefined);
    assert.equal(await identify(request({ "cf-access-jwt-assertion": "bad-token" })), undefined);
  });

  it("service tokens are operators, listed emails are operators, other people are not", async () => {
    const identify = accessIdentity(verifier, [" Lead@Example.com ", ""]);
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "bot-token" })), { owner: "service:slack-bot", kind: "service", operator: true });
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token" })), { owner: "curator@example.com", kind: "access", operator: false });
    const lead: AccessVerifier = { verify: async () => ({ email: "lead@example.com", sub: "u" }) };
    assert.deepEqual(await accessIdentity(lead, ["lead@example.com"])(request({ "cf-access-jwt-assertion": "x" })), { owner: "lead@example.com", kind: "access", operator: true });
  });

  it("the header wins over the cookie, even when only the cookie would verify", async () => {
    const identify = accessIdentity(verifier);
    assert.equal(await identify(request({ "cf-access-jwt-assertion": "bad-token", cookie: "CF_Authorization=good-token" })), undefined);
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token", cookie: "CF_Authorization=bad-token" })), { owner: "curator@example.com", kind: "access", operator: false });
  });
});

describe("operator token", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  it("recognises exactly the shared secret as the bot, an operator", async () => {
    const identify = tokenIdentity(secret);
    assert.deepEqual(await identify(request({ authorization: `Bearer ${secret}` })), { owner: "service:bot", kind: "service", operator: true });
    assert.equal(await identify(request({ authorization: `Bearer ${secret.slice(0, -1)}x` })), undefined);
    assert.equal(await identify(request({ authorization: `Bearer ${secret}0` })), undefined);
    assert.equal(await identify(request({ authorization: secret })), undefined);
    assert.equal(await identify(request({})), undefined);
    assert.throws(() => tokenIdentity("short"), /at least 32/);
  });

  it("firstOf asks each provider in turn", async () => {
    const identify = firstOf(tokenIdentity(secret), accessIdentity(verifier));
    assert.deepEqual(await identify(request({ authorization: `Bearer ${secret}` })), { owner: "service:bot", kind: "service", operator: true });
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token" })), { owner: "curator@example.com", kind: "access", operator: false });
    assert.equal(await identify(request({ authorization: "Bearer nope-nope-nope-nope-nope-nope-nope" })), undefined);
  });
});
