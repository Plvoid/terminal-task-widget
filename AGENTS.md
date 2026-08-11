# Working on this repo

Notes for anyone — human or coding agent — picking this up without prior context.
Read this before your first edit; it will save you a wrong turn or two.

## Orientation

Windows desktop task widget: a 60×60 floating ball that expands into a 400×600
terminal-style panel. Tauri 2 (Rust) + React 19 + TypeScript + Vite + Tailwind 4.

**`package.json` lives in `terminal-task-widget/`, not the repo root.** Every npm command
below must run from that folder.

```bash
cd terminal-task-widget
npm install
npm run tauri:dev      # full app — USE THIS, not a bare `tauri dev`
npm run dev            # frontend only, in a browser
npx tsc --noEmit       # the gate — run before every commit
```

**`npm run tauri:dev`, not `npm run tauri dev`.** A dev build and an installed build are
the same app to Windows: same bundle identifier, so the same WebView2 profile and the same
localStorage. The `tauri:dev` script applies `src-tauri/tauri.dev.conf.json`, which
overrides the identifier so the two cannot see each other's data. `DATA_DIR` in `App.tsx`
separately routes dev's disk mirror to `Documents/TerminalTasks-dev`. Without both, an
afternoon of test tasks overwrites a real user's task list *and* the backup it would be
restored from. This has happened once.

Building the installer needs Rust stable and the Tauri 2 prerequisites; running the app
needs **WebView2 ≥ 111**, because theme transparency depends on CSS `color-mix()`.

## The one structural fact

`src/App.tsx` is a single ~3,300-line file holding virtually all application logic. That is
deliberate, and it has one consequence worth stating plainly: **concurrent edits to it
collide.** Work sequentially, type-check between steps, and commit in small pieces. If you
are coordinating parallel work, parallelise across *tasks*, not across this file.

## Things that will bite you

These each exist because of a real bug. Breaking one is a regression even if the build passes.

- **The command `<input>` must keep keyboard focus at all times.** Do not add a focusable
  element to the task list. Clickable is fine — the established pattern is a `<div>` with
  `onMouseDown={e => e.preventDefault()}`, which never blurs the input.
- **`handleKeyDown` must unconditionally `preventDefault()` on `Tab`.** An unhandled Tab
  walks focus out of the webview, fires window blur, and collapses the panel mid-keystroke.
- **Never use `window.screen` for window placement.** Inside WebView2 it reports the primary
  monitor's work area, in CSS pixels tied to the primary's DPI, with no virtual-desktop
  origin. Go through `getWorkArea()` / `dockPoint()` / `clampBall()`.
- **A theme change must never reach `dispatch`.** Themes are presentation only; routing one
  through the reducer would spend an undo step on it.
- **The panel auto-collapses on window blur.** If you open devtools the panel closes — that
  is the app working correctly, not a bug you have found.

## Versioning

Four files carry the version number and must move together: `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the app's own entry in
`src-tauri/Cargo.lock`. `tauri.conf.json` is the one that keys the installer upgrade path.

## Before you commit

- `npx tsc --noEmit` clean.
- No absolute paths, local account names, or personal identifiers in tracked files — this
  repo is public and its history has already been rewritten once to remove them.
- User-facing changes get a `CHANGELOG.md` entry; UX changes get a `USER_GUIDE.md` update.
  `USER_GUIDE.pdf` is generated from the Markdown, never edited directly.

## Where the rest of the reasoning lives

The detailed architecture notes — window state machine, nesting model, persistence layers,
and the record of decisions already made and rejected — live in the maintainer's working
documents, which are deliberately not published. This file carries the parts you need to
work on the code safely.

If you are about to change the window state machine, the keyboard handling, or anything
touching stored data, **ask first**: those areas have constraints that are not obvious from
reading, and most of them were written in response to a bug that had already shipped.
