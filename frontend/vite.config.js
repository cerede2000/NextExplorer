import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import VueDevTools from 'vite-plugin-vue-devtools';

const backendOrigin = process.env.VITE_BACKEND_ORIGIN || 'http://localhost:3001';
const port = Number(process.env.PORT || 3000);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), VueDevTools(), tailwindcss()],
  define: {
    // Legacy: Version info is now served from backend /api/features endpoint
    // These build-time constants are kept for backwards compatibility but no longer used
    __APP_VERSION__: JSON.stringify(
      process.env.VITE_APP_VERSION || process.env.npm_package_version || '1.0.5'
    ),
    __GIT_COMMIT__: JSON.stringify(process.env.VITE_GIT_COMMIT || ''),
    __GIT_BRANCH__: JSON.stringify(process.env.VITE_GIT_BRANCH || ''),
    __REPO_URL__: JSON.stringify(process.env.VITE_REPO_URL || ''),
  },
  // Which browsers the build is written for, and it is not the toolchain's
  // business to decide: Vite 7 would have raised its own default to Safari 16
  // and Chrome 107, dropping every phone that stops at iOS 15 as a side effect
  // of a version bump, with nothing anywhere saying so.
  //
  // These four versions are where the application actually stands, read off
  // what the bundle calls rather than guessed: `Object.hasOwn` (the folder
  // listing merges with it, and so does Uppy, which does the uploading) and
  // `Array.prototype.at` (four places here). Both landed together, in early
  // 2022. Nothing in the bundle needs anything newer — `requestIdleCallback`
  // and `crypto.randomUUID` are each asked for behind a check.
  //
  // What this leaves in: an iPhone 6s, a 7 or an SE of the first generation,
  // which stop at iOS 15.8 and are exactly what Vite's own default would have
  // turned away. Moving it is a decision about who is still being served, and
  // the two names above are where to start looking.
  build: {
    target: ['chrome93', 'edge93', 'firefox92', 'safari15.4'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port,
    strictPort: true,
    allowedHosts: ['files.vsoni.com'],
    proxy: {
      '/api': {
        target: backendOrigin,
        changeOrigin: true,
        ws: true,
        secure: false,
      },
      '/static/thumbnails': {
        target: backendOrigin,
        changeOrigin: true,
        secure: false,
      },
      '/static/logos': {
        target: backendOrigin,
        changeOrigin: true,
        secure: false,
      },
      // Proxy EOC routes to backend so /login, /callback, /logout work on the public origin
      '/login': { target: backendOrigin, changeOrigin: true, secure: false },
      '/callback': { target: backendOrigin, changeOrigin: true, secure: false },
      '/logout': { target: backendOrigin, changeOrigin: true, secure: false },
    },
  },
});
