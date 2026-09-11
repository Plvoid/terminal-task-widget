# terminal-task-widget

The application itself. **Project overview, features, and data layout live in the
[repository README](../README.md)**; the constraints worth reading before you change
anything are in [AGENTS.md](../AGENTS.md).

`package.json` is in *this* folder, not the repo root — every npm command below has to be
run from here.

## Run

```bash
npm install

npm run tauri:dev      # the full app (Vite + Tauri) — use this, not `tauri dev`
npm run dev            # frontend only, in a browser
npx tsc --noEmit       # type-check — the gate to run before committing
```

`tauri:dev` applies `src-tauri/tauri.dev.conf.json`, which gives the dev build its own
bundle identifier and therefore its own WebView2 profile. Combined with `DATA_DIR` in
`App.tsx` routing dev's disk mirror to `Documents/TerminalTasks-dev`, that keeps test data
away from a real installed copy — they are otherwise the same app to Windows and share
both localStorage and `state.json`.

## Build

```bash
npm run tauri build    # installer lands in src-tauri/target/release/bundle/
```

Requires Windows 10/11, Node 18+, and Rust stable with the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

**WebView2 ≥ 111** is a hard runtime requirement: theme transparency rides entirely on
`color-mix()`, which Tailwind cannot pre-bake into a hex fallback once the colour is a
CSS variable.

## Layout

```
src/App.tsx              virtually all app logic — single file, ~3,440 lines
src/App.css              animations and the styles Tailwind does not own
src-tauri/src/lib.rs     tray, plugin registration, Rust entry point
src-tauri/tauri.conf.json  window model, bundle identifier, version
```

`src/App.tsx` being one file is deliberate, and it is why concurrent edits to it collide.
Change it sequentially, type-check between steps.

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) +
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
