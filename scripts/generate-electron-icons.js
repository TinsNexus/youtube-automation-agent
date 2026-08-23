// One-off tool: renders the app icon and tray icon from an SVG so the
// desktop build has real assets instead of falling back to Electron's default.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, '..', 'electron', 'assets');
fs.mkdirSync(OUT_DIR, { recursive: true });

function appIconSVG(size) {
  const r = size * 0.22;
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#667eea"/>
        <stop offset="100%" stop-color="#764ba2"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
    <polygon points="${size * 0.4},${size * 0.32} ${size * 0.4},${size * 0.68} ${size * 0.68},${size * 0.5}" fill="white"/>
  </svg>`;
}

function trayIconSVG(size) {
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#764ba2"/>
    <polygon points="${size * 0.38},${size * 0.3} ${size * 0.38},${size * 0.7} ${size * 0.68},${size * 0.5}" fill="white"/>
  </svg>`;
}

async function main() {
  // Master app icon (used to derive .icns on macOS)
  await sharp(Buffer.from(appIconSVG(1024))).png().toFile(path.join(OUT_DIR, 'icon.png'));

  // Tray icon + retina variant (macOS menu bar)
  await sharp(Buffer.from(trayIconSVG(22))).png().toFile(path.join(OUT_DIR, 'tray.png'));
  await sharp(Buffer.from(trayIconSVG(44))).png().toFile(path.join(OUT_DIR, 'tray@2x.png'));

  // macOS .icns via the built-in iconutil (only on macOS; other platforms skip)
  if (process.platform === 'darwin') {
    const iconset = path.join(OUT_DIR, 'icon.iconset');
    fs.mkdirSync(iconset, { recursive: true });
    const sizes = [16, 32, 64, 128, 256, 512, 1024];
    for (const size of sizes) {
      await sharp(Buffer.from(appIconSVG(size))).png().toFile(path.join(iconset, `icon_${size}x${size}.png`));
      if (size <= 512) {
        await sharp(Buffer.from(appIconSVG(size * 2))).png().toFile(path.join(iconset, `icon_${size}x${size}@2x.png`));
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT_DIR, 'icon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
  }

  console.log('Icons generated in', OUT_DIR);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
