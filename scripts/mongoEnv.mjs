import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../.env") });

export function getMongoUri() {
  const uri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("Set MONGO_URI or MONGODB_URI in server/.env");
  }
  return uri;
}
