/**
 * Scans src/checks/<group>/<name>/index.ts for check definitions and writes src/source-links.json
 * (check → file + line). Run `npm run gen:sources` after moving a check; a
 * test fails when the committed map drifts from the code.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const CHECKS_DIR = join(import.meta.dirname, "src", "checks");
const OUT = join(import.meta.dirname, "src", "source-links.json");

export async function scanSourceLinks(): Promise<Record<string, { file: string; line: number }>> {
  const map: Record<string, { file: string; line: number }> = {};
  const files = (await readdir(CHECKS_DIR, { recursive: true }))
    .filter((entry) => entry.endsWith("index.ts") && entry.split("/").length === 3)
    .sort();
  for (const entry of files) {
    const lines = (await readFile(join(CHECKS_DIR, entry), "utf8")).split("\n");
    // the definition's identity line: `const meta: CheckMeta = { name: "…"`
    const index = lines.findIndex((line) => /\bname: "([a-z0-9-]+)"/.test(line));
    const match = index >= 0 ? lines[index].match(/\bname: "([a-z0-9-]+)"/) : null;
    if (match) map[match[1]] = { file: `src/checks/${relative(CHECKS_DIR, join(CHECKS_DIR, entry))}`, line: index + 1 };
  }
  return map;
}

if (process.argv[1]?.endsWith("generate-source-links.ts")) {
  const map = await scanSourceLinks();
  await writeFile(OUT, JSON.stringify(map, null, 2) + "\n");
  console.log(`wrote ${Object.keys(map).length} source links`);
}
