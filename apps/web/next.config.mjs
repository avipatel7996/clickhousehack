/** @type {import('next').NextConfig} */
const nextConfig = { transpilePackages: ["@core", "@clickhouse", "@ingestion", "@analysis"] };
export default nextConfig;
