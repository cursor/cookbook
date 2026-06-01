import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  serverExternalPackages: ["@cursor/sdk"],
  turbopack: {
    root: process.cwd(),
  },
}

export default nextConfig
