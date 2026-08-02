import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: { entry: resolve(__dirname, 'client/index.ts'), formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['@koishijs/client', 'vue'] },
  },
})
