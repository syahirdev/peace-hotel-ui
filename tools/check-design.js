#!/usr/bin/env node
/*
 * Design system check: every colour, corner, font and font size must come from the tokens at the top of
 * nitro.css (between @tokens-start and @tokens-end). Run: node tools/check-design.js
 * Fails (exit 1) with file:line for each raw value found anywhere else in nitro.css or ui.css.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const FILES = ['nitro.css', 'ui.css'];

const RULES = [
  { re: /#[0-9a-fA-F]{3,8}\b/, msg: 'raw hex colour (use a --pu-* colour token)' },
  { re: /\b(rgba?|hsla?)\(\s*(?!var\()/, msg: 'raw rgb/hsl colour (use a --pu-* colour token)' },
  { re: /\b(white|red|blue|green|gr[ae]y|silver|yellow|orange|purple|pink)\b/, msg: 'named colour (use a --pu-* colour token)', names: true },
  { re: /\bblack\b/, msg: 'named colour (use --pu-edge-c; black is only allowed in masks)', skip: /mask/, names: true },
  { re: /border(-(top|bottom)-(left|right))?-radius\s*:\s*(?![^;]*var\()[^;]*\d+(\.\d+)?px/, msg: 'raw corner (use --pu-r / --pu-r-in / --pu-r-pill)' },
  { re: /(^|[;{\s])font\s*:(?!\s*inherit)(?![^;]*var\(--pu-font)[^;]*;/, msg: 'font without a --pu-font family token' },
  { re: /font-family\s*:(?![^;]*var\(--pu-font)(?!\s*inherit)/, msg: 'font-family without a --pu-font token' },
  { re: /font-size\s*:(?!\s*(var\(|calc\(var\(|0\b|inherit|1em))/, msg: 'raw font size (use --pu-fs-*)' },
];

let errors = 0;
for (const f of FILES) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  // Blank out comments but keep line numbers.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    const keep = /@tokens-(start|end)/.exec(m);
    return keep ? keep[0] + m.replace(/[^\n]/g, '').slice(0) : m.replace(/[^\n]/g, '');
  });
  let inTokens = false;
  code.split('\n').forEach((line, i) => {
    if (line.includes('@tokens-start')) { inTokens = true; return; }
    if (line.includes('@tokens-end')) { inTokens = false; return; }
    if (inTokens) return;
    const bare = line.replace(/url\("data:[^"]*"\)/g, 'url()').replace(/content:\s*'[^']*'/g, 'content:""');
    for (const r of RULES) {
      if (r.skip && r.skip.test(bare)) continue;
      const t = r.names ? bare.replace(/[\w-]+(?=\s*:)/g, '').replace(/--[\w-]+/g, '').replace(/[.#][\w-]+/g, '').replace(/\[[^\]]*\]/g, '') : bare;
      if (r.re.test(t)) { errors++; console.log(`${f}:${i + 1}: ${r.msg}\n    ${line.trim().slice(0, 160)}`); }
    }
  });
}
if (errors) { console.log(`\n${errors} problem(s). Move the value into the tokens in nitro.css, or use an existing token.`); process.exit(1); }
console.log('Design check passed: no raw colours, corners or fonts outside the tokens.');
