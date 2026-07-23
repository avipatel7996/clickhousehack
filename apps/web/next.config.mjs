/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@core", "@clickhouse", "@ingestion", "@analysis"],
  experimental: { webpackMemoryOptimizations: true },
};
export default nextConfig;
