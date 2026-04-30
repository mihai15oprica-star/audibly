#!/usr/bin/env node

/**
 * Build script: Generate favicon.png from favicon.svg using sharp
 * Generates a 32x32 PNG favicon from the SVG source
 */

const sharp = require('sharp');
const path = require('path');

const srcSvg = path.join(__dirname, 'favicon.svg');
const outPng = path.join(__dirname, 'favicon.png');

sharp(srcSvg)
  .resize(32, 32, {
    fit: 'contain',
    background: { r: 255, g: 255, b: 255, alpha: 0 }
  })
  .png()
  .toFile(outPng)
  .then(info => {
    console.log(`✓ favicon.png generated (${info.size} bytes)`);
    process.exit(0);
  })
  .catch(err => {
    console.error('✗ Failed to generate favicon:', err.message);
    process.exit(1);
  });
