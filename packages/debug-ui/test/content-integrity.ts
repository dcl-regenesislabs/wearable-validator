import { validate } from "@dcl-regenesislabs/wearable-validator";

import { hashVectors } from "../../wearable-validator/test/helpers/hash-vectors.js";

const output = document.querySelector<HTMLPreElement>("#result")!;
const hash = "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4";

async function checkIntegrity() {
  for (const { size, legacy, cidV1 } of hashVectors) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    for (const hash of [legacy, cidV1]) {
      const result = await validate({ files: new Map([["fixture.bin", bytes]]), content: [{ file: "fixture.bin", hash }] }, { checks: ["content-integrity"] });
      if (result.checks[0]?.status !== "passed") throw new Error(`Hash fixture failed for ${size} bytes: ${JSON.stringify(result)}`);
    }
  }
  for (const declaredHash of [hash, "QmZjTnYw2TFhn9Nn7tjmPSoTBoY7YRkwPzwSrSbabY24Kp"]) {
    const content = [{ file: "hello.txt", hash: declaredHash }];
    const options = { checks: ["content-integrity"] };
    const matching = await validate({ files: new Map([["hello.txt", new TextEncoder().encode("hello world\n")]]), content }, options);
    if (matching.checks[0]?.status !== "passed" || matching.findings.length !== 0) {
      throw new Error(`Matching content should pass: ${JSON.stringify(matching)}`);
    }
    const altered = await validate({ files: new Map([["hello.txt", new TextEncoder().encode("altered\n")]]), content }, options);
    if (altered.checks[0]?.status !== "failed" || altered.findings.length !== 1 || altered.findings[0]?.limit !== declaredHash || !altered.findings[0]?.measured) {
      throw new Error(`Altered content should report its hash mismatch: ${JSON.stringify(altered)}`);
    }
  }
  output.textContent = "PASS: legacy and CIDv1 empty/chunk-boundary/multi-chunk fixtures pass; matching content passes; altered content reports a hash mismatch without crashing.";
  document.documentElement.dataset.testStatus = "passed";
}

checkIntegrity().catch((error: unknown) => {
  output.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  document.documentElement.dataset.testStatus = "failed";
});
