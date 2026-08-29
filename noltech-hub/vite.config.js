import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

// Toggle the bundle visualizer with `BUNDLE_REPORT=1 npm run build`.
// Writes dist/stats.html — open it to see exactly what's in each chunk.
const wantsReport = process.env.BUNDLE_REPORT === '1';

// Function-based manualChunks. The array form (e.g. `['react','react-dom']`)
// silently misses transitive imports like react/jsx-runtime, which is why the
// previous vendor-react chunk weighed in at 0.07 KB — React itself was getting
// bundled into the main index chunk. Matching by node_modules path is the
// reliable way to keep heavy third-party code in its own cacheable chunk.
function chunkFor(id) {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) return 'vendor-react';
  if (id.includes('node_modules/recharts/') || id.includes('node_modules/d3-')) return 'vendor-charts';
  if (id.includes('node_modules/lucide-react/')) return 'vendor-icons';
  if (id.includes('node_modules/@supabase/')) return 'vendor-supabase';
  if (id.includes('node_modules/framer-motion/') || id.includes('node_modules/motion-')) return 'vendor-motion';
  return undefined; // everything else falls into the default chunking
}

export default defineConfig({
  plugins: [
    react(),
    wantsReport && visualizer({
      filename: 'dist/stats.html',
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
    }),
    wantsReport && visualizer({
      filename: 'dist/stats.json',
      template: 'raw-data',
      gzipSize: true,
    }),
  ].filter(Boolean),
  // Relative asset paths required for Electron's file:// protocol
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks: chunkFor,
      },
    },
  },
});
