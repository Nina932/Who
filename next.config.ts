import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This machine also has a user-level package-lock.json. Without an explicit
  // boundary Next treats C:\Users\Nino as the workspace root and resolves
  // optional Three.js peers outside this project.
  outputFileTracingRoot: process.cwd(),
  webpack(config) {
    // hls.js 1.6 advertises an ESM entry that is absent from its published
    // Windows package. Drei imports it as an optional video peer even though
    // this cockpit does not use video, so resolve the shipped CJS build.
    config.resolve.alias["hls.js"] = path.resolve(
      process.cwd(),
      "node_modules/hls.js/dist/hls.js",
    );
    return config;
  },
};

export default nextConfig;
