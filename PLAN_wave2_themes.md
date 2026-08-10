# Wave 2 — Themes: binding spec

Status: **spec only, nothing implemented.** Written 2026-08-06.

This file is binding for the theme work the way `PLAN_wave3_nesting.md` was binding for
nesting. Where it disagrees with `PROJECT_SUMMARY.md`'s Wave 2 paragraph, this file wins.

Decisions already made (do not relitigate):

- **Preset palette**, not a free hue picker. Each preset ships its own accent set.
- **Per-preset deadline ramp**, plus a switch to turn the ramp off entirely.

---

## 1. The problem, stated precisely

`--theme-color` is currently produced entirely by `useDeadlineColor` and injected once, on
the root div (`App.tsx` ~2383), as an inline style. Everything else reads
`var(--theme-color)` — 43 sites. That part is already clean and needs no restructuring.

The problem is the **hardcoded** colors around it. Four semantic roles are spelled as
literal Tailwind classes, and two of them sit on top of the ramp:

| Role | Current literal | Hue | Sites |
|---|---|---|---|
| identity / chrome | `var(--theme-color)` | 142 → 0 (ramps) | 43 |
| transient action feedback | `cyan-300/400/500/950` | ≈187 | 16 |
| edit mode + aging | `yellow-400`, `yellow-600` | ≈54 | 4 |
| destructive + error | `red-400` | ≈0 | 6 |
| affirmative affordance | `green-400` | ≈142 | 7 |

`useDeadlineColor` ramps `hsl(142,70%,45%) → hsl(0,70%,50%)`. So:

- **`green-400` IS the resting theme color.** At rest, the "complete this" and "promote
  this" hover affordances are the same hue as every piece of chrome around them.
- **`red-400` IS the ramp's endpoint.** Past deadline, the entire UI turns the color that
  otherwise means *destructive*.

These collisions exist **today**. They are survivable only because the two ends of the ramp
are never on screen at the same moment. Any theme feature makes them simultaneous, which is
why the accents have to become variables before a single preset ships.

A secondary finding: four of the seven `green-400` uses are **help-modal section headers**
(`» [ KEYS ]` etc., lines ~2686/2744/2756/2772). Those are identity, not affirmation. They
are miscategorised today and should move to the theme color, not to the affirmative accent.

## 2. The variable set

Five custom properties, all set on the same root div that already carries
`--theme-color`. Names are semantic, never chromatic — a preset may legitimately make
`--accent-action` orange, and a variable called `--cyan` would then be a lie.

```
--theme-color      identity + chrome. Ramps, unless the ramp is off.
--accent-action    transient feedback: move preview, flash pulse, sub-entry mode, notices
--accent-edit      edit mode (caret/placeholder) + backlog aging
--accent-danger    destructive affordances, [ERR] notices, overdue
--accent-affirm    affirmative affordances: complete-hover, promote-hover
```

**Amended after taking the real inventory.** Five variables is not enough. The
hardcoded accents use *multiple stops per role* — `cyan-300`, `cyan-400`, `cyan-500` and
`cyan-950` all appear, as do `yellow-400` and `yellow-600` — and they are not
interchangeable: `cyan-950` is a wash behind body text, `cyan-300` is a highlight on top of
one. Collapsing them to a single stop would change how the app looks, which §8.2 forbids.
So the real set is eight, and a preset defines all eight explicitly rather than deriving
them. Deriving with `color-mix` was the first instinct and it is wrong here: no formula
reproduces Tailwind's stops exactly, so `default` would drift on day one.

```
--accent-action        cyan-400  #22d3ee    the accent itself
--accent-action-soft   cyan-300  #67e8f9    highlight on top of a wash
--accent-action-deep   cyan-500  #06b6d4    the ⌁ surface prompt
--accent-action-wash   cyan-950  #083344    dark fill behind body text
--accent-edit          yellow-400 #facc15   caret + placeholder
--accent-edit-dim      yellow-600 #ca8a04   backlog aging tags
--accent-danger        red-400   #f87171
--accent-affirm        green-400 #4ade80
```

Opacity variants (`/70`, `/40`, `/30`…) stay as `color-mix` against `transparent` — see
§8.3. Those are per-*use*, not per-preset, so they do not multiply the table.

**Contrast rule, enforced per preset, not at runtime:** every accent must sit ≥40° from
`--theme-color`'s *resting* hue and ≥30° from every other accent. This is a review-time
check on the preset table, not code. It is the entire reason a free hue picker was
rejected — there is no way to enforce it against a slider without silently overriding the
user's choice.

## 3. Presets

Each preset is a plain object. `default` MUST reproduce today's appearance byte-for-byte —
a user who never runs `/theme` must not be able to tell this wave shipped.

```ts
type Preset = {
  name: string;
  theme: string;          // resting identity color
  action: string;
  edit: string;
  danger: string;
  affirm: string;
  ramp: { from: string; to: string } | null;   // null = this preset has no ramp
};
```

**Shipping three: `default`, `mono`, `ice`.** `amber` and `violet` were previewed and
deferred — adding either later is one table row, which is the point of the structure.

| name | identity | action | edit | danger | affirm | ramp |
|---|---|---|---|---|---|---|
| `default` | `#4ade80`-family, rest `hsl(142,70%,45%)` | cyan 187 | yellow 54 | red 0 | **142, grandfathered** | 142 → 0 |
| `mono` | `hsl(0,0%,82%)` — zero saturation | cyan 187 | yellow 54 | red 0 | green 142 | **null** |
| `ice` | `hsl(200,80%,60%)` | **violet 280** | yellow 54 | red 0 | green 142 | 200 → 0 |

