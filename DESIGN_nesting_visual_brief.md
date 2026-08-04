# Visual Design Brief — Arbitrary-Depth Task Nesting in a 400px Terminal HUD

**Purpose of this document:** a self-contained context pack for discussing the *visual
presentation* problem with people or models who have never seen this codebase. It
states the product, the aesthetic constraints, the exact current metrics, and the
specific open questions. It deliberately does **not** cover the data-model or
navigation refactor — that lives in `DESIGN_nested_subtasks.md`.

---

## 1. The product, in one paragraph

A Windows desktop floating-ball task widget (Tauri 2 + React + Tailwind 4). Collapsed
it's a 60×60 always-on-top ball docked at the right screen edge; clicking expands it to
a **400×600 frameless panel** with a Matrix/terminal aesthetic — near-black translucent
background, JetBrains Mono throughout, glowing monochrome text, ASCII box-drawing
characters, a blinking command prompt at the bottom that owns all keyboard input. It is
explicitly *not* a general task manager: it's a single-day HUD, no projects, no tags,
no cloud sync. Users interact via both keyboard (arrows, Tab, Space, Enter) and mouse
(hover-reveal action pills).

Today the task tree is **exactly two levels**: tasks and subtasks. We're moving to
arbitrary depth because users report they can't break a subtask down further. The
logic side is solved on paper. The **visual side is not**, and it's the harder half —
400px is very little horizontal room, and the terminal aesthetic constrains the
available vocabulary.

---

## 2. Hard constraints

- **Panel: 400 × 600 logical px.** Not resizable by design. This is a HUD that sits at
  the screen edge, not a window you work in.
- **Monospace only** (JetBrains Mono). At the body size of 14px, character advance is
  **8.4px** (0.6em). Every horizontal decision is denominated in whole characters.
- **Terminal aesthetic is the product's identity.** ASCII/box-drawing glyphs
  (`├─`, `└─`, `[x]`, `>_`) are on-brand; rounded chips, icon fonts, and colored dot
  bullets are off-brand. Solutions that look like Todoist are wrong answers here even
  if they're more legible.
- **Existing color semantics are load-bearing** and can't be reassigned:
  - `--theme-color` — a single global accent that ramps green → red over the 2h before
    the day's deadline. Used for top-level task text, borders, prompt, header.
  - **cyan** — subtask-entry mode, move/reorder feedback (ghost preview + landing pulse), transient notices.
  - **amber** — edit mode, backlog aging tags.
  - **red** — errors, overdue.
  - **gray** — subtask text (`gray-400/80`), inactive chrome.
- **Both input modes must stay first-class.** Keyboard users navigate with ↑/↓ through
  a flattened list; mouse users hover rows to select and reveal a two-stage action pill.

---

## 3. Current visual vocabulary (exact values)

### Vertical budget

| Element | Height |
|---|---|
| Panel | 600px |
| Header (`admin@local:~#` + deadline countdown) | 32px |
| Progress bar + notice line | ~36px |
| Command input row | ~44px |
| **Scrollable list** | **~490px** |

A top-level task row is ~36px (`px-3 py-2` + one text line); a subtask row is ~20px.
So the list holds roughly **13 top-level rows, or ~24 subtask rows**, before scrolling.

### Horizontal budget

```
400px panel
 -32px  list container padding (px-4, both sides)
 =368px content width  ≈ 43 characters
 -24px  row padding (px-3, both sides)
 =344px top-level text column  ≈ 41 characters
```

Current subtask row: `ml-6` (24px) + glyph prefix `├─ [ ] ` (7 chars = 59px)
→ **261px ≈ 31 characters** of text.

### Markup, as it stands

**Top-level task row**
- Text: `[1] Buy groceries` — bracket holds the 1-based ordinal, or `[x]` when complete.
- Completed: `opacity-40 line-through`.
- Selected: `bg-gray-800/80 shadow-md border-l-2 border-[var(--theme-color)]`.
- Unselected: `border-l-2 border-transparent hover:bg-gray-900/40`.
- Text wraps (`break-words`); rows grow vertically, they never truncate.

**Subtask row** (inside `ml-6 space-y-1`)
- Text: `├─ [ ] Call the vet` / `└─ [x] ...` — last child gets `└─`.
- `text-sm text-gray-400/80` — note subtasks are **gray, not theme-colored**.
- Selected: `bg-gray-700/50 rounded px-1 -mx-1` (no left border).
- The glyph is a **separate flex child** (`shrink-0`) from the text span, so wrapped
  continuation lines align under the text column rather than under the glyph. This is
  a small but important detail that any solution must preserve.

**Feedback states**
- Reorder landing pulse: task `bg-cyan-950/50 border-l-2 border-cyan-400`; subtask `bg-cyan-950/60 rounded px-1 -mx-1`. 350ms.
- Pending-move ghost (an absolutely-positioned preview at the insertion boundary):
  - for a **task**: condensed one-liner, dashed cyan left border, `⇥ text ·N sub`;
  - for a **subtask**: a thin dashed horizontal rule with a small label chip, `ml-6`.
  - (A full-height ghost for a single-line row blanketed both neighbours — hence two styles.)
- Sub-entry mode: parent row gets `bg-cyan-950/30 border-l-2 border-cyan-400/70` plus a hint line `└─ typing below adds here · Enter chains · Esc done`.

