import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AccessVerifier } from "../src/adapters/access.js";
import { accessIdentity, chooseIdentity, firstOf, localIdentity, tokenIdentity, type IdentityRequest } from "../src/adapters/identity.js";

function request(headers: Record<string, string>): IdentityRequest {
  return { headers: new Headers(headers) };
}

/** Knows exactly one token; everything else is a stranger. */
const verifier: AccessVerifier = {
  verify: async (token) => (token === "good-token" ? { email: "curator@example.com", sub: "user-1" } : token === "bot-token" ? { serviceName: "slack-bot", sub: "" } : undefined)
};

const curator = { owner: "curator@example.com", kind: "access", operator: true, readOnly: false };

describe("identity providers", () => {
  it("localIdentity names every caller the same owner", async () => {
    assert.deepEqual(await localIdentity()(request({})), { owner: "local", kind: "local", operator: true, readOnly: false });
    assert.deepEqual(await localIdentity("anonymous")(request({ cookie: "CF_Authorization=good-token" })), { owner: "anonymous", kind: "local", operator: true, readOnly: false });
  });

  it("accessIdentity reads the forwarded header, then the CF_Authorization cookie, and refuses the rest", async () => {
    const identify = accessIdentity(verifier);
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token" })), curator);
    assert.deepEqual(await identify(request({ cookie: "theme=dark; CF_Authorization=good-token; other=1" })), curator);
    assert.equal(await identify(request({})), undefined);
    assert.equal(await identify(request({ cookie: "CF_Authorization=bad-token" })), undefined);
    assert.equal(await identify(request({ "cf-access-jwt-assertion": "bad-token" })), undefined);
  });

  it("service tokens are read-only operators; every person Access lets in is an operator who can still write", async () => {
    const identify = accessIdentity(verifier);
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "bot-token" })), { owner: "service:slack-bot", kind: "service", operator: true, readOnly: true });
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token" })), curator);
  });

  it("the header wins over the cookie, even when only the cookie would verify", async () => {
    const identify = accessIdentity(verifier);
    assert.equal(await identify(request({ "cf-access-jwt-assertion": "bad-token", cookie: "CF_Authorization=good-token" })), undefined);
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token", cookie: "CF_Authorization=bad-token" })), curator);
  });

  it("passes a verifier that cannot decide up to the caller instead of refusing", async () => {
    const down: AccessVerifier = { verify: async () => { throw new Error("Cloudflare Access certs answered 503."); } };
    await assert.rejects(accessIdentity(down)(request({ "cf-access-jwt-assertion": "any" })), /503/);
    assert.equal(await accessIdentity(down)(request({})), undefined, "nothing to verify, nothing to ask");
  });
});

describe("operator token", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const bot = { owner: "service:bot", kind: "service", operator: true, readOnly: true };

  it("recognises exactly the shared secret as the bot, a read-only operator", async () => {
    const identify = tokenIdentity(secret);
    assert.deepEqual(await identify(request({ authorization: `Bearer ${secret}` })), bot);
    assert.equal(await identify(request({ authorization: `Bearer ${secret.slice(0, -1)}x` })), undefined);
    assert.equal(await identify(request({ authorization: `Bearer ${secret}0` })), undefined);
    assert.equal(await identify(request({ authorization: secret })), undefined);
    assert.equal(await identify(request({})), undefined);
    assert.throws(() => tokenIdentity("short"), /at least 32/);
  });

  it("firstOf asks each provider in turn", async () => {
    const identify = firstOf(tokenIdentity(secret), accessIdentity(verifier));
    assert.deepEqual(await identify(request({ authorization: `Bearer ${secret}` })), bot);
    assert.deepEqual(await identify(request({ "cf-access-jwt-assertion": "good-token" })), curator);
    assert.equal(await identify(request({ authorization: "Bearer nope-nope-nope-nope-nope-nope-nope" })), undefined);
  });
});

describe("choosing the provider from the configuration", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  it("is local on loopback, anonymous only when asked, and refuses a public bind without Access", async () => {
    assert.equal(chooseIdentity({ host: "127.0.0.1", insecureAnonymous: false }).kind, "local");
    assert.equal(chooseIdentity({ host: "localhost", insecureAnonymous: false }).kind, "local");
    assert.equal(chooseIdentity({ host: "0.0.0.0", insecureAnonymous: true }).kind, "anonymous");
    assert.throws(() => chooseIdentity({ host: "0.0.0.0", insecureAnonymous: false }), /reachable from other machines/);
    assert.throws(() => chooseIdentity({ host: "127.0.0.1", teamDomain: "team", insecureAnonymous: false }), /both CF_ACCESS_TEAM_DOMAIN/);
  });

  it("names Cloudflare Access, and the operator token on top of any provider", async () => {
    assert.equal(chooseIdentity({ host: "0.0.0.0", teamDomain: "team", audience: "aud", insecureAnonymous: false }).kind, "cloudflare-access (team)");
    const withBot = chooseIdentity({ host: "127.0.0.1", operatorToken: secret, insecureAnonymous: false });
    assert.equal(withBot.kind, "local + operator token");
    assert.deepEqual(await withBot.identify(request({ authorization: `Bearer ${secret}` })), { owner: "service:bot", kind: "service", operator: true, readOnly: true });
    assert.deepEqual(await withBot.identify(request({})), { owner: "local", kind: "local", operator: true, readOnly: false });
  });
});
