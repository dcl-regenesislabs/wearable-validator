/** The review CLI's argument reading: a file on disk is the item, whatever its path looks like; anything else is a reference. */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArgs } from "../src/cli/review.js";

const CONTRACT = "0x" + "ab".repeat(20);

describe("readArgs", () => {
  let root: string;
  let zip: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "review-args-"));
    await mkdir(join(root, "tokens"), { recursive: true });
    zip = join(root, "tokens", "shirt.zip");
    await writeFile(zip, "not really a zip");
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("reads a zip whose path contains /tokens/ as a file, not as an NFT token page", async () => {
    const args = await readArgs([zip, "--no-ai"]);
    assert.equal(args.file, zip);
    assert.equal(args.reference, undefined);
  });

  it("resolves a URN or a shop URL to catalyst candidates, and still hints at a token page URL", async () => {
    const urn = `urn:decentraland:matic:collections-v2:${CONTRACT}:12`;
    assert.deepEqual((await readArgs([urn, "--no-ai"])).reference, [urn]);
    const shop = await readArgs([`https://decentraland.org/shop/item/${CONTRACT}/12`, "--no-ai"]);
    assert.equal(shop.reference?.length, 2);
    assert.equal(shop.file, `https://decentraland.org/shop/item/${CONTRACT}/12`);
    await assert.rejects(readArgs([`https://decentraland.org/marketplace/contracts/${CONTRACT}/tokens/5`, "--no-ai"]), /shop page instead/);
  });

  it("treats a path that does not exist as a file path, so the missing-file error names it", async () => {
    const missing = join(root, "tokens", "gone.zip");
    const args = await readArgs([missing, "--no-ai"]);
    assert.deepEqual([args.file, args.reference], [missing, undefined]);
  });
});
