/* eslint-env node */
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
  // Which browsers the build is written for. Vite 7 raised its own default
  // from Safari 14 to Safari 16 and Chrome 87 to Chrome 107, which would have
  // dropped a phone still on iOS 15 the moment the toolchain was updated —
  // silently, since nothing in the build says so. Written down instead, so
  // that raising it is a decision about who is still being served rather than
  // a side effect of a version bump.
  build: {
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
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
