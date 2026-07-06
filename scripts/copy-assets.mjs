// tsc does not copy non-TS assets to dist/. The airport names reference is imported
// at runtime by the compiled server, so copy it (and any future data JSON) into dist/.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const assets = ["src/integrations/tbo/data/airportReference.json"];

for (const rel of assets) {
  const src = rel;
  const dest = rel.replace(/^src\//, "dist/");
  if (!existsSync(src)) {
    console.warn(`[copy-assets] missing source, skipped: ${src}`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`[copy-assets] ${src} -> ${dest}`);
}
