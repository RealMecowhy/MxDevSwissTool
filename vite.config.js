import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  root: "public",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // This ensures all chunks are merged into one before the singlefile plugin runs
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
