/**
 * Shared pagination defaults for every public listing surface (tours, packages,
 * sightseeing, accommodation, events, service modules).
 *
 * These used to be inlined as `Math.min(50, Math.max(1, Number(q.limit) || 20))`
 * in each controller, which let the server default drift out of sync with what
 * the clients actually requested — listings past the cap were silently dropped
 * because no client paged past the first response.
 */

/** Rows per page when the caller does not specify one. */
export const DEFAULT_PAGE_LIMIT = 25;

/** Hard ceiling on rows per request, so a caller cannot ask for the whole table. */
export const MAX_PAGE_LIMIT = 100;

export type PageParams = { page: number; limit: number; skip: number };

/**
 * Normalizes `page`/`limit` query params into safe values.
 * Accepts strings (Express query) or numbers; anything invalid falls back to
 * page 1 at DEFAULT_PAGE_LIMIT.
 */
export function paginate(q: Record<string, unknown>): PageParams {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(
    MAX_PAGE_LIMIT,
    Math.max(1, Number(q.limit) || DEFAULT_PAGE_LIMIT),
  );
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Builds the pagination envelope returned alongside `items`.
 * `totalPages` floors at 1 so an empty result set still reports a valid page 1
 * (a raw `Math.ceil(0 / limit)` yields 0, which breaks client page clamping).
 */
export function pageMeta(
  { page, limit }: { page: number; limit: number },
  total: number,
): { page: number; limit: number; total: number; totalPages: number } {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
