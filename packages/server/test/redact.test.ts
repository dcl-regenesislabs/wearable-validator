import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apiSegment, encodeForLog, hostFingerprint } from "../src/logic/redact.js";

describe("what a refused request may leave in the log", () => {
  it("percent-encodes everything outside [A-Za-z0-9._~/-] and cuts long values", () => {
    assert.equal(encodeForLog("runs/abc-1.2_~"), "runs/abc-1.2_~");
    assert.equal(encodeForLog("a b[31m\"'"), "a%20b%1B%5B31m%22%27");
    assert.equal(encodeForLog("é"), "%C3%A9");
    assert.equal(encodeForLog("x".repeat(200), 10), "xxxxxxxxxx");
  });

  it("turns a Host header into eight hex characters and a length, never the text", () => {
    assert.match(hostFingerprint("attacker.example"), /^[0-9a-f]{8}\/16$/);
    assert.equal(hostFingerprint("attacker.example"), hostFingerprint("attacker.example"));
    assert.notEqual(hostFingerprint("attacker.example"), hostFingerprint("attacker.exampl3"));
    assert.match(hostFingerprint(undefined), /^[0-9a-f]{8}\/0$/);
    assert.equal(hostFingerprint(null), hostFingerprint(""));
  });

  it("keeps only the first path segment after /api/, encoded", () => {
    assert.equal(apiSegment("/api/runs/abc/events"), "runs");
    assert.equal(apiSegment("/api/stats"), "stats");
    assert.equal(apiSegment("/api/"), "");
    assert.equal(apiSegment("/api/<script>"), "%3Cscript%3E");
    assert.equal(apiSegment(`/api/${"a".repeat(60)}`), "a".repeat(40));
  });
});
