import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the Docker image
  // can ship the server without the full node_modules tree. Harmless outside
  // Docker — `next dev` and `next start` are unaffected.
  output: "standalone",
};

export default nextConfig;
