import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Ohne VITE_KERN_MOCK=1 spricht die App /api. Im Dev-Modus wird /api und /mcp an den lokalen Server (4301) weitergereicht.
export default defineConfig({
  plugins: [preact()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: {
    port: 4302,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.KERN_SERVER ?? 'http://127.0.0.1:4301', changeOrigin: false },
      '/mcp': { target: process.env.KERN_SERVER ?? 'http://127.0.0.1:4301', changeOrigin: false },
    },
  },
  preview: { port: 4302, strictPort: true },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
} as never);
