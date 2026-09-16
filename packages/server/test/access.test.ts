import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createAccessVerifier, type AccessJwk } from "../src/access.js";

const TEAM = "example-team";
const AUD = "aud-tag-1234";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const NOW_MS = 1_800_000_000_000;

interface Pair {
  kid: string;
  privateKey: KeyObject;
  jwk: AccessJwk;
}

function pair(kid: string): Pair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  return { kid, privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: String(exported.n), e: String(exported.e) } };
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { email: "curator@example.com", sub: "user-1", iss: ISSUER, aud: [AUD], exp: Math.floor(NOW_MS / 1000) + 600, iat: Math.floor(NOW_MS / 1000), ...overrides };
}

/** A JWT signed the way Cloudflare signs one (RS256), or deliberately wrong when `alg` says so. */
function token(key: Pair, payload: Record<string, unknown>, alg = "RS256"): string {
  const head = encode({ alg, kid: key.kid, typ: "JWT" });
  const body = encode(payload);
  const signature = alg === "none" ? ""
    : alg === "HS256" ? createHmac("sha256", "shared-secret").update(`${head}.${body}`).digest("base64url")
    : sign("sha256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

const current = pair("kid-current");

function verifier(keys: () => Promise<AccessJwk[]>, clock: { now: number } = { now: NOW_MS }) {
  return createAccessVerifier({ teamDomain: TEAM, audience: AUD, fetchKeys: keys, now: () => clock.now });
}

describe("Cloudflare Access verifier", () => {
  it("accepts a token signed by a published key for this team and audience", async () => {
    const verify = verifier(async () => [current.jwk]);
    assert.deepEqual(await verify.verify(token(current, claims())), { email: "curator@example.com", sub: "user-1" });
    assert.deepEqual(await verify.verify(token(current, claims({ aud: AUD }))), { email: "curator@example.com", sub: "user-1" }, "aud may be a plain string");
  });

  it("rejects the wrong audience, an expired token, the wrong issuer and a missing email", async () => {
    const verify = verifier(async () => [current.jwk]);
    assert.equal(await verify.verify(token(current, claims({ aud: ["other-app"] }))), undefined);
    assert.equal(await verify.verify(token(current, claims({ exp: Math.floor(NOW_MS / 1000) }))), undefined, "exp equal to now is expired");
    assert.equal(await verify.verify(token(current, claims({ exp: "soon" }))), undefined);
    assert.equal(await verify.verify(token(current, claims({ iss: "https://other-team.cloudflareaccess.com" }))), undefined);
    assert.equal(await verify.verify(token(current, claims({ email: undefined }))), undefined);
    assert.equal(await verify.verify(token(current, claims({ email: "" }))), undefined);
  });

  it("rejects alg none, HS256 and a tampered payload", async () => {
    const verify = verifier(async () => [current.jwk]);
    assert.equal(await verify.verify(token(current, claims(), "none")), undefined);
    assert.equal(await verify.verify(token(current, claims(), "HS256")), undefined);
    const [head, , signature] = token(current, claims()).split(".");
    assert.equal(await verify.verify(`${head}.${encode(claims({ email: "attacker@example.com" }))}.${signature}`), undefined);
    assert.equal(await verify.verify("not-a-jwt"), undefined);
    assert.equal(await verify.verify(""), undefined);
  });

  it("refreshes the keys once for an unknown kid and finds a rotated key", async () => {
    const rotated = pair("kid-rotated");
    const clock = { now: NOW_MS };
    let calls = 0;
    const verify = verifier(async () => (++calls === 1 ? [current.jwk] : [current.jwk, rotated.jwk]), clock);
    assert.deepEqual(await verify.verify(token(current, claims())), { email: "curator@example.com", sub: "user-1" });
    assert.equal(calls, 1);
    assert.equal(await verify.verify(token(rotated, claims())), undefined, "inside the minute after a fetch nothing is asked again");
    assert.equal(calls, 1);
    clock.now += 61_000;
    assert.equal((await verify.verify(token(rotated, claims())))?.email, "curator@example.com");
    assert.equal(calls, 2, "one refresh for the unknown kid");
    assert.equal((await verify.verify(token(rotated, claims())))?.email, "curator@example.com");
    assert.equal(calls, 2, "the rotated key is cached");
  });

  it("gives up on a kid the certs never publish and refreshes at most once a minute", async () => {
    const unknown = pair("kid-unknown");
    const clock = { now: NOW_MS };
    let calls = 0;
    const verify = verifier(async () => {
      calls++;
      return [current.jwk];
    }, clock);
    assert.equal(await verify.verify(token(unknown, claims())), undefined);
    assert.equal(calls, 1);
    assert.equal(await verify.verify(token(unknown, claims())), undefined);
    assert.equal(calls, 1, "no second fetch inside the minute");
    clock.now += 59_000;
    assert.equal(await verify.verify(token(unknown, claims())), undefined);
    assert.equal(calls, 1);
    clock.now += 2_000;
    assert.equal(await verify.verify(token(unknown, claims())), undefined);
    assert.equal(calls, 2, "a minute later it asks again");
    assert.deepEqual(await verify.verify(token(current, claims())), { email: "curator@example.com", sub: "user-1" }, "known keys keep working meanwhile");
  });

  it("ignores keys that are not RSA and surfaces a failed certs fetch", async () => {
    const verify = verifier(async () => [{ kid: "kid-ec", kty: "EC", n: "", e: "" }, current.jwk]);
    assert.deepEqual(await verify.verify(token(current, claims())), { email: "curator@example.com", sub: "user-1" });
    const failing = verifier(async () => {
      throw new Error("Cloudflare Access certs answered 503.");
    });
    await assert.rejects(failing.verify(token(current, claims())), /503/);
  });
});
