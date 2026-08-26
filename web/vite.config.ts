import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const bridgeTarget = process.env.HERDR_CONTROL_DEV_TARGET ?? "http://127.0.0.1:8787";
const devOrigin = "http://127.0.0.1:5173";
const packageVersion = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as {
    version: string;
  }
).version;

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "local";
  }
}

const buildInfo = {
  version: packageVersion,
  sha: gitSha(),
  time: new Date().toISOString(),
};

const buildInfoPlugin: Plugin = {
  name: "herdr-control-build-info",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "build-info.json",
      source: JSON.stringify({ ...buildInfo, id: `${buildInfo.version}+${buildInfo.sha}` }, null, 2),
    });
  },
};

export default defineConfig({
  define: { __BUILD_INFO__: JSON.stringify(buildInfo) },
  plugins: [
    react(),
    buildInfoPlugin,
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      registerType: "autoUpdate",
      manifest: {
        name: "Herdr Web",
        short_name: "Herdr",
        description: "Monitor and drive durable Herdr agent sessions",
        display: "standalone",
        start_url: "/",
        scope: "/",
        background_color: "#111111",
        theme_color: "#111111",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png,ico,webmanifest,woff,woff2}"],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: bridgeTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            // Preserve the bridge's exact-origin CSRF boundary in development. Only requests that
            // originated from this Vite server are rewritten to the proxy target's origin; an
            // unrelated localhost page keeps its own Origin and is rejected by the bridge.
            if (request.headers.origin === devOrigin) {
              proxyRequest.setHeader("origin", new URL(bridgeTarget).origin);
            }
          });
        },
      },
    },
  },
});
