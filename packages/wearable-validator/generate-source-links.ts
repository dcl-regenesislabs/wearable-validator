/**
 * Scans src/checks/*.ts for check definitions and writes src/source-links.json
 * (check → file + line). Run `npm run gen:sources` after moving a check; a
 * test fails when the committed map drifts from the code.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CHECKS_DIR = join(import.meta.dirname, "src", "checks");
const OUT = join(import.meta.dirname, "src", "source-links.json");

export async function scanSourceLinks(): Promise<Record<string, { file: string; line: number }>> {
  const map: Record<string, { file: string; line: number }> = {};
  for (const entry of (await readdir(CHECKS_DIR)).sort()) {
    if (!entry.endsWith(".ts")) continue;
    const lines = (await readFile(join(CHECKS_DIR, entry), "utf8")).split("\n");
    lines.forEach((line, i) => {
      const match = line.match(/^\s*name: "([a-z0-9-]+)"/);
      if (match) map[match[1]] = { file: `src/checks/${entry}`, line: i + 1 };
    });
  }
  return map;
}

if (process.argv[1]?.endsWith("generate-source-links.ts")) {
  const map = await scanSourceLinks();
  await writeFile(OUT, JSON.stringify(map, null, 2) + "\n");
  console.log(`wrote ${Object.keys(map).length} source links`);
}
