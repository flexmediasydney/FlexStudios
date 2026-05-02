import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import compression from 'vite-plugin-compression'

export default defineConfig({
  plugins: [
    react(),
    compression({
      algorithm: 'gzip',
      threshold: 1024,
      ext: '.gz',
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@lib': path.resolve(__dirname, './src/lib'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@utils': path.resolve(__dirname, './src/utils'),
      // Shared pricing library — lives under supabase/functions/_shared/pricing
      // so Deno edge functions and Vite frontend import the SAME TypeScript
      // module. No duplication of math. See _shared/pricing/engine.ts for the
      // single computePrice() orchestrator.
      '@pricing': path.resolve(__dirname, '../supabase/functions/_shared/pricing'),
    },
    dedupe: ['react', 'react-dom'], // Prevents duplicate React in worktrees
  },
  esbuild: {
    // Keep console.error/warn for ErrorBoundary diagnostics in prod while we
    // hunt the residual TDZ. console.log/info/debug still drop via `pure`.
    pure: ['console.log', 'console.info', 'console.debug', 'console.trace'],
    drop: ['debugger'],
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-date': ['date-fns'],
          'vendor-recharts': ['recharts'],
          'vendor-icons': ['lucide-react'],
          // Isolate leaflet + react-leaflet into a dedicated chunk so Rollup
          // does not auto-split react-leaflet's forwardRef-based components
          // (Pane/Polygon/Polyline/etc.) into anonymous chunks that can race
          // with vendor-icons during top-level evaluation. Without this
          // grouping, Rollup produced a chunk containing
          // `const te = s.forwardRef(J)` at module scope, where `s` (react)
          // and `S` (react-dom) were imported from vendor-icons. A circular
          // import via the auto-split sibling chunks (Marker/Popup/TileLayer/
          // ZoomControl/Rectangle/Tooltip/grid-layer/hooks/media-overlay)
          // could trigger TDZ — "Cannot access 'te' before initialization" —
          // synchronously on load. Forcing the entire react-leaflet surface
          // into a single chunk removes the auto-split graph and the cycle.
          'vendor-leaflet': [
            'react-leaflet',
            'leaflet',
            'react-leaflet-cluster',
            'leaflet.markercluster',
          ],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-select',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-toast',
          ],
        },
      },
    },
  },
})
