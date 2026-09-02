import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android wrapper for the mobile test build.
 *
 * Capacitor rather than Tauri: Tauri v2 mobile needs a Rust toolchain and the Android NDK,
 * and this machine has neither. Capacitor wraps the same Vite output in a WebView, which is
 * also the more honest test surface - it is a real Android WebView running the real build,
 * not a second renderer.
 */
const config: CapacitorConfig = {
  appId: 'com.jaswanthtech.shatterpoint',
  appName: 'SHATTERPOINT',
  webDir: 'dist',

  android: {
    // The WebView must not decide the page is "too wide" and reflow it; the game sizes its
    // own canvas from the drawing buffer.
    allowMixedContent: false,
    /**
     * NOT set here on purpose. Capacitor enables WebView debugging automatically when the
     * application is debuggable, so leaving this unset gives debug builds CDP - which is
     * exactly how the device gates attach Playwright to the live WebView - while a release
     * build gets nothing. Hard-coding `true` shipped a remotely-inspectable WebView.
     */
    // Hardware acceleration is the whole point - without it there is no WebGL2 context.
    backgroundColor: '#04040c',
  },

  server: {
    // https://localhost rather than file:// - a file:// origin has no secure context, and
    // without one the browser withholds WebGPU entirely and degrades several WebGL2 paths.
    androidScheme: 'https',
  },
};

export default config;
