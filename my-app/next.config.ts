import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the Docker image
  // can ship the server without the full node_modules tree. Harmless outside
  // Docker — `next dev` and `next start` are unaffected.
  output: "standalone",

  // Load Sequelize from node_modules at runtime instead of bundling it.
  //
  // It reaches for its optional dialect helpers with a plain `require` inside a
  // function — `pg-hstore` is only pulled in if a column is actually an HSTORE,
  // and this app has none, so Node never runs that line. A bundler does not get
  // to find that out: it follows every `require` it can see and fails the build
  // on a package that is not installed and never will be. Leaving Sequelize
  // external means those requires stay where Node can decide about them.
  serverExternalPackages: ["sequelize"],
};

export default nextConfig;
