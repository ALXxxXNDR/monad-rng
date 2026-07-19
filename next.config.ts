import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This repository can sit below another package-lock.json on local machines.
  // Keep Next/Turbopack scoped to this app instead of inferring a parent root.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
