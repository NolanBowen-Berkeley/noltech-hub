// ─── NolTech Icon Generator ───────────────────────────────────────────────────
// Generates electron/icon.ico from an SVG design.
// Run: node scripts/generate-icon.js

const sharp = require('sharp');
const toIco = require('to-ico');
const fs    = require('fs');
const path  = require('path');

// ── Design ────────────────────────────────────────────────────────────────────
// Deep blue rounded-square background, white N lettermark, amber accent dot.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <!-- Background -->
  <rect width="256" height="256" rx="48" fill="#1A5276"/>

  <!-- Subtle inner gradient overlay -->
  <defs>
    <radialGradient id="g" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#2E86C1" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#1A5276" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="256" height="256" rx="48" fill="url(#g)"/>

  <!-- N lettermark (white) -->
  <!-- Left vertical bar -->
  <rect x="44" y="52" width="38" height="152" rx="6" fill="white"/>
  <!-- Diagonal stroke: top of left bar to bottom of right bar -->
  <polygon points="44,52 82,52 212,204 174,204" fill="white"/>
  <!-- Right vertical bar -->
  <rect x="174" y="52" width="38" height="152" rx="6" fill="white"/>

  <!-- Amber accent circle at base of diagonal -->
  <circle cx="210" cy="198" r="22" fill="#F39C12"/>
  <!-- Small white dollar-sign hint inside amber circle -->
  <text x="210" y="207" font-family="Arial" font-weight="900" font-size="26"
        fill="#1A5276" text-anchor="middle">$</text>
</svg>`;

// ── Render at multiple sizes → ICO ────────────────────────────────────────────
async function main() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const svgBuf = Buffer.from(SVG);

  const pngs = await Promise.all(
    sizes.map(size =>
      sharp(svgBuf)
        .resize(size, size)
        .png()
        .toBuffer()
    )
  );

  const ico = await toIco(pngs, { sizes });
  const outPath = path.join(__dirname, '..', 'electron', 'icon.ico');
  fs.writeFileSync(outPath, ico);
  console.log(`Icon written to ${outPath} (${(ico.length / 1024).toFixed(1)} KB, sizes: ${sizes.join(', ')})`);
}

main().catch(err => { console.error(err); process.exit(1); });
