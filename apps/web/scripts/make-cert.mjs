// Generates a self-signed certificate for `pnpm dev:lan`, valid for localhost
// and every LAN IP on this machine. Phones will warn once; tap through it
// ("Advanced" -> "Proceed") and the camera page runs in a secure context.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import selfsigned from "selfsigned";

import { lanIPv4s } from "./env.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "certs");
fs.mkdirSync(dir, { recursive: true });

const ips = lanIPv4s();
const altNames = [
  { type: 2, value: "localhost" },
  { type: 7, ip: "127.0.0.1" },
  ...ips.map((ip) => ({ type: 7, ip })),
];

const pems = selfsigned.generate([{ name: "commonName", value: "Divya Drishti dev" }], {
  keySize: 2048,
  days: 365,
  algorithm: "sha256",
  extensions: [
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ],
});

fs.writeFileSync(path.join(dir, "key.pem"), pems.private);
fs.writeFileSync(path.join(dir, "cert.pem"), pems.cert);
console.log(`[cert] wrote apps/web/certs/{key,cert}.pem for localhost, 127.0.0.1${ips.length ? ", " + ips.join(", ") : ""}`);
