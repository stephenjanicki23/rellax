import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Keep server-only packages out of any client bundle.
  serverExternalPackages: ['@prisma/client', '@anthropic-ai/sdk'],
};

export default nextConfig;
