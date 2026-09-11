# Changelog

All notable user-facing changes to Terminal Task Widget.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **`Restart UI` and `Restart App` in the tray menu.** If the widget's interface stops responding
  — which is what "the ball vanished and nothing brings it back" actually looks like — `Restart UI`
  reloads it in place and `Restart App` relaunches the whole thing. Neither loses any tasks.

### Fixed

- **The ball could disappear after the machine had been asleep for days, with no way back except
  killing and relaunching the app.** Three things were wrong. The interface can be put to sleep by
  Windows and stop running entirely, so the watchdog that is supposed to bring the ball back was
  not running either; the app now asks Windows to leave it alone. Every tray command depended on
  that same sleeping interface, so all of them were dead too; they now do the work themselves.
  And the one call used to bring the window back does nothing when Windows already believes the
  window is visible, which is exactly the case here — the app now re-asserts its always-on-top
  position instead, and does so by itself the moment the machine wakes rather than waiting for you
  to reach for the tray.
- **Holding a key no longer runs away with your list.** With a backlog item selected, holding
  Backspace emptied the backlog one row per repeat, silently — and the very first press did it
  without any repeat at all, because a backlog row stayed selected while you typed. Typing now
  releases the selection, and held keys no longer drive deletion, completion or re-nesting.
- **Typing Chinese, Japanese or Korean no longer fights the panel.** While an input method was
  composing, `Esc` closed the panel instead of cancelling the composition, the arrow keys moved
  the row selection instead of picking a candidate, and `Enter` filed the un-converted text as a
  task. The composing keystrokes now belong to the input method, as they do everywhere else.
- **`Ctrl+Z` works with CapsLock on**, and on non-Latin keyboard layouts. It was matching the
  character produced rather than the key pressed, so either one silently disabled undo entirely.
- **Rebinding the hotkey can no longer leave you with no hotkey at all.** `/shortcut` used to
  accept combinations it could not actually register — it tore down the working binding first,
  failed, and saved the broken value, so every later launch failed the same way. It now refuses
  unusable combinations up front and keeps the old binding, requires a modifier so a bare letter
  cannot be taken from every other application, and repairs a binding that has stopped working by
  falling back to `Alt+X`.
- **A mistyped command is reported instead of becoming a task.** `/hlep` used to create a task
  called `/hlep`, even while the command menu was saying "command not found".
- **Right-clicking the ball** no longer drags the window or opens the panel.
- **A corrupted setting no longer stops the app from starting.** One damaged value could prevent
  the whole interface from loading, which looked exactly like the ball having vanished.
- `/deadline 9:30` is stored as `09:30`, and setting a time that has already gone by says so
  instead of turning the whole panel red with no explanation.
- `Enter` on an empty editor cancels the edit, rather than doing nothing at all.
- Warnings are amber now, instead of the colour used for confirmations.
- Bold text uses the real bold weight instead of a synthesised one.
- Several status messages were being cut off mid-word; the ones this release touches now fit.

---

## [0.3.0] — 2026-08-11

*`0.2.0` below means the last published state of `main` — the repository had no tags before
this release.*

Themes arrive, the command menu learns to finish your sentences, and a day of subtask-only
work is no longer thrown away.

### Added

- **Colour themes.** `/theme default | mono | ice`. Each preset ships its own accent palette
  and its own deadline ramp, not just a different hue — `ice` moves its action accent to
  violet because cyan would disappear into a blue interface, and `mono` is greyscale with no
  ramp at all, for people who don't run deadlines.
- **Three ways to switch theme.** Type it in full (`/theme ice`); type any unique prefix
  (`/theme i`); or type `/theme` followed by a space and click a swatch in the menu — the
  click applies immediately. Bare `/theme` lists the presets and marks the active one.
- **`/theme ramp on|off`.** Turns off the glow that slides toward red over the two hours
  before a deadline. Persists independently of the preset, so switching themes won't quietly
  re-enable a ramp you turned off.
- **`/deadline off`** (`clear` and `none` also work) clears today's deadline before the day
  rolls over. Bare `/deadline` reports what's currently set.
- **The `/` menu completes arguments, not just command names.** After a command and a space
  it lists that command's values, `→` or `Tab` accepts the greyed-out suggestion, and the
  rows are clickable.

### Changed

- **Requires WebView2 ≥ 111.** Theme transparency depends on CSS `color-mix()`, which has no
  fallback once the colour is a variable.
- **The built-in manual (`/help`) was reorganised.** The MOUSE tab lost three rows that were
  explanations rather than controls; they moved to ABOUT, which also now lists the available
  presets and marks the active one.
- **`Ctrl+Z` is documented as keyboard-only.** Every other list action has a mouse
  equivalent; undo deliberately does not.
- The version shown in ABOUT is read from the app manifest instead of being hardcoded, so it
  can no longer disagree with the installer.

### Fixed

- **A day of subtask-only work archived nothing at all.** The rollover only archived
  *top-level* completed tasks, and completion is derived upward — so finishing six subtasks
  under one unfinished parent produced no history entry and no daily Markdown log. Both now
  count every completed leaf.
- **Typing a slash command while editing a task could destroy your list.** `/clear` typed at
  the `edit>` prompt wiped every task; `/deadline 18:00` renamed the task being edited.
  Editing now takes precedence over all command matching.
- **Undo now restores your selection to the item it belonged to**, rather than to whatever
  has since moved into that position. An item deleted and then restored with `Ctrl+Z` comes
  back selected.
- **A one-second colour wash on every panel open.** Newly shown elements animated from a
  hardcoded colour to their real one. It was invisible on the default green and covered the
  whole interface on `mono` and `ice`.
- **Bare `/deadline` used to add a task literally named "/deadline".** Malformed input now
  reports itself instead of being swallowed — a mistyped deadline was invisible until the
  glow failed to ramp hours later.
- **A hand-edited or malformed deadline displayed `T+NaNm`** in the header countdown.
- **Launch-at-login now actually reaches everyone, and survives a reinstall.** It was only
  ever switched on for people installing for the very first time — upgrade from an older
  version, or reinstall, and it stayed quietly off with no way to notice. It's now on by
  default whatever your install history, and the app tells you when it enables it. Turn it
  off and it stays off, through any later reinstall: your choice is recorded and reapplied
  on every start, in whichever direction you set it.
- **`Ctrl+Z` no longer has dead presses.** Committing an edit without changing the text, or
  running `/clear` on an empty list, used to consume an undo step — so the next press
  appeared to do nothing. Only real changes take a slot now.
- **Selected backlog rows were hard to read** against their own highlight.
- **Duplicate entries could accumulate in the archive.**
- Your theme and ramp settings are included in the on-disk backup and in `/export`, so they
  survive a restore.
- **Development builds no longer share storage with an installed copy.** They used to write
  to the same folder and the same browser profile, so testing the app could overwrite real
  tasks *and* the backup they would be restored from.

### Performance

- The ball's breathing animation no longer drives a GPU brightness filter — this was the
  app's largest always-on cost while idle.
- Saves now write only the values that actually changed, instead of rewriting everything
  (including the whole archive) on any edit.

---

## [0.2.0]

The last published state of `main` before the above. Floating-ball HUD with three-level
nested tasks, the aging backlog, daily rituals, deadline glow, streak and history, launch at
login, tray menu, and three-layer local persistence.
