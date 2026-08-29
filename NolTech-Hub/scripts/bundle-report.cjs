#!/usr/bin/env node
// ─── Bundle Composition Report ───────────────────────────────────────────
// Parses dist/stats.json from rollup-plugin-visualizer and prints the top
// modules in each chunk, sorted by rendered size. Run after a build done
// with BUNDLE_REPORT=1 npx vite build.

const fs = require('fs');
const path = require('path');

const statsPath = path.join('dist', 'stats.json');
if (!fs.existsSync(statsPath)) {
  console.error('No dist/stats.json — run `BUNDLE_REPORT=1 npx vite build` first.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));

function shorten(id) {
  return id
    .replace(/^.*[\\/]node_modules[\\/]/, 'nm/')
    .replace(/^.*[\\/]src[\\/]/, 'src/')
    .split(path.sep)
    .join('/');
}

function walk(node, out) {
  if (!node) return;
  if (node.children) {
    for (const c of node.children) walk(c, out);
  } else if (node.uid) {
    const part = data.nodeParts[node.uid];
    const meta = part && data.nodeMetas[part.metaUid];
    const id = (meta && meta.id) || node.name || 'unknown';
    out.push({ id, size: part ? part.renderedLength : 0 });
  }
}

const interesting = ['index-', 'vendor-charts', 'vendor-supabase', 'vendor-motion', 'vendor-react', 'vendor-icons'];

for (const chunkNode of data.tree.children) {
  if (!interesting.some((p) => chunkNode.name.includes(p))) continue;
  const mods = [];
  walk(chunkNode, mods);
  mods.sort((a, b) => b.size - a.size);
  const total = mods.reduce((s, m) => s + m.size, 0);
  console.log('\n=== ' + chunkNode.name + ' (' + (total / 1024).toFixed(1) + ' KB) ===');
  mods.slice(0, 30).forEach((m) => {
    console.log('  ' + (m.size / 1024).toFixed(1).padStart(7) + ' KB  ' + shorten(m.id));
  });
}