`ice` is the one that proves the design. Its identity sits at 200°, only 13° from the stock
cyan action accent, so move-feedback would be invisible against its own chrome — action
moves to violet **for that preset only**. This is precisely the failure a single hue slider
could not have prevented, and precisely why accents belong to the preset rather than to the
app. (`amber`, when it lands, has the same problem one role over: its 45° identity swallows
the 54° edit accent, so edit moves to magenta.)

`mono` carries `ramp: null` deliberately — it is the preset for people who do not use
deadlines, and a grey identity that lurched to red would be incoherent.

**The `default` affirm problem.** Today's affirmative accent is `green-400` ≈142, which is
exactly the resting theme color. Reproducing today's look byte-for-byte and satisfying the
≥40° contrast rule are therefore in direct conflict *for the default preset only*. Resolve
it in `default`'s favour of fidelity — keep 142 — and treat it as the one grandfathered
violation, documented in the preset table as such. Every *other* preset must obey the rule.
Do not "fix" the default by nudging it; that changes the app's appearance for every
existing user, which this wave has already committed not to do.

## 4. Ramp behaviour

- Preset supplies `ramp: {from, to}`. `useDeadlineColor` stops hardcoding 142 and 0 and
  interpolates between the active preset's endpoints instead. Its existing structure
  (2h window, 60s tick, lightness +5 across the ramp) is unchanged.
- `ramp: null` → `--theme-color` is constant at `preset.theme`; the hook returns early.
- A separate user switch, `--ramp off`, forces `null` regardless of preset. Persisted
  independently of the preset choice, so switching presets does not silently re-enable a
  ramp the user turned off.
- When the ramp is off, urgency still has to reach the user — the countdown text in the
  header is the fallback and must be verified as legible. **Do not** add a pulse/glow as a
  substitute in this wave; that is a separate design decision.

## 5. Interface

**No new focusable elements.** Invariant #1 (the command `<input>` holds keyboard focus at
all times) rules out a click-through theme picker in the help modal. Themes are driven by
command only:

```
/theme              → notice listing preset names, current one marked
/theme <name>       → switch, persist, confirm by notice
/theme ramp off|on  → toggle the ramp
```

`/theme` with no argument must not open anything modal. Register both in `COMMANDS` so the
`/` hint dropdown surfaces them.

## 6. Persistence and migration

- `localStorage['geek-theme']` = preset name. Absent or unrecognised → `default`.
- `localStorage['geek-ramp']` = `'off'` only when disabled; absent means on.
- Both follow the existing `geek-deadline` / `geek-hotkey` pattern exactly.
- No migration step. An unknown name falls back to `default` silently — a user who
  downgrades and re-upgrades must not get an error notice on launch.
- Themes are **presentation only**. Nothing here may touch `state.json`, the archive
  format, or anything under `dispatch`. A theme change must not push an undo entry.

## 7. Implementation steps (sequential subagents, one file)

`App.tsx` is one ~2600-line file. Agents collide on it, so: sequential only, `tsc` and a
commit between each, then a fresh read-only agent audits the whole diff.

1. **Variables without behaviour.** Define the five vars on the root div, hardcoded to
   today's exact values. Replace all 33 literal accent classes with `var(...)` reads.
   Move the four help-modal section headers from affirm to theme. **Zero visible change** —
   this step is verified by the app looking identical, nothing else.
2. **Preset table + resolution.** Add the `Preset` type, the table, and preset lookup.
   Still no UI; `default` stays active.
3. **Ramp parameterisation.** `useDeadlineColor` takes endpoints from the active preset;
   handle `ramp: null` and the off switch.
4. **Commands + persistence.** `/theme`, `/theme <name>`, `/theme ramp off|on`,
   localStorage, `COMMANDS` entries.
5. **Audit.** Fresh read-only agent against §8 below and `PLAN_wave3_nesting.md` §1.

Step 1 is the whole risk. Steps 2-4 are mechanical once it lands.

## 8. Invariants this wave must not break

Everything in `PLAN_wave3_nesting.md` §1 still binds. Additionally:

1. **No focusable element** may be added — §5 exists to satisfy this.
2. **`default` is pixel-identical to today.** The step-1 commit is the checkpoint for this;
   if anything shifts, stop and fix before step 2.
3. **Opacity modifiers.** Tailwind's `/70` slash syntax on an *arbitrary* value
   (`text-[var(--x)]/70`) is not reliable across versions. Use explicit
   `color-mix(in srgb, var(--x) 70%, transparent)`, which the codebase already does for the
   theme-color glows (~2389, 2404, 2633). Do not assume the slash form compiles.
4. **`cyan-950` is a wash, not an accent.** It must become a `color-mix` against `#000`
   (`--accent-action-wash`), not a lightness variant of the accent — the four `cyan-950`
   sites are backgrounds behind body text and their contrast is load-bearing.
5. **No accent may equal the active `--theme-color` at any point in its ramp**, except the
   grandfathered `default`/affirm case in §3.
6. A theme change **must not** dispatch, must not push history, and must not touch
   selection.
7. `transition-colors duration-1000` already sits on most theme-colored elements, so
   switching presets will crossfade over 1s. Verify that reads as deliberate and not as
   lag; if it does not, the switch may set a one-shot class that suppresses the transition.

## 9. Explicitly out of scope

Free hue picker. Per-element color overrides. Light mode (the whole UI assumes a dark
translucent panel; a light theme is a different project). Font/opacity/density settings.
Replacing the deadline ramp with a non-hue urgency channel — that idea was raised and
deferred, not adopted.
