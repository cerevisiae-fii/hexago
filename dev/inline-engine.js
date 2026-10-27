#!/usr/bin/env node
/**
 * Inline dev/ai-engine.js into index.html between the <script id="ai-engine-src"> tags.
 * Single source of truth for the shipped page: the engine text inside index.html.
 *
 * Usage:
 *   node dev/inline-engine.js          # build: copy engine source into index.html
 *   node dev/inline-engine.js --check  # verify index.html is up to date (exit 1 if stale)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const htmlPath = path.join(repo, 'index.html');
const enginePath = path.join(repo, 'dev', 'ai-engine.js');

const START = '<script id="ai-engine-src" type="text/plain">';
const END = '</script>';

const html = fs.readFileSync(htmlPath, 'utf8');
const engine = fs.readFileSync(enginePath, 'utf8');

if (engine.includes('</script>')) {
  console.error('ERROR: engine source contains "</script>" and cannot be inlined verbatim.');
  process.exit(2);
}
if (!engine.includes('HexagoAI')) {
  console.error('ERROR: engine source does not expose HexagoAI.');
  process.exit(2);
}

const start = html.indexOf(START);
if (start < 0) { console.error('ERROR: start marker not found in index.html'); process.exit(2); }
const bodyStart = start + START.length;
const end = html.indexOf(END, bodyStart);
if (end < 0) { console.error('ERROR: closing </script> not found'); process.exit(2); }

const current = html.slice(bodyStart, end);
const next = '\n' + engine.trim() + '\n';
const nextHtml = html.slice(0, bodyStart) + next + html.slice(end);

if (process.argv.includes('--check')) {
  if (current.trim() !== engine.trim()) {
    console.error('STALE: index.html engine block does not match dev/ai-engine.js');
    process.exit(1);
  }
  console.log(`OK: inlined engine matches dev/ai-engine.js (${engine.length} bytes)`);
  process.exit(0);
}

if (current.trim() === engine.trim()) {
  console.log('No change: index.html already contains the current engine.');
  process.exit(0);
}

fs.writeFileSync(htmlPath, nextHtml);
console.log(`Inlined engine: ${engine.length} bytes -> index.html (${html.length} -> ${nextHtml.length} bytes)`);
