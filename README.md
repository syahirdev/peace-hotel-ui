# Peace Hotel phone UI

The files the Peace Hotel Android app loads for its phone-friendly game UI.

- `frame.js`, `ui.css`, `nitro.css` run inside the game frame.
- `top.css` runs on the website page around it.
- `manifest.json`: `version` must go up on every change, or phones keep their current copy. `minApp` is the lowest app UI version that can run these files.

The app checks this repo when the game starts and on "Reload game". Offline or on any error it uses the copy built into the app. If an update breaks the game, switch to the classic UI from the app's Back button menu.

## Design system

Every colour, corner, size, font and icon is a `--pu-*` token at the top of `nitro.css` (between `@tokens-start` and `@tokens-end`). `ui.css` uses the same tokens: custom properties inherit into the Peace UI shadow root.

- **Components** (window, close X, buttons default / primary / danger, chips, inputs, panels, tiles, badges) are each defined once in `nitro.css` as a list of every Nitro element with that look. The page sections below them set layout only.
- **Storybook**: `storybook/index.html` shows every token, component and a few full screens, rendered with the real `nitro.css` and `ui.css`. Rebuild it after any CSS change: `python3 storybook/build.py`.
- **Check**: `node tools/check-design.js` fails on a raw colour, corner radius, font or font size outside the token block. It runs on every pull request with the storybook check.

To change a look, change the token or the component. To give a new element a look, add it to that component's list instead of styling it in its page section.
