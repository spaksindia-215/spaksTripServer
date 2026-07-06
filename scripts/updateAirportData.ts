// Regenerates the airport picker dataset from TBO and writes it into the client as a
// static asset:  client/public/airports.generated.json
//
//   npm run update:airports
//
// This is the monthly update mechanism: run it (from the whitelisted server egress IP —
// EndUserIp must be the server IP, same as every TBO call), commit the regenerated JSON,
// and redeploy the client. The client loads this file once and searches it locally — no
// per-keystroke API calls, and no dependency on a running endpoint.
//
// The dataset is "served codes ∩ names reference" so every option is actually bookable
// (which is the whole point of GetAirlineSectorList — avoid "No Result Found").
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  tboGetAirlineSectorList,
  buildDatasetFromResponse,
} from "../src/integrations/tbo/flight/airlineSectorList.js";

const here = dirname(fileURLToPath(import.meta.url)); // server/scripts
const OUT = resolve(here, "../../client/public/airports.generated.json");

async function main(): Promise<void> {
  console.log("[update:airports] Calling TBO GetAirlineSectorList...");
  const raw = await tboGetAirlineSectorList();
  const ds = buildDatasetFromResponse(raw);

  writeFileSync(
    OUT,
    JSON.stringify({
      updatedAt: ds.updatedAt,
      servedCount: ds.servedCount,
      namedCount: ds.namedCount,
      airlineSources: ds.airlineSources,
      airports: ds.airports,
    }),
  );

  console.log("[update:airports] Done.");
  console.log(`  Served codes      : ${ds.servedCount}`);
  console.log(`  Named (picker set): ${ds.namedCount}`);
  console.log(`  Airline sources   : ${ds.airlineSources.length}`);
  console.log(`  Written to        : ${OUT}`);
  const sample = ds.airports.slice(0, 5).map((a) => `${a.code} ${a.city}`).join(", ");
  console.log(`  Sample airports   : ${sample}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[update:airports] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
