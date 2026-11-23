# Peace Hotel phone UI

The files the Peace Hotel Android app loads for its phone-friendly game UI.

- `frame.js`, `ui.css`, `nitro.css` run inside the game frame.
- `top.css` runs on the website page around it.
- `manifest.json`: `version` must go up on every change, or phones keep their current copy. `minApp` is the lowest app UI version that can run these files.

The app checks this repo when the game starts and on "Reload game". Offline or on any error it uses the copy built into the app. If an update breaks the game, switch to the classic UI from the app's Back button menu.
