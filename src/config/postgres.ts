import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "./env";
import { logger } from "../lib/logger";

// PostgreSQL connection pool — the source of truth for financial transactions.
// This sits ALONGSIDE MongoDB; it never replaces it. MongoDB still owns all
// existing user/booking/partner data.
//
// Graceful degradation contract: if DATABASE_URL is unset or Postgres is
// unreachable, this module must NOT crash the process. Construction of the Pool
// is lazy/tolerant, testConnection() swallows errors, and query() throws only to
// its caller (every caller wraps it in try/catch).

let pool: Pool | null = null;

// `idle` connection errors fire asynchronously on the pool, not on a query
// promise — without this handler an idle backend drop would crash the process.
function attachPoolErrorHandler(p: Pool): void {
  p.on("error", (err) => {
    logger.error({ event: "pg_pool_error", error: err.message }, "PostgreSQL idle client error");
  });
}

export function getPool(): Pool | null {
  if (pool) return pool;
  if (!env.databaseUrl) {
    // No connection string configured — operate in MongoDB-only mode.
    return null;
  }
  pool = new Pool({
    connectionString: env.databaseUrl,
    // Keep the pool small; this DB only handles payment writes, not app traffic.
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  attachPoolErrorHandler(pool);
  return pool;
}

/**
 * Run a parameterised query. Throws to the caller on any failure (no internal
 * try/catch) — callers are responsible for handling errors. Throws immediately
 * if Postgres is not configured so callers can detect MongoDB-only mode.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const p = getPool();
  if (!p) {
    throw new Error("PostgreSQL is not configured (DATABASE_URL is empty)");
  }
  return p.query<T>(text, params as never[]);
}

/**
 * Acquire a client for multi-statement transactions (BEGIN/COMMIT). Caller MUST
 * release(). Throws if Postgres is not configured.
 */
export async function getClient(): Promise<PoolClient> {
  const p = getPool();
  if (!p) {
    throw new Error("PostgreSQL is not configured (DATABASE_URL is empty)");
  }
  return p.connect();
}

/**
 * Probe the connection at startup. NEVER throws — logs a warning on failure and
 * resolves, so the server keeps booting even when Postgres is down.
 */
export async function testConnection(): Promise<boolean> {
  if (!env.databaseUrl) {
    logger.warn(
      { event: "pg_not_configured" },
      "PostgreSQL DATABASE_URL not set — running in MongoDB-only mode",
    );
    return false;
  }
  try {
    const res = await query<{ now: Date }>("SELECT now() AS now");
    logger.info(
      { event: "pg_connected", now: res.rows[0]?.now },
      "PostgreSQL connection pool ready",
    );
    return true;
  } catch (err) {
    logger.warn(
      { event: "pg_unavailable", error: err instanceof Error ? err.message : String(err) },
      "PostgreSQL unavailable at startup — continuing without it",
    );
    return false;
  }
}
