# Terminal Task Widget

A keyboard-first floating task HUD for Windows. Lives as a 60×60 ball docked at the edge of your
screen; press `Alt+X` (or click it) and it expands into a 400×600 terminal-style panel with a single
command input. Matrix/terminal aesthetic — dark, glowing mono text, JetBrains Mono.

**Stack:** Tauri 2 (Rust) + React 19 + TypeScript 5.8 + Vite 7 + Tailwind CSS 4
**Version:** 0.2.0 · Windows desktop

---

## Features

- **Single command input** owns the keyboard — no mode-hunting, no mouse required.
- **Two-level tasks**: tasks with subtasks. `> text` for rapid subtask entry, `Tab`/`Shift+Tab` to
  demote/promote (subtasks are carried along, never dropped).
- **Reorder**: `Alt+↑/↓`, `Alt+wheel` over the list, or `[ ^ ]`/`[ v ]` carets with a live ghost
  preview that glides to the insertion slot and commits 1.2 s after your last click.
- **Backlog** with an aging pressure ladder: `·Nd` tag → once-a-day "consider today?" surfacing at
  7 days → amber warning and header count at 14 days.
- **Daily rituals** (`/daily`) reseed themselves at every day rollover.
- **Deadline glow** (`/deadline HH:MM`): the whole UI shifts green → red over the two hours before
  your deadline, with a `T-1h24m` countdown in the header.
- **Streak & history** (`/log`): completion streak, rolling 7-day stats, 14-day archive.
- **Three-layer persistence**: localStorage → debounced disk mirror at
  `Documents/TerminalTasks/state.json` (full restore if the WebView cache is wiped) → `/export`
  JSON snapshots. Completed days are archived as `YYYY-MM-DD.md` markdown logs.
- **Ambient**: ball badge shows remaining tasks, ASCII progress bar, tray menu, `/startup` to launch
  at login, `/shortcut` to rebind the global hotkey.
- **Undo** with `Ctrl+Z` (20 steps).

Full command list: `/deadline /l /clear /shortcut /daily /log /export /startup /help /about`.
Press `/help` in the app for the built-in manual, or read the full
[user guide](USER_GUIDE.md) ([PDF](USER_GUIDE.pdf)).

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable) and the Tauri 2 prerequisites — see
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Development

```bash
cd terminal-task-widget
npm install

npm run tauri dev      # run the full app (Vite + Tauri)
npm run dev            # frontend only, in a browser
npx tsc --noEmit       # type-check
```

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
├── PROJECT_SUMMARY.md         # architecture notes & design decisions
├── USER_GUIDE.md / .pdf       # end-user manual
└── terminal-task-widget/
    ├── src/App.tsx            # ~2850 lines: virtually all app logic
    ├── src/App.css            # animations & theme
    ├── src-tauri/src/lib.rs   # tray, plugins, Rust entry
    └── src-tauri/tauri.conf.json
```

## Design notes

Deliberate non-goals: cloud sync, projects/tags, notifications beyond the glow, mobile.
Drag-and-drop reorder was built and then removed — carets, `Alt+wheel`, and the nudge preview are
the chosen interaction model. See [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) for the invariants worth
knowing before changing the window state machine or the keyboard handling.

## License

[MIT](LICENSE) © Zia
