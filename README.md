# Terminal Task Widget

A keyboard-first floating task HUD for Windows. Lives as a 60×60 ball docked at the edge of your
screen; press `Alt+X` (or click it) and it expands into a 400×600 terminal-style panel with a single
command input. Matrix/terminal aesthetic — dark, glowing mono text, JetBrains Mono.

**Stack:** Tauri 2 (Rust) + React 19 + TypeScript 5.8 + Vite 7 + Tailwind CSS 4
**Version:** 0.3.0 · Windows desktop

---

## New in 0.3.0

- **Colour themes.** `/theme default | mono | ice` — each preset brings its own accent palette
  and its own deadline ramp, not just a different hue. Type a unique prefix (`/theme i`), or type
  `/theme` and a space and click a swatch.
- **`/theme ramp off`** stops the glow sliding toward red before a deadline, independently of
  which preset you're on.
- **`/deadline off`** finally clears today's deadline without waiting for midnight.
- **The `/` menu completes arguments**, not just command names — `→` or `Tab` accepts, and the
  suggested values are clickable.
- **A day of subtask-only work is no longer lost.** The rollover archived top-level completions
  only, so finishing six subtasks under one unfinished parent recorded nothing at all.
- Plus a data-loss fix when typing `/clear` mid-edit, correct selection after undo, a colour flash
  on every panel open, and lower idle battery use. Full list in the [changelog](CHANGELOG.md).

Requires **WebView2 ≥ 111**.

---

## Features

- **Single command input** owns the keyboard — no mode-hunting, no modes to leave. Every list
  action also has a mouse path; `Ctrl+Z` is the one deliberate keyboard-only exception.
- **Three-level tasks**: tasks, subtasks, and their children, hard-capped at three. `> text` for
  rapid child entry, `Tab`/`Shift+Tab` to demote/promote — the subtree moves intact, never dropped.
- **Reorder**: `Alt+↑/↓`, `Alt+wheel` over the list, or `[ ^ ]`/`[ v ]` carets with a live ghost
  preview that glides to the insertion slot and commits 1.2 s after your last click.
- **Backlog** with an aging pressure ladder: `·Nd` tag → once-a-day "consider today?" surfacing at
  7 days → amber warning and header count at 14 days.
- **Daily rituals** (`/daily`) reseed themselves at every day rollover.
- **Deadline glow** (`/deadline HH:MM`): the whole UI shifts toward red over the two hours before
  your deadline, with a `T-1h24m` countdown in the header. `/theme ramp off` if you'd rather it
  didn't.
- **Themes** (`/theme`): three presets — `default` green, `mono` greyscale, `ice` blue. Each ships
  its own accent palette and its own ramp endpoints, so nothing collides with the identity colour.
  Type a unique prefix (`/theme i`), or type `/theme` and a space and click a swatch.
- **Streak & history** (`/log`): completion streak, rolling 7-day stats, 14-day archive.
- **Three-layer persistence**: localStorage → debounced disk mirror at
  `Documents/TerminalTasks/state.json` (full restore if the WebView cache is wiped) → `/export`
  JSON snapshots. Completed days are archived as `YYYY-MM-DD.md` markdown logs.
- **Ambient**: ball badge shows remaining tasks, ASCII progress bar, tray menu, `/startup` to launch
  at login, `/shortcut` to rebind the global hotkey.
- **Undo** with `Ctrl+Z` (20 steps).

Full command list: `/deadline /theme /l /clear /shortcut /daily /log /export /startup /help /about`.
Type `/` for the command menu — it completes as you type, and after a space it offers that
command's values. Press `/help` in the app for the built-in manual, or read the full
[user guide](USER_GUIDE.md) ([PDF](USER_GUIDE.pdf)). Recent changes are in the
[changelog](CHANGELOG.md).

## Requirements

- Windows 10/11
- **WebView2 ≥ 111** — theme transparency relies on CSS `color-mix()`, which has no hex fallback
  once the colour is a variable
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable) and the Tauri 2 prerequisites — see
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Development

```bash
cd terminal-task-widget
npm install

npm run tauri:dev      # run the full app (Vite + Tauri)
npm run dev            # frontend only, in a browser
npx tsc --noEmit       # type-check
```

Use `tauri:dev`, not a bare `tauri dev` — it gives the dev build its own bundle identifier and
data folder, so testing can't overwrite a real install's tasks. See [AGENTS.md](AGENTS.md).

## Build

```bash
cd terminal-task-widget
npm run tauri build    # installer lands in src-tauri/target/release/bundle/
```

## Where your data lives

Everything stays on your machine, under `Documents/TerminalTasks/`:

| File | What it is |
| --- | --- |
| `state.json` | Full state mirror, written 800 ms after any change |
| `YYYY-MM-DD.md` | Markdown archive of a completed day |
| `export-*.json` | Timestamped snapshots from `/export` |

No cloud, no account, no telemetry.

## Repository layout

```
<repo-root>/
├── README.md                  # this file
├── CHANGELOG.md               # user-facing changes per version
├── AGENTS.md                  # orientation for contributors & coding agents
├── USER_GUIDE.md / .pdf       # end-user manual (the .pdf is generated from the .md)
└── terminal-task-widget/
    ├── src/App.tsx            # ~3340 lines: virtually all app logic
    ├── src/App.css            # animations & the styles Tailwind does not own
    ├── src-tauri/src/lib.rs   # tray, plugins, Rust entry
    └── src-tauri/tauri.conf.json
```

## Design notes

Deliberate non-goals: cloud sync, projects/tags, notifications beyond the glow, mobile.
Drag-and-drop reorder was built and then removed — carets, `Alt+wheel`, and the nudge preview are
the chosen interaction model. [AGENTS.md](AGENTS.md) collects the constraints worth knowing before
changing the window state machine or the keyboard handling — each one exists because of a real bug.

## License

[MIT](LICENSE) © Zia
