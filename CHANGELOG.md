# Changelog

All notable user-facing changes to Terminal Task Widget.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
