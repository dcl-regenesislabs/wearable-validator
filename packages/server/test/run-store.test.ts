/** The run folder's item/ writer: what a hostile or merely odd content list may and may not do to the disk. */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalystItem } from "@dcl-regenesislabs/wearable-validator";
import { writeEntity } from "../src/logic/run-store.js";

function item(files: Record<string, Uint8Array>): CatalystItem {
  const map = new Map(Object.entries(files));
  return { urn: "urn:decentraland:matic:collections-v2:0x1:1", id: "bafyentity", name: "Item", metadata: {}, files: map, content: [...map.keys()].map((file) => ({ file, hash: "bafyhash" })) };
}

describe("writeEntity", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "run-store-"));
  });
  after(() => rm(root, { recursive: true, force: true }));

  async function folder(): Promise<string> {
    return mkdtemp(join(root, "run-"));
  }

  it("writes each file under item/ and entity.json beside it", async () => {
    const dir = await folder();
    await writeEntity(dir, item({ "model.glb": new Uint8Array([1]), "textures/skin.png": new Uint8Array([2]) }));
    assert.ok((await stat(join(dir, "item", "textures", "skin.png"))).isFile());
    assert.ok((await stat(join(dir, "entity.json"))).isFile());
  });

  it("refuses two names that differ only in letter case, before writing anything", async () => {
    const dir = await folder();
    await assert.rejects(writeEntity(dir, item({ "model.glb": new Uint8Array([1]), "Model.glb": new Uint8Array([2]) })), { message: 'The item lists "Model.glb" twice with different letter case; the run folder cannot hold both.' });
    await assert.rejects(stat(join(dir, "item")), "nothing was written");
  });

  it("answers the creator sentence, never the server's path, when the file system refuses a name", async () => {
    const dir = await folder();
    // a file listed beside a folder of the same name: mkdir or writeFile fails with ENOTDIR/EEXIST naming the absolute target
    await assert.rejects(writeEntity(dir, item({ a: new Uint8Array([1]), "a/b": new Uint8Array([2]) })), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The item lists a file path that cannot be stored: "a/b".');
      assert.ok(!error.message.includes(dir));
      return true;
    });
    await assert.rejects(writeEntity(dir, item({ "x\0y.glb": new Uint8Array([1]) })), /cannot be stored: "x\0y\.glb"/);
    await assert.rejects(writeEntity(dir, item({ [`${"n".repeat(256)}.glb`]: new Uint8Array([1]) })), /cannot be stored/);
    await assert.rejects(writeEntity(dir, item({ "../escape.glb": new Uint8Array([1]) })), /cannot be stored: "\.\.\/escape\.glb"/);
  });
});
