/**
 * One origin for everything: Next.js pages, plus /api/* and /ws/* proxied to
 * the Python ingest service.
 *
 * Why not Next.js rewrites? Rewrites do not carry WebSocket upgrades reliably,
 * and the dashboard needs one. A single origin also means:
 *   - one ngrok tunnel covers the camera page, the API and the dashboard socket
 *   - no mixed-content blocking when the page is served over HTTPS
 *
 *   node server.mjs            http  on 0.0.0.0:3000  (laptop, or behind ngrok)
 *   node server.mjs --https    https on 0.0.0.0:3000  (phones on the same Wi-Fi)
 *   node server.mjs --prod     serve the production build
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import httpProxy from "http-proxy";
import next from "next";

import { lanIPv4s, loadRootEnv } from "./scripts/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
loadRootEnv();

const argv = new Set(process.argv.slice(2));
const useHttps = argv.has("--https");
const prod = argv.has("--prod");
const port = Number(process.env.WEB_PORT || 3000);
const hostname = "0.0.0.0";
const ingest = process.env.INGEST_URL || "http://127.0.0.1:8000";

if (prod) process.env.NODE_ENV = "production";

const app = next({ dev: !prod, dir: here, hostname, port });
const handle = app.getRequestHandler();

const proxy = httpProxy.createProxyServer({ target: ingest, ws: true, changeOrigin: true, xfwd: true });
proxy.on("error", (err, _req, res) => {
  console.error(`[proxy] ingest unreachable at ${ingest}: ${err.message}`);
  // `res` is a ServerResponse for HTTP and a Socket for WebSocket upgrades.
  if (res && "writeHead" in res && !res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "The ingest service is not running. Start it with `pnpm dev` at the repo root." }));
  } else if (res && "destroy" in res) {
    res.destroy();
  }
});

const isIngestPath = (url = "") => url.startsWith("/api/") || url.startsWith("/ws/");

function tlsOptions() {
  const dir = path.join(here, "certs");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.error("[web] No dev certificate. Run `pnpm bootstrap` (or `pnpm --filter @divya/web cert`) first.");
    process.exit(1);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

await app.prepare();
const nextUpgrade = app.getUpgradeHandler();

const onRequest = (req, res) => (isIngestPath(req.url) ? proxy.web(req, res) : handle(req, res));
const server = useHttps ? https.createServer(tlsOptions(), onRequest) : http.createServer(onRequest);

server.on("upgrade", (req, socket, head) => {
  if (isIngestPath(req.url)) proxy.ws(req, socket, head);
  else nextUpgrade(req, socket, head); // Next.js hot reload
});

server.listen(port, hostname, () => {
  const scheme = useHttps ? "https" : "http";
  const lines = [
    "",
    `  Divya Drishti web (${prod ? "production" : "development"}, ${scheme})`,
    `  Dashboard:  ${scheme}://localhost:${port}`,
    ...lanIPv4s().map((ip) => `  On Wi-Fi:   ${scheme}://${ip}:${port}`),
    `  Ingest:     ${ingest}  (proxied at /api and /ws)`,
  ];
  if (!useHttps) {
    lines.push("", "  Phones need HTTPS for the camera. Either run `pnpm dev:lan`,", "  or `ngrok http " + port + "` and open the dashboard as usual.");
  }
  console.log(lines.join("\n") + "\n");
});
