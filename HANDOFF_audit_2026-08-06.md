# 🔁 Handoff — Terminal Task Widget: audit of the 2026-08-06 batch

> Scratch document for one audit session. Delete it once the audit is folded back into
> `PROJECT_SUMMARY.md`. Everything durable belongs there, not here.

## Background & Environment

Windows floating-ball task HUD. Tauri 2 + React 19 + TS 5.8 + Vite 7 + Tailwind 4.
Repo root is the PARENT folder; the app (and `package.json`) is in `terminal-task-widget\`
— `cd` in before any npm command. ~2990 lines of `App.tsx` hold virtually all logic.

READ FIRST, in the repo root:

- `PROJECT_SUMMARY.md` — architecture, invariants, residual issues, tooling quirks, git rules.
- `PLAN_wave3_nesting.md` §1 — ten load-bearing invariants. Still binding.
- `PLAN_wave2_themes.md` — binding spec for the theme work; §8 has its own invariants.

## Goal of this session

A full audit of the eight commits landed 2026-08-06, plus a review of the *process* that
produced them — the working assumption is that it grew too complex and needs simplifying.
Both halves matter; the process critique is not an afterthought.

## The batch under audit (`4565c71..ffa9da7`)

```
1a9a332  selection anchored to node ids instead of positions
bd55443  themes spec (docs)
3248b74  backlog selection made legible
d501401  archive completed work at every depth (+ README path leak fix)
eefd323  Wave 1: /deadline off, version from package.json, archive dedupe
0269598  themes spec revised: 3 presets, 8 accent vars (docs)
66d25c2  Wave 2 step 1: accent roles -> CSS variables
e90704c  Wave 2 steps 2-4: presets, parameterised ramp, /theme
73d584f  summary: Wave 2 status, verification debt, residuals 7-9 (docs)
ffa9da7  summary: correct two stale facts (docs)
```

## ⚠ The single most important fact

**Almost none of this has been RUN.** Only two things were exercised in a live app
(`npm run dev`): the backlog-selection highlight, and `/deadline` + `/deadline off`. Both
reported fine. Everything else is `tsc` + `vite build` + read-through, plus two mechanical
CSS diffs. No `tauri build` since the identifier change, so the installed app predates the
whole batch. **Treat every claim below as unverified-by-use.**

## What changed, and the reasoning to check

1. **`sel` is id-anchored.** State holds `SelRef {kind,id}`; the positional `Sel` every
   consumer reads is derived per render via `resolveSel`. Setters still take a position and
   convert via `selRefOf` against `tasksRef`/`backlogRef` — this relies on `dispatch`
   updating those refs **synchronously**, and on every positional `setSel` call site
   dispatching first. I checked all 19; worth re-checking independently.
   `selCache` stabilises `sel`'s object identity so an unrelated mutation cannot re-fire the
   scroll effect (invariant #6).
   Emergent behaviour: deleting the selected node then `Ctrl+Z` restores the selection onto
   it, because the id outlives the node. Intentional but new.

2. **Archive.** Rollover used `saved.filter(t => t.completed)` — top-level only — so a day
   of subtask-only progress archived **nothing** and never called `exportDailyLog`. Now
   `completedLeaves` (flat, for the LOG tab and `weekStats`) and `completedTree` (pruned,
   hierarchy intact, for the `.md`). Same-date entries now replace rather than append.

3. **`useDeadlineColor` emitted `hsl(NaN,70%,NaN%)` whenever no deadline was set** — the
   default state. `''.split(':').map(Number)` is `[0]` so `dm` is undefined and everything
   downstream is `NaN`. Every `var(--theme-color)` became invalid: text fell back to
   `:root { color: #00ff00 }` (close enough to the intended green to hide the bug), but the
   `color-mix()` borders and glows were dropped outright — no panel border, no ball glow.
   Guarded with `isFinite`. This was a prerequisite for `/deadline off`, which walks users
   into that exact state deliberately.

4. **Themes.** Eight accent variables as inline style on the root div; all 39 former
   Tailwind accent classes now read `[var(--accent-*)]`. Presets `default`, `mono`, `ice`.
   Ramp generalised to two HSL triples lerped componentwise. `/theme`, `/theme <name>`,
   `/theme ramp on|off`, persisted to `geek-theme` / `geek-ramp`. Command-driven because
   invariant #1 forbids adding a focusable element to the panel.

## What we ruled out — do not re-litigate

- **Free hue picker (single knob).** `green-400` and `red-400` *are* the deadline ramp's two
  endpoints, so the accents already collide with the theme at both ends. A slider cannot be
  made safe without silently overriding the user's choice. A **full** custom preset (user
  supplies all eight colours) is acceptable and deferred.
