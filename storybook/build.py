#!/usr/bin/env python3
"""Build storybook/index.html from storybook/storybook.src.html and the real nitro.css + ui.css.
The page renders every token and component with the shipped CSS, so it can never drift from the game.
Run: python3 storybook/build.py"""
import json, os, re
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
nitro = open(os.path.join(root, 'nitro.css')).read()
ui = open(os.path.join(root, 'ui.css')).read()
version = json.load(open(os.path.join(root, 'manifest.json')))['version']
block = nitro[nitro.index('@tokens-start'):nitro.index('@tokens-end')]
tokens, group = [], ''
for line in block.split('\n'):
    s = line.strip()
    g = re.match(r'^/\*\s*(.+?)\s*\*/$', s)
    if g and line.startswith('  /*'):
        group = g.group(1).split('.')[0].split(':')[0]
        continue
    m = re.match(r'^(--pu-[\w-]+):\s*(.+?);\s*(?:/\*\s*(.*?)\s*\*/)?$', s)
    if m:
        tokens.append([group, m.group(1), m.group(2), m.group(3) or ''])
src = open(os.path.join(here, 'storybook.src.html')).read()
out = (src.replace('/*NITRO_CSS*/', nitro)
          .replace('"__UI_CSS__"', json.dumps(ui))
          .replace('"__TOKENS__"', json.dumps(tokens))
          .replace('__VERSION__', str(version)))
open(os.path.join(here, 'index.html'), 'w').write(out)
print('storybook/index.html: %d tokens, %d KB' % (len(tokens), len(out) // 1024))
