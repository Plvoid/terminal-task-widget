# Design — Arbitrary-Depth Subtasks (Wave 3)

Status: **draft for review**. Nothing implemented. Line references are against `src/App.tsx`
after the monitor-positioning fix (2026-07-30).

---

## 1. Why this is a refactor and not a feature

`Task` is already recursive:

```ts
interface Task { id: string; text: string; completed: boolean; subtasks?: Task[]; createdAt?: number }
```

Everything *around* it assumes exactly two levels:

| Concern | Today | Where |
|---|---|---|
| Selection | three ints: `selectedIndex`, `selectedSubIndex`, `selectedBacklogIndex` | 173–175 |
| Edit target | `{index, subIndex, isBacklog?}` | 176 |
| Sub-entry target | `subEntryTarget: number` (a top-level index) | — |
| Reorder | `applyMove(kind:'task'\|'sub'\|'backlog', parent:number, from, to)` | 844 |
| Row identity | `t-${i}` / `s-${i}-${j}` / `b-${i}` | 1705, 1769, ghost 1577 |
| Navigation | ~95 lines of nested index juggling | 1064–1158 |
| Demote | **flattens grandchildren into siblings** | 948–964 |
| Render | `tasks.map` with a hardcoded inner `subtasks.map` | 1702–1820 |
| Archive md | one hardcoded indent level | 287–291 |

Two things are already depth-agnostic and need no work: `countLeaves` (96) and the
persistence payload. **No data migration is required** — existing two-level state is
valid n-level state, and new deep state stays readable by the current serializer.

> ⚠️ One-way door: state written with depth ≥ 3 and then opened by an *older* build
> renders only two levels. The data isn't lost (it round-trips through `JSON.parse`),
> but the user can't see or reach it. Note this in the release notes; don't downgrade.

---

## 2. Identity: path as currency, id as anchor

**Decision: `path: number[]` is the primary UI currency; `id` is the stable anchor
across mutations.**

- `[2]` = third top-level task. `[2,0,3]` = its first subtask's fourth child.
- Paths are positional, so *any* reorder invalidates a stored path. That's already
  true today (it's why pending caret-moves are cancelled by any list mutation —
  `dispatchTasks` guard) and the guard carries over unchanged.
- Where a reference must survive a mutation, resolve by `id` and re-derive the path.
  `applyMove` already does this in spirit by selecting `to` after the splice.

### State replacement

```ts
type Sel = { kind: 'task'; path: number[] } | { kind: 'backlog'; index: number } | null;
const [selection, setSelection] = useState<Sel>(null);
```

This collapses three `useState`s into one and makes "which row is selected" a single
comparison (`samePath`) instead of the current three-way `i === selectedIndex &&
sIdx === selectedSubIndex` conditionals repeated at every render site.

- `editingNode` → `{ kind, path }`, same shape as `Sel`.
- `subEntryTarget: number` → `path: number[] | null`.
- Row keys → `t-${path.join('.')}` and `b-${i}`. Ghost/flash logic keeps its shape;
  only `keyAt()` changes.

### Core helpers (new, ~40 lines total)

```ts
const nodeAt   = (tasks: Task[], path: number[]): Task | null
const parentOf = (tasks: Task[], path: number[]): Task[] | null  // the sibling array
const samePath = (a?: number[]|null, b?: number[]|null) => !!a && !!b && a.length===b.length && a.every((v,i)=>v===b[i])
const childrenOf = (t: Task) => t.subtasks ?? []
```

