import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/* Vite 8 runs on Rolldown: object-form manualChunks is rejected, so chunking
   is expressed as a function. vite-plugin-top-level-await is incompatible and
   is deliberately absent -- vite-plugin-wasm alone covers the Rapier import. */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    tailwindcss(),
    wasm(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'SHATTERPOINT',
        short_name: 'Shatterpoint',
        description: 'First-person on-rails corridor runner.',
        theme_color: '#05070b',
        background_color: '#05070b',
        display: 'fullscreen',
        orientation: 'landscape',
        icons: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,ktx2,glb,opus,cube}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 59593,
    strictPort: true,
    // WebGPU needs a secure context; localhost counts, and 10.10.0.36 is treated as
    // potentially-trustworthy by Chromium when launched with the flag the e2e runner sets.
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  preview: { host: '0.0.0.0', port: 59593, strictPort: true },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@dimforge/rapier3d-compat')) return 'rapier';
          if (id.includes('node_modules')) return 'vendor';
          return null;
        },
      },
    },
  },
  worker: { format: 'es' },
});
