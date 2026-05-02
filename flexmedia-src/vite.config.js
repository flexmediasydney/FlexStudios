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
        // Function form (instead of static `{name: [packages]}`) so a chunk
        // captures EVERY sub-package of an ecosystem — not just the ones we
        // explicitly listed. Without this, Rollup auto-splits internal deps
        // (e.g. @radix-ui/react-context, @radix-ui/react-primitive, react-
        // leaflet's hooks/media-overlay/grid-layer) into anonymous chunks
        // that import from the manualChunk and re-import back, producing a
        // circular import via the chunk boundary. Under minification one of
        // those re-exports becomes a const named `te` that's read before
        // its initializer ran — TDZ — surfacing as
        // "Cannot access 'te' before initialization" on first render.
        // The previous array form caught react-leaflet itself but missed
        // its internal helpers; same shape was hitting @radix-ui's full
        // dep graph and breaking the swimlane on Project Details whenever
        // a Radix-driven component rendered.
        manualChunks(id) {
          if (id.includes('node_modules/')) {
            if (id.includes('node_modules/@radix-ui/'))            return 'vendor-radix';
            if (id.includes('node_modules/lucide-react/'))         return 'vendor-icons';
            if (id.includes('node_modules/recharts/') ||
                id.includes('node_modules/d3-'))                   return 'vendor-recharts';
            if (id.includes('node_modules/date-fns/'))             return 'vendor-date';
            if (id.includes('node_modules/@tanstack/react-query')) return 'vendor-query';
            if (id.includes('node_modules/@supabase/'))            return 'vendor-supabase';
            if (id.includes('node_modules/react-leaflet') ||
                id.includes('node_modules/leaflet') ||
                id.includes('node_modules/leaflet.markercluster')) return 'vendor-leaflet';
            if (id.includes('node_modules/react-router') ||
                id.includes('node_modules/react-dom') ||
                id.includes('node_modules/react/') ||
                id.includes('node_modules/scheduler/'))            return 'vendor-react';
          }
          // Everything else: let Rollup decide (default per-route splits).
        },
      },
    },
  },
})