- **Deriving accent stops via `color-mix`.** No formula reproduces Tailwind's stops, so
  `default` would drift on day one.
- Unlimited nesting depth; ASCII tree branches at depth; drag-and-drop reorder.
- **Residual #5** (childless parent keeps its derived tick) — **decided as intended
  behaviour**; it matches the original derived-completion design. Do not "fix" it.

## Known-open, deliberately not done

- **Promote clears the selection** (residual #7): `Space` on a backlog row promotes then
  calls `setSel(null)`, so `↓` jumps to the first **task** and a further `Space` completes
  it. Two precedents for the fix already exist (`deleteNode`, backlog-`Backspace`).
- **Nested subtask selection reads weakly** (residual #8) — cannot take the `border-l-2`
  treatment the backlog got, because it collides with the ancestry rule.
- `/export md` for the current day. Residuals #2, #3, #4, #6 unchanged from before.
- **Wave 2 step 5**: the read-only audit pass was never run. This session is it.

## Next steps

1. Audit the diff `4565c71..ffa9da7` against `PLAN_wave3_nesting.md` §1 and
   `PLAN_wave2_themes.md` §8. Prior audits of this codebase found real bugs **twice**.
   Highest-suspicion areas: the `setSel`-after-`dispatch` contract; `selCache` identity;
   whether any positional `setSel` site was missed; the ramp rewrite's edge cases.
2. Critique the process itself — commit granularity, the spec-first workflow, how much was
   verified by build versus by use, and whether the docs have grown past their value.
3. Then build, install, and actually feel-test. Verification debt is the top risk.

## Key artifacts

- **`git push` has never run this session — the batch is LOCAL ONLY.** The sandbox has no
  credentials; push from PowerShell. A verified bundle backup exists
  (`ttw-2026-08-06.bundle`, "complete history", HEAD at the batch tip).
- `default` is verified byte-identical by building the CSS before and after, substituting
  the new var names back (`--accent-action` → `--color-cyan-400`), and diffing rule sets.
- **New hard floor: WebView2 ≥ 111.** Tailwind cannot pre-bake alpha into a hex fallback
  when the colour is a `var()`, so transparency rides entirely on the
  `@supports (color-mix)` block. Do not "fix" this by inlining hexes — that defeats theming.
- Tailwind 4 **does** compile `text-[var(--x)]/70` to `color-mix`. The spec's original
  warning to the contrary was wrong and has been corrected.
- `vite build` hangs on the sandbox mount — copy `src`, `index.html`, `package.json`,
  `tsconfig*.json`, `vite.config.ts` to `/tmp/b`, symlink `node_modules`, build there (~3s).
- Every git command run in the Cowork sandbox must append
  `find .git \( -name '*.lock' -o -name 'tmp_obj_*' \) -delete`,
  and needs the "allow file delete" tool called once per session first.
- **The repo is PUBLIC**: never write real paths or the OS username into tracked files. The
  pre-push scan caught exactly this in `README.md` this session — run it every time.

---

**Quick start for the new chat:**

> Continue from `HANDOFF_audit_2026-08-06.md` in the repo root. Start with step 1: audit the
> diff `4565c71..ffa9da7` against both invariant lists, read-only, and report findings
> before changing anything.
