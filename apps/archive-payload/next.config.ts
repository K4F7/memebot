import { withPayload } from '@payloadcms/next/withPayload'

const nextConfig = {
  images: {
    // Cloudflare Workers does not provide the native Sharp runtime used by
    // Next's image optimizer. Payload media is served from R2 directly.
    unoptimized: true,
    localPatterns: [{ pathname: '/api/media/file/**' }],
  },
  serverExternalPackages: ['jose', 'pg-cloudflare'],
  turbopack: {
    resolveAlias: {
      sharp: './src/sharp-stub.cjs',
      '@img/sharp-linux-x64': './src/sharp-stub.cjs',
      '@img/sharp-wasm32': './src/sharp-stub.cjs',
      '@img/sharp-libvips-linux-x64': './src/sharp-stub.cjs',
    },
  },
  webpack: (webpackConfig: any) => {
    webpackConfig.resolve.alias = {
      ...(webpackConfig.resolve.alias || {}),
      sharp: './src/sharp-stub.cjs',
      '@img/sharp-linux-x64': './src/sharp-stub.cjs',
      '@img/sharp-wasm32': './src/sharp-stub.cjs',
      '@img/sharp-libvips-linux-x64': './src/sharp-stub.cjs',
    }
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }
    return webpackConfig
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
