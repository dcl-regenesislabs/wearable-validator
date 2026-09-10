import { validate } from "@dcl-regenesislabs/wearable-validator";

const output = document.querySelector<HTMLPreElement>("#result")!;
const hash = "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4";

async function checkIntegrity() {
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
  output.textContent = "PASS: legacy and CIDv1 matching content passes; altered content reports a hash mismatch without crashing.";
  document.documentElement.dataset.testStatus = "passed";
}

checkIntegrity().catch((error: unknown) => {
  output.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  document.documentElement.dataset.testStatus = "failed";
});
