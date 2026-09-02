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
      /**
       * The service worker is a liability inside a WebView: Capacitor serves from
       * https://localhost, so the SW installs and then serves a cached build back on the
       * next launch - which means a freshly installed APK can show yesterday's bundle.
       * SP_MOBILE=1 turns it off for the Android wrapper only; the web build keeps it.
       */
      disable: process.env['SP_MOBILE'] === '1',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icons/*.png'],
      manifest: {
        name: 'SHATTERPOINT',
        short_name: 'Shatterpoint',
        description: 'First-person on-rails corridor runner.',
        // Both are the plate's own darkest stop (#04040c, the outer ring of plateGround).
        // A browser-generated splash that flashes a different colour than the boot veil is
        // the most visible seam an installed PWA has, and it is free to avoid.
        theme_color: '#04040c',
        background_color: '#04040c',
        display: 'fullscreen',
        orientation: 'landscape',
        // Installability requires BOTH a 192 and a 512. Chrome additionally wants at least
        // one maskable icon or it warns; shipping only maskable makes desktop render the
        // art inside a mask it does not need, so both purposes are declared explicitly.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
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
    // Sourcemaps are 9 MB of a 12 MB APK. The web build keeps them - they are how a bug
    // report from a browser is readable - but a phone test build does not need to carry
    // three megabytes of Rapier's map over USB on every install.
    sourcemap: process.env['SP_MOBILE'] !== '1',
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
