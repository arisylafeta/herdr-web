// Pure, injectable HTTP cache helpers: ETag + conditional GET + gzip JSON.
//
// Kept separate from server.ts so they can be exercised under `bun test` without
// needing Bun.serve or the Herdr socket — all functions are synchronous or return
// a plain Response, with no I/O.

// Only compress if serialised body is at least this many bytes; below this the
// deflate overhead and header cost outweigh the savings.
const GZIP_MIN_BYTES = 256;

/**
 * Compute a strong ETag for the given response body string.
 * Uses Bun.hash (Wyhash) — fast and deterministic within a process.
 * Returns a quoted ETag value as required by RFC 7232.
 */
export function computeEtag(body: string): string {
  // toString(16) works for both number and bigint, which covers all Bun.hash overloads.
  return `"${Bun.hash(body).toString(16)}"`;
}

/**
 * Return true when the request's If-None-Match header equals the computed ETag,
 * meaning the client already holds the current representation.
 * Returns false for a null header (no previous ETag known to the client).
 */
export function notModified(ifNoneMatch: string | null, etag: string): boolean {
  return ifNoneMatch !== null && ifNoneMatch === etag;
}

export function acceptsGzip(acceptEncoding: string | null): boolean {
  if (!acceptEncoding) return false;
  let wildcardQuality: number | null = null;
  for (const entry of acceptEncoding.split(",")) {
    const [rawCoding, ...params] = entry.trim().split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (!coding) continue;
    let quality = 1;
    const qualityParam = params.find((param) => param.trim().toLowerCase().startsWith("q="));
    if (qualityParam) {
      const rawQuality = qualityParam.slice(qualityParam.indexOf("=") + 1).trim();
      quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQuality)
        ? Number(rawQuality)
        : 0;
    }
    if (coding === "gzip") return quality > 0;
    if (coding === "*") wildcardQuality = quality;
  }
  return wildcardQuality !== null && wildcardQuality > 0;
}

/**
 * Build a JSON Response, gzip-compressing the body when the client signals gzip
 * support via Accept-Encoding and the serialised body is large enough to benefit.
 *
 * Behaviour:
 * - Always sets `content-type: application/json` and `cache-control: no-store`.
 * - When compressed: adds `content-encoding: gzip` and `vary: accept-encoding`.
 * - `extraHeaders` are merged in after the standard headers so callers can attach
 *   an ETag or other fields (e.g. `{ etag: '"abc"' }`).
 */
export function gzipJsonResponse(
  data: unknown,
  acceptEncoding: string | null,
  extraHeaders: Record<string, string> = {},
): Response {
  const body = JSON.stringify(data);
  const useGzip =
    acceptsGzip(acceptEncoding) &&
    body.length >= GZIP_MIN_BYTES;

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };

  if (useGzip) {
    const compressed = Bun.gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
    return new Response(compressed, { headers });
  }

  return new Response(body, { headers });
}
