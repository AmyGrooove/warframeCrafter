import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  env: {
    IS_DEVELOPMENT: process.env.IS_DEVELOPMENT,
  },
  pageExtensions: ['mdx', 'ts', 'tsx'],
  images: {
    minimumCacheTTL: 86400,
  },
  turbopack: {
    root: __dirname,
  },
}

export default nextConfig
