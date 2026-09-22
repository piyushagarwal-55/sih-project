import os from "node:os";
import path from "node:path";

import type { NextConfig } from "next";

// Phones load dev assets from a LAN IP or an ngrok host, which Next.js treats as
// cross-origin unless listed here.
const lanHosts = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
  .map((i) => i.address);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Monorepo root, so Next.js does not guess it from the nearest lockfile.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  transpilePackages: ["@divya/contracts"],
  devIndicators: false,
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    ...lanHosts,
    "*.ngrok-free.app",
    "*.ngrok-free.dev",
    "*.ngrok.app",
    "*.ngrok.io",
    "*.trycloudflare.com",
  ],
};

export default nextConfig;
