# Implementation Spec — Wave 3: three-level nesting (option C)

**Read this before touching code.** Every agent working on this refactor implements against
this contract. Background/rationale live in `DESIGN_nested_subtasks.md` and
`DESIGN_nesting_visual_brief.md`; this file is the binding version and **supersedes them
wherever they disagree** (they were written assuming unlimited depth — that was rejected).

Target file: `terminal-task-widget/src/App.tsx` (everything lives there).

---

## 0. The decision, in one line

**Three levels, hard-capped — implemented with generic depth-agnostic code.** The cap is a
policy constant checked in two places, not an architectural assumption baked into the
shape of the state. Raising it later must be a one-line change.

```ts
const MAX_DEPTH = 3;          // levels, 1-based, for humans
const MAX_DEPTH_INDEX = 2;    // deepest legal path index (path.length - 1)
```

---

## 1. Non-negotiable invariants

These are load-bearing and were each fixed in response to a real bug. Breaking one is a
regression even if the build passes.

1. The command `<input>` keeps keyboard focus at all times. No focusable element may be
   added to the list.
2. Panel `onMouseDown` calls `preventDefault()` for every target except `INPUT`. Row and
   subtask mousedown handlers must **not** `stopPropagation`.
3. `handleKeyDown` unconditionally `preventDefault()`s `Tab`. An unhandled Tab walks focus
   out of the webview, fires window blur, and collapses the panel mid-keystroke.
4. The shortcut-recording block stays at the **top** of `handleKeyDown`, right after the
   help-modal block.
5. `setIsExpanded` is called only inside `expandPanel` / `collapsePanel` / `resetToDock`.
6. `mouseNavEnabled` ref: keyboard nav and reorders set it false; only real pointer motion
   (>2px in `handlePanelMouseMove`) sets it true. `hoverSelect` checks it **before** the
   pending-commit logic.
