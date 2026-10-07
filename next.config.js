/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // instrumentation.ts starts the in-process engine ticker in mock mode
  experimental: { instrumentationHook: true },
  transpilePackages: ['three'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, os: false };
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
};
module.exports = nextConfig;
