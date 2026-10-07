/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // instrumentation.ts starts the in-process engine ticker in mock mode
  experimental: { instrumentationHook: true },
  transpilePackages: ['three'],
  // next/image is not used. Turning the optimizer off makes /_next/image a 404, so it can never be used
  // to make this server fetch arbitrary URLs (a wildcard remotePatterns made it an open proxy).
  images: { unoptimized: true },
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, os: false };
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
};
module.exports = nextConfig;
