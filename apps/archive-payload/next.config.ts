import { withPayload } from '@payloadcms/next/withPayload'

const nextConfig = {
  output: 'standalone' as const,
  images: {
    // Archive media is served through the authenticated API and is not
    // transformed by Next's image optimizer.
    unoptimized: true,
    localPatterns: [{ pathname: '/api/media/file/**' }],
  },
  serverExternalPackages: ['jose', 'pg', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
