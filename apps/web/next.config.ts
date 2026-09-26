import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/v1\/open-banking\/enable-banking\/callback(?:\?|$)/u],
    },
  },
};

export default nextConfig;
