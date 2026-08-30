import { extname, join, normalize, sep } from "node:path";

/** The small seam through which the bridge can optionally host a browser bundle. */
export interface PwaAssets {
  buildId(): Promise<string>;
  serve(pathname: string): Promise<Response>;
}

const DEFAULT_WEB_DIR = join(import.meta.dir, "..", "web", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Scripts are external hashed bundles. Terminal output is rendered as text, never markup.
const CSP =
  "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; worker-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Adapter for the traditional all-in-one deployment where the bridge serves web/dist. */
export class BundledPwaAssets implements PwaAssets {
  private buildCache: { id: string; mtime: number } | null = null;

  constructor(private readonly webDir = DEFAULT_WEB_DIR) {}

  async buildId(): Promise<string> {
    try {
      const file = Bun.file(join(this.webDir, "build-info.json"));
      const mtime = file.lastModified;
      if (!this.buildCache || this.buildCache.mtime !== mtime) {
        const data = (await file.json()) as { id?: string };
        this.buildCache = { id: data.id ?? "unknown", mtime };
      }
      return this.buildCache.id;
    } catch {
      return "unknown";
    }
  }

  async serve(pathname: string): Promise<Response> {
    const resolved = resolvePwaPath(pathname, this.webDir);
    if (!resolved) return new Response("forbidden", { status: 403 });
    let { rel, full } = resolved;

    let file = Bun.file(full);
    if (!(await file.exists())) {
      if (rel === "index.html") return frontendMissing();
      if (extname(rel) === "") {
        rel = "index.html";
        full = join(this.webDir, "index.html");
        file = Bun.file(full);
        if (!(await file.exists())) return frontendMissing();
      } else {
        return new Response("not found", { status: 404 });
      }
    }

    const ext = extname(full);
    const headers: Record<string, string> = {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "x-herdr-control-build": await this.buildId(),
    };
    if (ext === ".html") {
      headers["content-security-policy"] = CSP;
      headers["cache-control"] = "no-cache";
    } else if (rel.startsWith("assets/")) {
      headers["cache-control"] = "public, max-age=31536000, immutable";
    }
    if (rel === "sw.js") headers["service-worker-allowed"] = "/";
    return new Response(file, { headers });
  }
}

/** Resolve a request path beneath a PWA directory without permitting traversal or prefix siblings. */
export function resolvePwaPath(
  pathname: string,
  webDir: string = DEFAULT_WEB_DIR,
): { rel: string; full: string } | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(webDir, rel));
  if (full !== webDir && !full.startsWith(webDir + sep)) return null;
  return { rel, full };
}

function frontendMissing(): Response {
  return new Response("frontend not built — run `bun run build:pwa`", { status: 503 });
}