7. Any list mutation cancels a pending caret-move (`dispatchTasks` guard + explicit cancels).
8. Hover must never cause reflow.
9. Screen geometry goes through `getWorkArea()` / `dockPoint()` / `clampBall()`. Never
   `window.screen` (except inside `getWorkArea`'s own fallback).
10. Ghost overlay outer div must not carry a transform-animating class.

---

## 2. Target types and helpers

```ts
interface Task { id: string; text: string; completed: boolean; subtasks?: Task[]; createdAt?: number }

type Sel =
  | { kind: 'task'; path: number[] }
  | { kind: 'backlog'; index: number }
  | null;
```

`path` is 0-based positional: `[2]` = 3rd top-level task, `[2,0,1]` = its 1st subtask's
2nd child. `path.length - 1` is the depth index.

### Pure helpers (module scope, above `App`)

```ts
const samePath  = (a?: number[] | null, b?: number[] | null) => boolean
const nodeAt    = (tasks: Task[], path: number[]) => Task | null
const siblingsOf= (tasks: Task[], path: number[]) => Task[] | null   // array containing the node
const childrenOf= (t: Task) => Task[]                                // t.subtasks ?? []
const subtreeHeight = (t: Task) => number   // 0 = no children, 1 = children, 2 = grandchildren
const rowKey    = (path: number[]) => `t-${path.join('.')}`          // backlog stays `b-${i}`
```

### Flattened visible list

```ts
type Row =
  | { kind: 'task'; path: number[]; task: Task; depth: number }
  | { kind: 'backlog'; index: number; task: Task };

const flattenVisible = (tasks: Task[], backlog: Task[]): Row[]
```

Depth-first over `tasks` in visual order, then all backlog rows appended. Memoised on
`[tasks, backlog]`. This is the **only** source of truth for ↑/↓ navigation. The renderer
recurses separately (option C needs nested containers) but produces the same order by
construction — both are DFS over the same array.

---

## 3. Visual spec — option C

Ancestry is drawn as a **1px CSS left border on the nested container**, not as box-drawing
characters. `├─` / `└─` are removed. The border survives wrapped rows, which character
rules do not.

### Nesting container

Each level of children is wrapped in:

```
<div class="ml-2 pl-2 border-l border-gray-500/25 space-y-1 mt-1">
```

16px total per level (8px margin + 8px padding), close to the 2ch monospace grid. Compare
to today's `ml-6` (24px) — level 2 gets *more* room than it has now.

### Row markers

Rendered in a `shrink-0` span, separate from the text span, so wrapped continuation lines
align to the text column. This split already exists for subtasks — preserve it at every depth.

| Depth index | Incomplete | Complete | Text color |
|---|---|---|---|
| 0 | `[1]` `[2]` … (1-based ordinal) | `[x]` | `text-[var(--theme-color)]` |
| 1 | `[ ]` | `[x]` | `text-gray-400/80` |
| 2 | `[·]` | `[x]` | `text-gray-400/80` |

Hard two-tone: depth 0 uses the theme color, everything deeper is gray. No per-level opacity
ramp. Completed rows keep `opacity-40 line-through`.

### Selection

- Depth 0: `bg-gray-800/80 shadow-md border-l-2 border-[var(--theme-color)]` (unchanged).
- Depth ≥ 1: `bg-gray-700/50 rounded px-1 -mx-1`, **no left border** — at depth a left
  border either reads as another ancestry rule or detaches from the row.

### Feedback states (unchanged semantics, path-based keys)

- Landing pulse: depth 0 `bg-cyan-950/50 border-l-2 border-cyan-400`; depth ≥1
  `bg-cyan-950/60 rounded px-1 -mx-1`.
- Sub-entry target row: `bg-cyan-950/30 border-l-2 border-cyan-400/70` + the existing hint line.
- Cyan / amber / red keep their meanings. Depth must not be signalled with those colors.

### Ghost preview — keyed on rendered height, not parenthood

At depth, "has children" and "is visually tall" are different questions. Measure the source
row element:

```ts
const el = rowRefs.current.get(rowKey(fromPath));
const tall = (el?.offsetHeight ?? 0) >= 32;
```

`tall` → condensed block style (dashed cyan left border, `⇥ text ·N sub`).
Otherwise → thin dashed insertion rule with the small label chip.
Indent the ghost to match the row's depth (`ml-{depth*4}` equivalent inline style).

### Action pill

Keep the two-stage `[ ⋯ ]` → expanded behaviour. Do **not** replace it with a click menu.
Instead hide actions that are illegal at that position, which naturally shrinks the pill
exactly where space is tightest:

| Button | Shown when |
|---|---|
| `[ ^ ]` `[ v ]` | always |
| `[ x ]` | always |
| `[ + ]` add child | `depth + 1 <= MAX_DEPTH_INDEX` |
| `[ » ]` demote | not first sibling **and** `depth + 1 + subtreeHeight(node) <= MAX_DEPTH_INDEX` |
| `[ « ]` promote | `depth >= 1` |

---

## 4. Depth-cap rules

Depth index is `path.length - 1`; legal range `0 … MAX_DEPTH_INDEX` (= 0…2).

**Demote** (`Tab` / `[ » ]`) — node moves to be the last child of its previous sibling.
Legal iff it has a previous sibling **and** `depth + 1 + subtreeHeight(node) <= MAX_DEPTH_INDEX`.
Illegal → no-op + `postNotice('[!] max depth is 3 levels')`. The subtree moves **intact**;
the old "carry children along as siblings" flattening and its notice are deleted.

**Promote** (`Shift+Tab` / `[ « ]`) — node becomes the next sibling of its parent, subtree
intact. No-op at depth 0.

**Sub-entry** (`>` prefix, `[ + ]`) — target must satisfy `depth + 1 <= MAX_DEPTH_INDEX`.
`subEntryTarget` becomes `number[] | null`. `>` on a *selected subtask* now adds a child to
it (this is the actual user request). Fallback when nothing is selected stays "last
top-level task".

**Load-boundary normalizer** — the only way over-deep data can enter is hand-edited
`state.json` or restored localStorage; both currently load through a bare `JSON.parse` with
zero validation. Add:

```ts
const normalizeTree = (tasks: unknown) => { tasks: Task[]; flattened: number }
```

Applied at every load site (`geek-tasks` initialiser, `geek_backlog`, and the disk-restore
path). It coerces shape, and any node deeper than `MAX_DEPTH_INDEX` is re-parented as a
sibling at depth 2, preserving text and order. If `flattened > 0`, post
`[!] flattened N items deeper than 3 levels` once after mount. Because this runs at the
boundary, **no other function needs a defensive depth check**.

---

## 5. Completion propagation

Replace ad-hoc `syncParentFromSubtasks(tasks, idx)` (3 call sites) and the one-level
cascade with two recursive functions:

```ts
const setSubtreeCompleted = (node: Task, value: boolean) => void   // toggling cascades to ALL descendants
const recomputeCompletion = (tasks: Task[]) => void                // bottom-up: parent completed iff every child is
```

`recomputeCompletion` runs once inside `dispatchTasks`, so parent/child state cannot desync.
`completed` stays on the serialized shape (archive and `countLeaves` read it) but is derived
for any node with children.

---

## 6. Build steps

Each step ends with `npx tsc --noEmit` clean. Do not start the next step until the previous
one type-checks.

**Step 1 — path plumbing + navigation. No visual change; renderer still emits 2 levels.**
Add the §2 helpers. Replace `selectedIndex` / `selectedSubIndex` / `selectedBacklogIndex`
with one `Sel`. Convert `editingNode` to `{ kind, path }` and `subEntryTarget` to
`number[] | null`. Rewrite the `ArrowUp` / `ArrowDown` blocks against `flattenVisible`
(index ± 1, wrapping exactly as today: tasks → backlog → tasks). Update every read of the
old three ints, including render conditionals and `hoverSelect`. *Highest-risk step for the
focus/state invariants.*

**Step 2 — recursive renderer + option C visuals.**
`renderNode(task, path, depth)` replacing the `tasks.map` + inner `subtasks.map`. Nested
containers per §3, markers per the depth table, path-based row keys/refs
(`setRowRef(rowKey(path))`), selection and flash classes by depth. Remove `├─`/`└─`.

**Step 3 — mutations, cap, normalizer, completion.**
`applyMove(parentPath: number[] | 'backlog', from, to)`; `nudgeRow` / `pendingMove` /
`moveSelected` / Alt+wheel carry `parentPath`. Path-based `demoteTask` / `promoteSub` /
delete / toggle per §4. `normalizeTree` at load sites. `setSubtreeCompleted` +
`recomputeCompletion` per §5. Reorder stays **sibling-only** — Alt+↑ on a first child does
not pop it out of its parent.

**Step 4 — ghost by height, pill legality, archive, docs.**
Ghost per §3. Pill per the §3 table. Archive markdown emitter becomes recursive
(`'  '.repeat(depth)`) instead of one hardcoded level. Update the help modal KEYS/MOUSE tabs
and `USER_GUIDE.md`: Tab/Shift+Tab now move subtrees intact (no "subs carried along"), three-level
cap, `>` targets the selected node.

**Out of scope this wave:** folding/collapse, unlimited depth, drag-and-drop (permanently
rejected), any change to backlog structure (stays flat; promotion lands at top level).

---

## 7. Verification checklist

Type-check and build:

```bash
cd <repo-root>/terminal-task-widget && npx tsc --noEmit
```

The mounted filesystem makes `vite build` extremely slow. Build from a copy instead:

```bash
P=<repo-root>/terminal-task-widget
rm -rf /tmp/b && mkdir -p /tmp/b
cp -r $P/src $P/index.html $P/package.json $P/tsconfig*.json $P/vite.config.ts /tmp/b/
ln -s $P/node_modules /tmp/b/node_modules
cd /tmp/b && npx vite build
```

**Sandbox quirk:** the mount has previously truncated `App.tsx` mid-session. Before trusting
a read, `wc -c src/App.tsx` and confirm the file ends with the real EOF (`}` closing the
component). **Always edit the real file with the host file tools (Read/Edit/Write), never
by writing through the sandbox.**

Behaviour checklist (no automated tests exist — these are manual/read-through checks):

- [ ] No `selectedSubIndex` / `selectedBacklogIndex` identifiers remain.
- [ ] No `├─` or `└─` remain in row rendering (the sub-entry hint line may keep its `└─`).
- [ ] Every `setRowRef` / `flashRow` / ghost lookup uses `rowKey(path)`.
- [ ] ↑/↓ visits every visible row exactly once and wraps tasks → backlog → tasks.
- [ ] Tab on a task with grandchildren is a no-op with the max-depth notice.
- [ ] Tab on a task with one level of children moves the subtree intact.
- [ ] Shift+Tab at depth 0 is a no-op.
- [ ] `[ + ]` and `[ » ]` are absent on depth-2 rows.
- [ ] Toggling a parent cascades to all descendants; completing the last leaf marks ancestors.
- [ ] A hand-edited 5-level `state.json` loads clamped to 3 with the flatten notice.
- [ ] All ten §1 invariants still hold.