**Action pill** — absolutely positioned at the row's right edge, two-stage: row hover
shows a compact `[ ⋯ ]` chip; hovering *that* expands `[^][v][+][»][x]`. Two-stage
because a reserved-width pill caused reflow on hover and a fixed bottom action bar lost
direct manipulation. Both alternatives were tried and rejected.

---

## 4. The core tension

**In a monospace terminal UI, the ASCII ancestry prefix *is* the indentation — using
both CSS margin and glyph prefixes double-charges for depth.**

A full ancestry prefix (`│  ` per ancestor that has a following sibling, then `├─`/`└─`)
costs **3 characters ≈ 25px per level**. CSS indent can be tuned to 12–16px per level.
Doing both costs ~40px per level, which at depth 5 eats 160px of a 344px column.

Three coherent directions, each internally consistent:

| | **A. Pure ASCII tree** | **B. Pure CSS indent** | **C. Current hybrid, extended** |
|---|---|---|---|
| Structure shown by | box-drawing prefix only, no margin | margin only, one marker per row | margin + single connector glyph at row start |
| Cost per level | 25px | 12–16px | ~40px |
| Depth 5 text column | ~218px (26 ch) | ~272px (32 ch) | ~184px (22 ch) |
| Ancestry legible? | Yes — vertical rules connect | Weakly — alignment only | **No** — can't tell which ancestor a deep row belongs to |
| Wrapped-line alignment | Hard (prefix is inline text) | Easy | Easy (current split-span trick) |
| On-brand? | Most | Least | Middle |

Direction C is what exists today, and it works *only* because depth 2 makes ancestry
unambiguous. At depth 3+ it degrades: two rows at the same indent under different
parents look identical when their parents have scrolled apart.

---

## 5. Questions that need answers

Ordered roughly by how much they constrain everything downstream.

**Q1 — Which structural direction: A, B, or C?**
Is authentic ASCII tree-drawing worth ~25px/level and the wrapped-line alignment
problem? Or does a narrow HUD argue for pure CSS indent with the terminal feel carried
by the glyphs *within* a row (`[x]`, `>`) rather than between rows? Is there a fourth
option — e.g. ancestry rules drawn as 1px CSS borders positioned at character
boundaries, giving the look of `│` at a fraction of the width?

**Q2 — How deep before it stops working, and what happens at the limit?**
Current proposal is a hard cap at depth 5 with a `[!] max depth` notice. Is 5 right for
a 400px panel? Should the cap be *visual* rather than structural — e.g. unlimited depth
in the data, but levels beyond N render flattened with a marker?

**Q3 — How does a row signal its depth beyond position?**
Today there's a hard two-tone rule: top-level = theme color, subtasks = `gray-400/80`.
Options: keep two-tone forever (everything below level 1 is gray), ramp opacity per
level and clamp after 2–3 steps, or vary the marker instead of the color
(`[ ]` → `[·]` → `[-]`). An opacity ramp reaches unreadable fast on a translucent
near-black background; a fixed two-tone loses depth cues entirely.

**Q4 — Does the ordinal survive?**
Top-level rows show `[1] [2] [3]`; subtasks show `[ ]`/`[x]`. At depth, do we do
`[1.2.3]` (terminal-ish, but 7+ characters and noisy), keep ordinals top-level only, or
drop them entirely?

**Q5 — What does "selected" look like at depth?**
Today: top-level gets a theme-colored 2px left border + background; subtasks get only a
background. With n levels, a left border *at the row's own indent* would visually read
as another tree line. A full-bleed border at the container edge decouples the highlight
from the row it marks. Which reads better in a narrow list?

**Q6 — Which ghost style applies at depth?**
The pending-move preview has two styles: a condensed block for parents, a thin
insertion rule for single-line rows. With arbitrary depth, "is a parent" and "is
visually tall" are no longer the same question — a depth-4 node with children is still
a one-line row. Should ghost style key off *has children*, off *rendered height*, or
should there be a single style that works for both?

**Q7 — Folding: how does a collapsed node read?**
Folding is near-mandatory once depth is unbounded (13 visible rows). A collapsed parent
needs to show that children are hidden and how many. Terminal-native options: `[+]`/`[-]`
prefix, a trailing `·4` count, an ellipsis child row `└─ …4 more`. Which is least
noisy, and where does the affordance live — inline in the row, or in the hover pill?

**Q8 — Does the action pill still work at depth?**
It's absolutely positioned at the row's right edge. Deep rows are narrower, so the pill
covers proportionally more of the text. At depth 4–5 the expanded pill
(`[^][v][+][»][x]` ≈ 20 chars ≈ 168px) may exceed the remaining text column entirely.
Fewer buttons at depth? A different trigger? Overflow to the row above?

---

## 6. Non-negotiables for any proposal

1. Wrapped continuation lines must align to the text column, not under the glyph.
2. No horizontal scrolling. Text wraps; rows grow.
3. The command input at the bottom keeps keyboard focus at all times — no solution may
   introduce a focusable element in the list.
4. Hover must not cause reflow (it moves the row out from under the cursor and breaks
   the hover-selection model).
5. Cyan/amber/red keep their existing meanings; depth cues must come from a different
   channel.
6. Must degrade gracefully at depth 1–2, which is what 90% of real use will be. The
   common case must not get *worse* to serve the rare deep case.