All mutations keep the existing `JSON.parse(JSON.stringify(tasks))` clone-then-splice
pattern (cheap at this scale, and it keeps `dispatchTasks`' undo snapshotting honest).

---

## 3. Navigation: one flat list

The single biggest simplification. Replace lines 1064–1158 with:

```ts
type Row = { kind: 'task'|'backlog'; path: number[]; index: number; task: Task; depth: number; lastChild: boolean };
const rows = useMemo(() => flattenVisible(tasks, backlog), [tasks, backlog]);
```

`flattenVisible` walks tasks depth-first in visual order, then appends backlog rows.
↑/↓ becomes `rows[curIdx ± 1]` with the same wrap behaviour (tasks → backlog → tasks).
Every special case in the current code — "last sub of the previous task", "first task
after backlog", "wrap when there are no tasks" — disappears, because the flat list
*is* the visual order.

Bonus: `flattenVisible` is also the natural place to skip collapsed subtrees (§7) and
to feed the ghost overlay's slot lookup.

---

## 4. Reorder

`applyMove(kind, parent, from, to)` → `applyMove(parentPath: number[]|'backlog', from, to)`,
where `[]` = top level. `nudgeRow`, `pendingMove`, `moveSelected` and the Alt+wheel
handler all just carry `parentPath` instead of `parent:number` + `kind`.

**Decision: reorder stays sibling-only.** Alt+↑ on the first child does *not* pop it
out to become a sibling of its parent — that's what Shift+Tab is for. Rationale: the
alternative makes a single keypress silently change an item's meaning, and it makes
the ghost preview's insertion boundary ambiguous (two valid slots at the same pixel).

Ghost overlay (1571): `keyAt` becomes path-based; the condensed parent ghost keeps
`·N sub` where N = **direct** children (not total descendants — clearer at a glance).

---

## 5. Demote / promote — the actual payoff

This is where arbitrary depth pays for itself.

**Today** (948–964), demoting a task with subtasks pushes the task under its previous
sibling and then splices its children in *behind* it as siblings, because depth 2 is
the ceiling. The `N subs carried along` notice exists to explain that the structure
was mangled. It was a data-loss fix, not a good outcome.

**After:**

| Action | Semantics |
|---|---|
| `Tab` (demote) | Node becomes the **last child of its previous sibling, subtree intact**. No-op if it's the first sibling. |
| `Shift+Tab` (promote) | Node becomes the **next sibling of its parent, subtree intact**. No-op at top level. |

Both are now a pure splice of one node — no child flattening, no notice needed. The
`[ » ]` / `[ « ]` pill buttons keep calling the same two helpers.

---

## 6. Completion propagation

Currently `syncParentFromSubtasks(tasks, parentIdx)` (1504) is called ad hoc at three
sites, and toggling a parent cascades exactly one level down (1187).

**Decision: replace with two recursive functions, called from one place each.**

- `setSubtreeCompleted(node, value)` — toggling any node cascades to *all* descendants.
- `recomputeCompletion(tasks)` — bottom-up: a node with children is completed iff all
  children are. Runs once inside `dispatchTasks`, so it's impossible to desync.

Keep the `completed` field on parents (serialization compat, and `countLeaves` /
archive read it) but treat it as derived for any node with children.

---

## 7. Depth limits, glyphs, and folding

**Indentation.** The panel is 400px; today each level costs `ml-6` (24px). Proposal:
24px for level 1, **16px per level beyond that**. Depth 5 then costs 88px, leaving
~250px of text column — tight but readable.

**Decision: hard cap at depth 5.** Tab past it is a no-op with an `[!] max depth`
notice. A cap also bounds recursion in every helper and keeps the ghost/flash key
space small. (If you'd rather have no cap, the only thing that changes is the notice —
everything else already recurses.)

**Tree glyphs.** `├─ / └─` (1786) currently works because there's exactly one level.
At depth n each row needs an ancestry prefix: for every ancestor, `│  ` if that
ancestor has a following sibling, else three spaces — then `├─` or `└─`. `Row.lastChild`
from `flattenVisible` carries what's needed; the prefix is a small pure function.

**Folding — strongly recommended to include in this wave.** Deep trees without folding
make the list unusable, and retrofitting it later means rewriting `flattenVisible`'s
consumers again. Scope: `collapsed?: boolean` on `Task`; `flattenVisible` skips
children of collapsed nodes; a `[ - ]` / `[ + ]` control in the hover pill; collapsed
parents show `·N` descendant count.

> Keyboard binding is an open conflict: `→` is already taken by ghost-autocomplete
> accept (1057), which fires when the caret is at end of input. A fold binding on
> `←`/`→` would need to be conditional on *empty input + node selected*. That's a
> real invariant to get right, not a detail — the alternative is a dedicated key.

---

## 8. Ripples elsewhere

| Area | Change |
|---|---|
| `>` sub-entry chain | `subEntryTarget` becomes a path — `>` on a *selected subtask* now adds a child to it. **This is literally the user request.** The "else last task" fallback becomes "else last top-level task". |
| Delete | Path-based. Deleting a node with descendants should post `[OK] deleted · N descendants · Ctrl+Z restores` rather than vanishing silently. |
| `/clear` | Becomes a tree walk. Pairs naturally with the queued "scoped to completed-only" item. |
| Ball badge | `remainingMain` stays **top-level** count — it answers "how many things left today", not "how many nodes". |
| Progress bar | Already leaf-based via `countLeaves`. No change. |
| Archive `.md` (287) | `'  '.repeat(depth)` via a recursive emitter. **This is the Wave-1 collision:** if write-at-quit ships first, write its emitter recursively from day one and this becomes free. |
| Backlog | Stays **flat**. Promotion lands at top level. Nesting in the backlog is a non-goal. |
| Undo | Already snapshots the whole `tasks` tree, so depth is free. The queued backlog/`dailyTemplates` unification is independent and rides along here. |
| USER_GUIDE / help KEYS+MOUSE tabs | Tab/Shift+Tab wording changes (no more "subs carried along"), fold controls, depth cap. |

---

## 9. Build order (each step independently testable)

1. **Path plumbing, no behaviour change.** Introduce `Sel`, the path helpers,
   `flattenVisible`, and rewrite ↑/↓ against the flat list — while the renderer still
   emits only two levels. Highest-risk step for the focus / window-state invariants;
   feel-test before continuing.
2. **Recursive renderer.** `renderNode(task, path, depth)`; path-based row keys, refs,
   flash and ghost lookups.
3. **Recursive mutations.** move / demote / promote / delete / toggle +
   `recomputeCompletion` inside `dispatchTasks`.
4. **Depth cap, ancestry glyphs, folding.**
5. **Archive emitter, help tabs, USER_GUIDE, About notes.**

Invariants that must survive every step (from PROJECT_SUMMARY): command input keeps
focus; panel `onMouseDown` preventDefault except INPUT; row handlers must not
`stopPropagation`; `Tab` stays unconditionally `preventDefault`ed; the recording block
stays at the top of `handleKeyDown`; `setIsExpanded` only inside
`expandPanel`/`collapsePanel`/`resetToDock`; pending moves cancelled by any mutation.

---

## 10. Open questions

1. **Depth cap at 5, or unlimited?** (Cap is one notice; everything else recurses either way.)
2. **Folding in this wave, or a follow-up?** Recommended in-wave — see §7.
3. If folding is in: **dedicated fold key, or conditional `←`/`→`** given the
   ghost-accept conflict?
4. **Deleting a parent with descendants** — notice-and-undo (recommended), or a
   confirm step?
5. Alt+↑/↓ sibling-only — **confirmed?** (§4)
