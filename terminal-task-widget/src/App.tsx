import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { getCurrentWindow, LogicalSize, LogicalPosition, PhysicalPosition, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import "./App.css";
import { register, unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut';
import { listen } from '@tauri-apps/api/event';
import { writeTextFile, readTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { documentDir, join } from '@tauri-apps/api/path';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';

interface Task {
  id: string;
  text: string;
  completed: boolean;
  subtasks?: Task[];
  createdAt?: number;
}

const ageDays = (ts: number) => Math.floor((Date.now() - ts) / 86400000);

// --- Depth policy ----------------------------------------------------------
// Three levels, hard-capped. This is a POLICY constant checked in exactly two
// places (demote, sub-entry) plus the load-boundary normalizer — never an
// assumption baked into the shape of the state. Raising the cap is a one-line
// change here.
const MAX_DEPTH = 3;        // levels, 1-based, for humans
const MAX_DEPTH_INDEX = 2;  // deepest legal path index (path.length - 1)
const MAX_DEPTH_NOTICE = `[!] max depth is ${MAX_DEPTH} levels`;

// How long after a row's own click a dblclick may still be considered part of
// the same gesture, and therefore allowed to revert that click's toggle.
// Comfortably above the OS double-click interval (typically 400-500ms); past
// it the dblclick opens the editor and leaves history alone.
const DBLCLICK_REVERT_MS = 600;

// --- Path-based selection --------------------------------------------------
// A node is addressed by its 0-based positional path: [2] is the 3rd top-level
// task, [2,0,1] its 1st subtask's 2nd child. `path.length - 1` is the depth
// index. Backlog stays flat, so it keeps a plain index.
type Sel =
  | { kind: 'task'; path: number[] }
  | { kind: 'backlog'; index: number }
  | null;

// One visible row. `flattenVisible` is the ONLY source of truth for ↑/↓ — the
// renderer recurses separately but produces the same order by construction
// (both are depth-first over the same array).
type Row =
  | { kind: 'task'; path: number[]; task: Task; depth: number }
  | { kind: 'backlog'; index: number; task: Task };

// Which sibling array a reorder addresses: the children of a task path
// (`[]` = the top level) or the flat backlog.
type MoveParent = number[] | 'backlog';
type PendingMove = { parentPath: MoveParent; from: number; to: number };

// One undo step, covering ALL THREE user-owned collections at once.
// History used to hold `Task[]` — tasks only — which made undo actively
// destructive rather than merely incomplete: promoting a backlog item removes
// it from `backlog` and appends it to `tasks`, so popping only the task half
// deleted the item outright, with no warning and no way back. Backlog
// reorder/delete/edit and every /daily change were outside history for the same
// reason. A partially-unified history is worse than none — it looks trustworthy
// while silently dropping half of a change — so every mutation of the three
// goes through one dispatch and comes back through one atomic restore.
type Snapshot = { tasks: Task[]; backlog: Task[]; dailyTemplates: string[] };

const samePath = (a?: number[] | null, b?: number[] | null): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const childrenOf = (t: Task): Task[] => t.subtasks ?? [];

// The array that CONTAINS the node at `path` (i.e. its sibling list).
const siblingsOf = (tasks: Task[], path: number[]): Task[] | null => {
  if (path.length === 0) return null;
  let arr: Task[] = tasks;
  for (let i = 0; i < path.length - 1; i++) {
    const node = arr[path[i]];
    if (!node || !node.subtasks) return null;
    arr = node.subtasks;
  }
  return arr;
};

const nodeAt = (tasks: Task[], path: number[]): Task | null => {
  const arr = siblingsOf(tasks, path);
  if (!arr) return null;
  return arr[path[path.length - 1]] ?? null;
};

// Depth-first lookup of a node's CURRENT path by id. Anything that has to
// survive a mutation (the edit target, the sub-entry target) stores the id and
// resolves it here at use time: a positional path does not just go stale when
// its node disappears, it silently re-points at whatever slid into that slot,
// so `edit>` on task 3 would land on task 4 after task 1 was deleted. Node
// vanished == this returns null, which is the only staleness case left.
// Ids are made unique by `normalizeTree` at the load boundary.
const findPathById = (tasks: Task[], id: string): number[] | null => {
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (t.id === id) return [i];
    const below = findPathById(childrenOf(t), id);
    if (below) return [i, ...below];
  }
  return null;
};

// 0 = leaf, 1 = has children, 2 = has grandchildren. The demote legality check
// is its consumer: a node may only sink as deep as the cap minus its own height.
const subtreeHeight = (t: Task): number => {
  const kids = childrenOf(t);
  if (kids.length === 0) return 0;
  let max = 0;
  for (const k of kids) max = Math.max(max, subtreeHeight(k));
  return 1 + max;
};

// Total nodes in a subtree, the node itself included.
const subtreeSize = (t: Task): number =>
  1 + childrenOf(t).reduce((n, k) => n + subtreeSize(k), 0);

// The sibling array UNDER `parentPath` — `[]` addresses the root task list.
// Every path-based mutation splices exactly one of these.
const childArrayOf = (tasks: Task[], parentPath: number[]): Task[] | null =>
  parentPath.length === 0 ? tasks : (nodeAt(tasks, parentPath)?.subtasks ?? null);

const sameParent = (a: MoveParent, b: MoveParent): boolean =>
  a === 'backlog' || b === 'backlog' ? a === b : samePath(a, b);

// Re-address a path across a committed move. A move splices ONE sibling array,
// so any path that runs THROUGH that array shifts with it — including the
// moved node's own path and the paths of everything nested under it. Without
// this, clicking a caret on a deep row immediately after another row's pending
// move lands would nudge whatever slid into that slot (invariant #7).
const shiftPathAfterMove = (path: number[], pm: PendingMove): number[] => {
  if (pm.parentPath === 'backlog' || pm.from === pm.to) return path;
  const p = pm.parentPath;
  if (p.length >= path.length) return path;              // not an ancestor array of `path`
  for (let i = 0; i < p.length; i++) if (p[i] !== path[i]) return path;
  const at = path[p.length];
  let shifted = at;
  if (at === pm.from) shifted = pm.to;
  else if (pm.from < at && pm.to >= at) shifted = at - 1;
  else if (pm.from > at && pm.to <= at) shifted = at + 1;
  if (shifted === at) return path;
  const out = [...path];
  out[p.length] = shifted;
  return out;
};

// Canonical row-ref key: every setRowRef / flashRow / ghost lookup for a task
// row goes through this. Backlog rows stay `b-${index}`.
const rowKey = (path: number[]) => `t-${path.join('.')}`;

// --- Completion propagation (§5) -------------------------------------------
// Toggling a node cascades to EVERY descendant…
const setSubtreeCompleted = (node: Task, value: boolean): void => {
  node.completed = value;
  for (const k of childrenOf(node)) setSubtreeCompleted(k, value);
};

// …and completion is then recomputed bottom-up: a node WITH children is
// completed iff every child is. Leaves keep their own flag. This runs once
// inside dispatchTasks, so parent and child can never desync — which is what
// the old per-call-site syncParentFromSubtasks kept getting wrong.
const recomputeCompletion = (tasks: Task[]): void => {
  for (const t of tasks) {
    const kids = childrenOf(t);
    if (kids.length === 0) continue;
    recomputeCompletion(kids);
    t.completed = kids.every(k => k.completed);
  }
};

// --- Load-boundary normalizer (§4) -----------------------------------------
// The ONLY way over-deep or malformed data can enter is a hand-edited
// state.json or a restored localStorage blob, both of which used to load
// through a bare JSON.parse with zero validation. Everything below the
// boundary may therefore assume a well-formed tree no deeper than
// MAX_DEPTH_INDEX — no other function needs a defensive depth check.
//
// Anything deeper is re-parented as a SIBLING at depth MAX_DEPTH_INDEX,
// preserving text and depth-first order, and counted.
const normalizeTree = (raw: unknown): { tasks: Task[]; flattened: number } => {
  let flattened = 0;
  // Ids anchor the edit / sub-entry targets, so they must be unique across the
  // tree this call produces — a missing OR already-taken id is replaced while
  // we are walking anyway. (A duplicate also collided React's `key={task.id}`.)
  // Each call gets its own set, so the backlog is deduped independently of the
  // task tree, which is what the two separate load sites want.
  const seen = new Set<string>();
  const walk = (input: unknown, depth: number): Task[] => {
    if (!Array.isArray(input)) return [];
    const out: Task[] = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const src = item as Record<string, unknown>;
      const rawId = typeof src.id === 'string' ? src.id : '';
      const id = rawId && !seen.has(rawId) ? rawId : crypto.randomUUID();
      seen.add(id);
      const node: Task = {
        id,
        text: typeof src.text === 'string' ? src.text : String(src.text ?? ''),
        completed: src.completed === true,
        subtasks: [],
      };
      if (typeof src.createdAt === 'number' && isFinite(src.createdAt)) node.createdAt = src.createdAt;
      // Counted once per node that arrived deeper than the cap — the splice
      // below would otherwise double-count whole re-parented subtrees.
      if (depth > MAX_DEPTH_INDEX) flattened++;
      out.push(node);
      const kids = walk(src.subtasks, depth + 1);
      if (kids.length === 0) continue;
      if (depth + 1 <= MAX_DEPTH_INDEX) node.subtasks = kids;
      // Too deep: `kids` is already flat (every level below the cap takes this
      // same branch), so splicing it in keeps document order.
      else out.push(...kids);
    }
    return out;
  };
  const tasks = walk(raw, 0);
  // `completed` is derived for any node with children, so settle it at the
  // boundary too — otherwise a hand-edited file could render a "done" parent
  // over open children until the first mutation happened to fix it.
  recomputeCompletion(tasks);
  return { tasks, flattened };
};

// The backlog is flat by design, so it normalizes to a flat list: any nesting
// a hand-edit introduced is hoisted into the list in document order.
const normalizeFlat = (raw: unknown): Task[] => {
  const out: Task[] = [];
  const walk = (arr: Task[]) => {
    for (const t of arr) {
      const kids = childrenOf(t);
      out.push({ ...t, subtasks: [] });
      walk(kids);
    }
  };
  walk(normalizeTree(raw).tasks);
  return out;
};

// Boot-time load sites run before any hook exists, so the flatten count parks
// here and a mount effect hands it to the deferred announcement below.
let bootFlattenCount = 0;

// The app boots collapsed to a 60x60 ball, so a notice posted at load time
// expires unseen. Park the count in localStorage instead and drain it on the
// first panel open — the same deferral the autostart announcement uses
// (`geek-autostart-announce`), for the same reason.
const FLATTEN_ANNOUNCE_KEY = 'geek-flatten-announce';
const deferFlattenNotice = (n: number) => {
  if (n <= 0) return;
  const prev = Number(localStorage.getItem(FLATTEN_ANNOUNCE_KEY)) || 0;
  localStorage.setItem(FLATTEN_ANNOUNCE_KEY, String(prev + n));
};
const loadTasks = (rawJson: string | null): Task[] => {
  if (!rawJson) return [];
  try {
    const { tasks, flattened } = normalizeTree(JSON.parse(rawJson));
    bootFlattenCount += flattened;
    return tasks;
  } catch {
    return [];
  }
};
const loadBacklog = (rawJson: string | null): Task[] => {
  if (!rawJson) return [];
  try {
    return normalizeFlat(JSON.parse(rawJson));
  } catch {
    return [];
  }
};

const flattenVisible = (tasks: Task[], backlog: Task[]): Row[] => {
  const rows: Row[] = [];
  const walk = (arr: Task[], prefix: number[], depth: number) => {
    arr.forEach((task, i) => {
      const path = [...prefix, i];
      rows.push({ kind: 'task', path, task, depth });
      walk(childrenOf(task), path, depth + 1);
    });
  };
  walk(tasks, [], 0);
  backlog.forEach((task, index) => rows.push({ kind: 'backlog', index, task }));
  return rows;
};

// Sel is now an object, so plain identity is no longer enough to tell "the
// selection did not change". Without this, a mouseenter on the already-selected
// row would allocate a fresh Sel, re-fire the scroll effect, and re-run
// scrollIntoView under a stationary cursor — the exact class of bug the
// mouseNavEnabled guard exists to prevent.
const sameSel = (a: Sel, b: Sel): boolean => {
  if (!a || !b) return a === b;
  if (a.kind === 'backlog' && b.kind === 'backlog') return a.index === b.index;
  if (a.kind === 'task' && b.kind === 'task') return samePath(a.path, b.path);
  return false;
};

const selOfRow = (r: Row): Sel =>
  r.kind === 'backlog' ? { kind: 'backlog', index: r.index } : { kind: 'task', path: r.path };

// --- Id-anchored selection -------------------------------------------------
// `Sel` above is the POSITIONAL form every consumer reads: a path into the
// tree, or a backlog index. It is no longer what is STORED. A stored position
// does not merely go stale when its node moves — it silently re-points at
// whatever slid into that slot, so an undo, a reorder, or the backlog `[ x ]`
// pill could leave the highlight on row 3 while the next keystroke acted on
// the node that used to be there. Same failure mode already fixed for the edit
// and sub-entry targets; this is that same treatment for the selection.
//
// So: state holds an id (`SelRef`), and the positional `Sel` is DERIVED from
// the live tree on every render. Node gone == resolves to null, which is the
// only staleness case left and the one every consumer already handles
// (`rowIndexOf` → −1, `nodeAt` → null, `applyMove` bounds-checks).
// `kind` picks the list the id resolves against: 'backlog' in `backlog`,
// 'task' in the task tree. Ids are unique WITHIN each list (normalizeTree /
// normalizeFlat dedupe per list), never necessarily across the two — which is
// exactly why the kind has to be carried, not inferred.
type SelRef =
  | { kind: 'task'; id: string }
  | { kind: 'backlog'; id: string }
  | null;

const resolveSel = (r: SelRef, tasks: Task[], backlog: Task[]): Sel => {
  if (!r) return null;
  if (r.kind === 'backlog') {
    const index = backlog.findIndex(t => t.id === r.id);
    return index < 0 ? null : { kind: 'backlog', index };
  }
  const path = findPathById(tasks, r.id);
  return path ? { kind: 'task', path } : null;
};

// The inverse, applied at set time — when the caller's position is still valid
// by construction (it was just computed against the tree it is being resolved
// against). Callers that set a selection right after a mutation MUST have
// dispatched first: `dispatch` updates `tasksRef`/`backlogRef` synchronously,
// so the post-mutation path they hand in resolves against the post-mutation
// tree. A position that does not address a node stores as null rather than
// being kept around as a wrong answer.
const selRefOf = (s: Sel, tasks: Task[], backlog: Task[]): SelRef => {
  if (!s) return null;
  if (s.kind === 'backlog') {
    const t = backlog[s.index];
    return t ? { kind: 'backlog', id: t.id } : null;
  }
  const node = nodeAt(tasks, s.path);
  return node ? { kind: 'task', id: node.id } : null;
};

const sameSelRef = (a: SelRef, b: SelRef): boolean =>
  !a || !b ? a === b : a.kind === b.kind && a.id === b.id;

// -1 when nothing is selected OR the selection has gone stale (the row it
// pointed at no longer exists) — callers treat both the same way.
const rowIndexOf = (rows: Row[], s: Sel): number => {
  if (!s) return -1;
  return s.kind === 'backlog'
    ? rows.findIndex(r => r.kind === 'backlog' && r.index === s.index)
    : rows.findIndex(r => r.kind === 'task' && samePath(r.path, s.path));
};

// --- Screen geometry -------------------------------------------------------
// NEVER use window.screen for window placement. Inside the WebView2 host it
// reports the PRIMARY monitor's work area, in CSS px tied to the primary's
// DPI, with no virtual-desktop origin offset. So on an ultrawide, a secondary
// monitor, or a mixed-DPI setup, `availWidth - 60` is not the right edge of
// the monitor the widget is actually on — the ball docked mid-screen and the
// watchdog then "clamped" it against the same wrong rectangle, so it never
// self-corrected. currentMonitor() returns the rect the window really sits on,
// including its origin, and workArea already excludes the taskbar.
// All coordinates below are LOGICAL px (the unit LogicalPosition expects).
type WorkArea = { x: number; y: number; width: number; height: number };

const BALL = 60;

async function getWorkArea(): Promise<WorkArea> {
  try {
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    if (mon) {
      const sf = mon.scaleFactor || 1;
      const { position, size } = mon.workArea;
      return {
        x: position.x / sf,
        y: position.y / sf,
        width: size.width / sf,
        height: size.height / sf,
      };
    }
  } catch (error) {
    console.warn("Monitor query failed; falling back to window.screen:", error);
  }
  // Last resort only — wrong on non-primary/ultrawide, but better than nothing.
  return { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight };
}

// Right edge of the work area, 38.2% down — the canonical dock spot.
const dockPoint = (wa: WorkArea) => ({
  x: Math.round(wa.x + wa.width - BALL),
  y: Math.round(wa.y + wa.height * 0.382),
});

// Keep a BALL-sized window fully inside the work area.
const clampBall = (wa: WorkArea, x: number, y: number) => ({
  x: Math.min(Math.max(wa.x, Math.round(x)), wa.x + wa.width - BALL),
  y: Math.min(Math.max(wa.y, Math.round(y)), wa.y + wa.height - BALL),
});

// Tauri's internal names are verbose ("CommandOrControl+Shift+X"); every
// user-facing surface shows the short form instead.
const displayShortcut = (s: string) => s.replace(/CommandOrControl/g, 'Ctrl');

function normalizeShortcut(key: string): string {
  const parts = key.split('+');
  return parts.map(p => {
    const t = p.trim();
    if (t.length === 1) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }).join('+');
}

let shortcutTaskQueue = Promise.resolve();

const COMMANDS = [
  { cmd: '/deadline', usage: '/deadline <HH:MM|off>', desc: "Today's deadline (one-time, clears at day end)" },
  { cmd: '/theme', usage: '/theme <name|ramp on|ramp off>', desc: 'Colour preset · bare /theme lists them' },
  { cmd: '/l', usage: '/l <Text>', desc: 'Add to backlog (bare /l jumps there)' },
  { cmd: '/clear', usage: '/clear', desc: 'Clear all tasks (Ctrl+Z to undo)' },
  { cmd: '/shortcut', usage: '/shortcut', desc: 'Rebind hotkey (bare Enter = reset Alt+X)' },
  { cmd: '/daily', usage: '/daily <Text>', desc: 'Recurring task, reseeds each day' },
  { cmd: '/log', usage: '/log', desc: 'History, streak & rituals' },
  { cmd: '/export', usage: '/export', desc: 'Export all data to JSON' },
  { cmd: '/startup', usage: '/startup [on|off]', desc: 'Launch at login (on by default)' },
  { cmd: '/help', usage: '/help', desc: 'Open the manual' },
  { cmd: '/about', usage: '/about', desc: 'About this widget' }
];

const STATE_FILE = 'state.json';

// --- What a day's archive is made of ---------------------------------------
// The rollover used to archive `saved.filter(t => t.completed)` — TOP-LEVEL
// completed tasks only. Completion is derived upward, so a parent stays
// incomplete while any child is: finish six subtasks under one unfinished
// parent and the day archived nothing at all. No LOG entry, and
// `exportDailyLog` was never even called, so no `.md` file was written.
//
// The two consumers want different shapes, so build both:
//
// `completedLeaves` — the flat list the LOG tab and weekStats read. They render
// one `[x] text` line per element and use `.length` as the day's score, so
// LEAVES are the honest unit: a completed parent of four counted as 1 before,
// against a progress bar that counts leaves (countLeaves below). Same unit now.
const completedLeaves = (tasks: Task[]): Task[] => {
  const out: Task[] = [];
  const walk = (arr: Task[]) => {
    for (const t of arr) {
      const kids = t.subtasks ?? [];
      if (kids.length > 0) walk(kids);
      else if (t.completed) out.push(t);
    }
  };
  walk(tasks);
  return out;
};

// `completedTree` — the same work with its shape intact, for the markdown
// export, whose emitter is already recursive. Prunes to nodes that are
// completed or have a completed descendant, so a finished child under an
// unfinished parent still appears, nested under it, instead of vanishing.
const completedTree = (tasks: Task[]): Task[] => {
  const out: Task[] = [];
  for (const t of tasks) {
    const kids = completedTree(t.subtasks ?? []);
    if (t.completed || kids.length > 0) out.push({ ...t, subtasks: kids });
  }
  return out;
};

function countLeaves(tasks: Task[]): { total: number; completed: number } {
  let total = 0;
  let completed = 0;
  for (const t of tasks) {
    if (t.subtasks && t.subtasks.length > 0) {
      const child = countLeaves(t.subtasks);
      total += child.total;
      completed += child.completed;
    } else {
      total += 1;
      if (t.completed) completed += 1;
    }
  }
  return { total, completed };
}

function asciiProgress(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `PROG: [${"█".repeat(filled)}${"░".repeat(empty)}] ${percent}%`;
}

// The resting identity color, and the one every no-deadline path must land on.
const THEME_REST = 'hsl(142, 70%, 45%)';

// --- Accent roles (Wave 2 step 1 — PLAN_wave2_themes.md §2) -----------------
// The four semantic accent roles, lifted out of the ~35 hardcoded Tailwind
// classes that used to spell them. NOTHING is themeable yet: these are the
// exact values Tailwind was already emitting, copied out of the built CSS, so
// this step is required to be pixel-identical. Presets land in step 2.
//
// Names are semantic, never chromatic — a preset may legitimately make
// `--accent-action` violet (the `ice` preset does exactly that, because its
// identity hue sits 13° from cyan), and a variable called `--cyan` would then
// be a lie.
//
// Multiple stops per role, not derived: `-wash` is a dark fill BEHIND body
// text while `-soft` is a highlight ON TOP of one, and no color-mix formula
// reproduces Tailwind's stops exactly. A preset supplies all eight.
type Accents = Record<string, string>;

// A ramp is two HSL triples, lerped componentwise across the last 2h. Storing
// components rather than finished color strings is what lets a preset ramp
// between ANY two colors instead of only 142 → 0.
type Ramp = { from: [number, number, number]; to: [number, number, number] };

type Preset = {
  theme: string;      // resting identity, used whenever the ramp is not driving
  ramp: Ramp | null;  // null = this preset never ramps
  accents: Accents;
};

// `default` MUST stay pixel-identical to the pre-theme app — these are the
// exact values Tailwind was emitting, read out of the built CSS. Its `affirm`
// equals its identity hue (142): the one grandfathered contrast violation, kept
// because fidelity beats the rule for the preset nobody opted into. Every OTHER
// preset obeys — each accent ≥40° from the resting identity, ≥30° from the
// other accents.
const PRESETS: Record<string, Preset> = {
  default: {
    theme: THEME_REST,
    ramp: { from: [142, 70, 45], to: [0, 70, 50] },
    accents: {
      '--accent-action':      'oklch(78.9% 0.154 211.53)',   // was cyan-400
      '--accent-action-soft': 'oklch(86.5% 0.127 207.078)',  // was cyan-300
      '--accent-action-deep': 'oklch(71.5% 0.143 215.221)',  // was cyan-500
      '--accent-action-wash': 'oklch(30.2% 0.056 229.695)',  // was cyan-950
      '--accent-edit':        'oklch(85.2% 0.199 91.936)',   // was yellow-400
      '--accent-edit-dim':    'oklch(68.1% 0.162 75.834)',   // was yellow-600
      '--accent-danger':      'oklch(70.4% 0.191 22.216)',   // was red-400
      '--accent-affirm':      'oklch(79.2% 0.209 151.711)',  // was green-400
    },
  },
  // Zero saturation, so the accents carry every bit of the meaning alone.
  // `ramp: null` deliberately — this is the preset for people who do not run
  // deadlines, and a grey identity lurching to red would be incoherent.
  mono: {
    theme: 'hsl(0, 0%, 82%)',
    ramp: null,
    accents: {
      '--accent-action':      'hsl(187, 70%, 55%)',
      '--accent-action-soft': 'hsl(187, 75%, 70%)',
      '--accent-action-deep': 'hsl(187, 70%, 45%)',
      '--accent-action-wash': 'hsl(190, 60%, 14%)',
      '--accent-edit':        'hsl(54, 80%, 55%)',
      '--accent-edit-dim':    'hsl(45, 70%, 45%)',
      '--accent-danger':      'hsl(0, 75%, 65%)',
      '--accent-affirm':      'hsl(142, 60%, 55%)',
    },
  },
  // The preset that justifies per-preset accents at all. Its identity sits at
  // 200°, 13° from the stock cyan action accent — move-feedback would vanish
  // into its own chrome — so action moves to VIOLET here and only here. No
  // single hue knob could have prevented that.
  ice: {
    theme: 'hsl(200, 80%, 60%)',
    ramp: { from: [200, 80, 60], to: [0, 75, 60] },
    accents: {
      '--accent-action':      'hsl(280, 65%, 70%)',
      '--accent-action-soft': 'hsl(280, 70%, 80%)',
      '--accent-action-deep': 'hsl(280, 60%, 60%)',
      '--accent-action-wash': 'hsl(280, 50%, 16%)',
      '--accent-edit':        'hsl(54, 80%, 55%)',
      '--accent-edit-dim':    'hsl(45, 70%, 45%)',
      '--accent-danger':      'hsl(0, 75%, 65%)',
      '--accent-affirm':      'hsl(142, 60%, 55%)',
    },
  },
};

const PRESET_NAMES = Object.keys(PRESETS);
// Unknown name resolves to `default` in silence: someone who downgrades and
// re-upgrades, or hand-edits localStorage, must not meet an error on launch.
const presetOf = (name: string): Preset => PRESETS[name] ?? PRESETS.default;

function useDeadlineColor(deadlineStr: string, preset: Preset, rampOn: boolean) {
  const [color, setColor] = useState(preset.theme);
  // The ramp is identified by its endpoints, not by object identity: PRESETS is
  // module-level and never re-created, but depending on `preset` directly would
  // still re-run this effect on every render if a preset were ever built inline.
  const ramp = rampOn ? preset.ramp : null;
  const rampKey = ramp ? `${ramp.from.join()}|${ramp.to.join()}` : '';
  const rest = preset.theme;

  useEffect(() => {
    // No ramp for this preset, or the user switched it off: the identity color
    // is simply constant. Nothing to tick, so no interval either.
    if (!ramp) { setColor(rest); return; }

    const update = () => {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      // No deadline (the default, and what `/deadline off` produces) used to
      // fall straight through: ''.split(':').map(Number) is [0], so `dm` is
      // undefined, deadlineMinutes is NaN, both comparisons below are false,
      // and the ramp branch emitted `hsl(NaN, 70%, NaN%)` — invalid CSS.
      // Every `var(--theme-color)` then resolved to an invalid value: text fell
      // back to the inherited `:root { color: #00ff00 }` (a harsher neon green
      // that reads as roughly right, which is why this went unnoticed), while
      // the `color-mix()` borders and glows became invalid declarations and
      // were dropped outright — no panel border, no ball glow.
      const [dh, dm] = deadlineStr.split(':').map(Number);
      if (!isFinite(dh) || !isFinite(dm)) { setColor(rest); return; }

      const deadlineMinutes = dh * 60 + dm;
      const startMinutes = deadlineMinutes - 120;
      const [h0, s0, l0] = ramp.from;
      const [h1, s1, l1] = ramp.to;
      const at = (p: number) =>
        `hsl(${Math.round(h0 + (h1 - h0) * p)}, ${Math.round(s0 + (s1 - s0) * p)}%, ${Math.round(l0 + (l1 - l0) * p)}%)`;

      if (nowMinutes >= deadlineMinutes) {
        setColor(at(1));
      } else if (nowMinutes <= startMinutes) {
        // The far end of the ramp, NOT `rest`: a preset may legitimately rest
        // somewhere other than where its ramp begins.
        setColor(at(0));
      } else {
        setColor(at((nowMinutes - startMinutes) / 120));
      }
    };

    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
    // `ramp` is re-derived each render, so it is keyed by value — see rampKey.
  }, [deadlineStr, rampKey, rest]);

  return color;
}

export default function App() {
  // Every load site goes through the normalizer — see normalizeTree.
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks(localStorage.getItem('geek-tasks')));
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState<'keys' | 'mouse' | 'cmds' | 'log' | 'about'>('keys');
  const [dailyTemplates, setDailyTemplates] = useState<string[]>(() => {
    const saved = localStorage.getItem('geek-daily');
    return saved ? JSON.parse(saved) : [];
  });
  const [nowTick, setNowTick] = useState<Date>(() => new Date());
  // Id, not path: the target has to survive deletes and reorders of OTHER rows
  // while the prompt is open (see findPathById). Resolved to a path at use time.
  const [subEntryTarget, setSubEntryTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [deadline, setDeadline] = useState<string>(() => localStorage.getItem('geek-deadline') || '');
  // Presentation only. Neither of these may ever reach `dispatch` — a theme
  // change must not cost an undo step (spec §8.6). Persisted separately so
  // switching preset cannot silently re-enable a ramp the user turned off.
  const [themeName, setThemeName] = useState<string>(() => localStorage.getItem('geek-theme') || 'default');
  const [rampOn, setRampOn] = useState<boolean>(() => localStorage.getItem('geek-ramp') !== 'off');
  const [hotkey, setHotkey] = useState<string>(() => localStorage.getItem('geek-hotkey') || 'Alt+X');
  // null = not yet read, or the platform refused the query (portable exe, locked-down box)
  const [autostartOn, setAutostartOn] = useState<boolean | null>(null);
  // Single selection replacing the old index/subIndex/backlogIndex trio.
  // Stored by id (see SelRef); the positional `sel` every consumer reads is
  // derived from the live tree further down, once the ref mirrors exist.
  const [selRef, setSelRef] = useState<SelRef>(null);
  // Id-anchored for the same reason: `kind` picks which list the id resolves
  // against — 'backlog' resolves in `backlog`, 'task' in the task tree.
  const [editingNode, setEditingNode] = useState<{ kind: 'task' | 'backlog'; id: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Input modality: hover-selection is only honored after REAL mouse motion.
  // Chrome re-dispatches synthetic mouse events when rows scroll under a
  // stationary cursor (e.g. from scrollIntoView), which used to steal the
  // selection back from keyboard navigation on every arrow press.
  const mouseNavEnabled = useRef(true);
  const lastMousePos = useRef({ x: -1, y: -1 });
  const leaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ballPosRef = useRef<PhysicalPosition | null>(null);
  const dragRef = useRef({ x: 0, y: 0, isDragging: false });
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef<'ball' | 'panel'>('ball');
  const [isClosing, setIsClosing] = useState(false);
  const lastToggleTime = useRef<number>(0);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  // Ref mirror for the global-shortcut callback (registered once per hotkey,
  // so its closure would otherwise see a stale value)
  const isRecordingRef = useRef(false);
  const [tempShortcut, setTempShortcut] = useState('');
  const [_archiveLogs, setArchiveLogs] = useState<any[]>(() => {
    const saved = localStorage.getItem('geek-archive');
    return saved ? JSON.parse(saved) : [];
  });
  const [backlog, setBacklog] = useState<Task[]>(() => loadBacklog(localStorage.getItem('geek_backlog')));
  const isFirstRender = useRef(true);
  // Every visible row in visual order — the single source of truth for ↑/↓.
  const rows = useMemo(() => flattenVisible(tasks, backlog), [tasks, backlog]);
  const preset = presetOf(themeName);
  const themeColor = useDeadlineColor(deadline, preset, rampOn);
  isRecordingRef.current = isRecordingShortcut;

  const listRef = useRef<HTMLDivElement>(null);
  const wheelLast = useRef(0);
  // Cyan pulse on a row that was just reordered/added (key: 't-i' / 's-i-j' / 'b-i')
  const [flashRowKey, setFlashRowKey] = useState<string | null>(null);
  const flashRowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Caret "nudge" preview: the real row stays put (so [ ^ ]/[ v ] never move
  // out from under the cursor); a ghost row marks the target slot; the move
  // commits shortly after the last click, on leaving the row, or via Esc-cancel.
  // A move always addresses ONE sibling array: the children of `parentPath`
  // ([] = the top level), or the flat backlog. Reorder is sibling-only by
  // construction — nothing here can move a node across parents.
  const [pendingMove, setPendingMove] = useState<{ parentPath: MoveParent; from: number; to: number } | null>(null);
  const pendingRef = useRef<typeof pendingMove>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef<() => void>(() => {});
  const cancelPendingMove = () => {
    pendingRef.current = null;
    setPendingMove(null);
    if (pendingTimer.current) { clearTimeout(pendingTimer.current); pendingTimer.current = null; }
  };

  // The tree as of the LAST dispatch, not the last render. Two clicks inside
  // one tick (caret commit → caret nudge) would otherwise both read the stale
  // render closure and address rows by pre-splice paths — invariant #7.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // Same contract for the other two collections a single user action can touch:
  // one action may dispatch twice in a tick (promote = backlog + tasks), and the
  // second read must not see the pre-dispatch render closure.
  const backlogRef = useRef(backlog);
  backlogRef.current = backlog;
  const dailyRef = useRef(dailyTemplates);
  dailyRef.current = dailyTemplates;

  // The positional selection, re-derived from the live tree every render, so a
  // mutation anywhere re-addresses it instead of leaving it on a slot that now
  // belongs to someone else. Everything downstream still reads `sel.path` /
  // `sel.index` exactly as before — only the storage changed.
  //
  // Identity is deliberately stabilised: a fresh object on every task mutation
  // would re-fire the scroll effect below and call scrollIntoView under a
  // stationary cursor on every commit — the class of bug `mouseNavEnabled`
  // exists to prevent. Same node in the same place == same object.
  const selCache = useRef<Sel>(null);
  const sel = useMemo(() => {
    const next = resolveSel(selRef, tasks, backlog);
    if (sameSel(selCache.current, next)) return selCache.current;
    selCache.current = next;
    return next;
  }, [selRef, tasks, backlog]);

  // Positional in, id out. Accepts the updater form, whose `prev` is resolved
  // through the ref mirrors so a setter running after a same-tick dispatch sees
  // the post-dispatch world (invariant #7's contract, applied to selection).
  // Returning the previous ref unchanged when nothing moved keeps `setSel(prev
  // => same)` a true no-op — hoverSelect leans on that.
  const setSel = useCallback((next: Sel | ((prev: Sel) => Sel)) => {
    setSelRef(prev => {
      const t = tasksRef.current;
      const b = backlogRef.current;
      const value = typeof next === 'function' ? next(resolveSel(prev, t, b)) : next;
      const nextRef = selRefOf(value, t, b);
      return sameSelRef(prev, nextRef) ? prev : nextRef;
    });
  }, []);

  // The last completion toggle made by a mouse click, so the dblclick that may
  // follow it can undo exactly that toggle and nothing else. `snapshot` is the
  // very history entry the toggle pushed — matching it by reference is what
  // makes "this dblclick's own toggle" provable rather than assumed.
  const lastToggleRef = useRef<{ id: string; ts: number; snapshot: Snapshot } | null>(null);

  // THE mutation funnel. Every change to `tasks`, `backlog` or `dailyTemplates`
  // goes through here, and a change that spans two of them (promoting a backlog
  // item) passes both in ONE call — so it costs exactly one undo step and comes
  // back whole instead of being half-restored into oblivion.
  //
  // Returns the undo snapshot it pushed, so a caller that may need to take its
  // own mutation back (the double-click revert) can identify *its* history
  // entry by reference instead of trusting the top of the stack blindly.
  const dispatch = (next: { tasks?: Task[]; backlog?: Task[]; daily?: string[] }): Snapshot => {
    // Any list mutation invalidates a pending caret-move's indices — abort it
    // rather than let the delayed commit move the wrong row (invariant #7).
    // (During a commit itself pendingRef is already null, so this is a no-op
    // there.) This now covers the backlog too, which is why `/l <text>` and the
    // backlog text-edit no longer need their own cancel.
    if (pendingRef.current) cancelPendingMove();
    // Snapshot eagerly and DEEPLY, before any mutation: recomputeCompletion
    // mutates in place, and callers that pass a shallow copy ([...tasks, x])
    // share nodes with the live tree, so a lazy snapshot would record the
    // post-mutation state and undo would restore nothing.
    const snapshot: Snapshot = {
      tasks: JSON.parse(JSON.stringify(tasksRef.current)),
      backlog: JSON.parse(JSON.stringify(backlogRef.current)),
      dailyTemplates: [...dailyRef.current],
    };
    setHistory(prev => [...prev, snapshot].slice(-20));
    if (next.tasks) {
      recomputeCompletion(next.tasks);
      tasksRef.current = next.tasks;
      setTasks(next.tasks);
    }
    if (next.backlog) {
      backlogRef.current = next.backlog;
      setBacklog(next.backlog);
    }
    if (next.daily) {
      dailyRef.current = next.daily;
      setDailyTemplates(next.daily);
    }
    return snapshot;
  };

  const dispatchTasks = (newTasks: Task[]): Snapshot => dispatch({ tasks: newTasks });

  // The other half of the contract: an undo restores all three collections
  // together, or it is a lie. Never touches history itself — the caller pops.
  // Snapshots are deep clones that are removed from the stack as they are
  // restored, so handing their arrays straight to state leaves no aliasing.
  const restoreSnapshot = (s: Snapshot) => {
    cancelPendingMove();          // its indices belong to the lists being undone
    tasksRef.current = s.tasks;
    backlogRef.current = s.backlog;
    dailyRef.current = s.dailyTemplates;
    setTasks(s.tasks);
    setBacklog(s.backlog);
    setDailyTemplates(s.dailyTemplates);
  };

  // Day rollover and disk restore are NOT user actions, and their history must
  // not be undoable: Ctrl+Z after a rollover would resurrect yesterday's
  // completed tasks on top of today's list, and after a restore it would revert
  // the restore. Both clear the stack instead of pushing to it.
  const resetHistory = () => { setHistory([]); lastToggleRef.current = null; };

  const postNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3000);
  };

  const statePayload = () => ({
    version: 1,
    savedAt: new Date().toISOString(),
    tasks,
    backlog,
    archive: _archiveLogs,
    deadline,
    hotkey,
    daily: dailyTemplates,
    lastDate: localStorage.getItem('geek-last-date') || '',
  });

  const ensureLogFolder = async () => {
    const docPath = await documentDir();
    const folderPath = await join(docPath, 'TerminalTasks');
    if (!(await exists(folderPath))) await mkdir(folderPath, { recursive: true });
    return folderPath;
  };

  const writeStateFile = async () => {
    try {
      const folderPath = await ensureLogFolder();
      const filePath = await join(folderPath, STATE_FILE);
      await writeTextFile(filePath, JSON.stringify(statePayload()));
    } catch (error) {
      console.error("State mirror failed:", error);
    }
  };

  const exportDailyLog = async (dateStr: string, tasksToExport: Task[], backlogTasks: Task[]) => {
    try {
      const docPath = await documentDir();
      const folderPath = await join(docPath, 'TerminalTasks');
      const folderExists = await exists(folderPath);
      if (!folderExists) await mkdir(folderPath, { recursive: true });

      const dateObj = new Date(dateStr);
      const fileName = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}.md`;
      const filePath = await join(folderPath, fileName);

      let mdContent = `# Terminal Task Log - ${dateStr}\n\n`;
      // Recursive: two spaces per level, so every depth the tree can hold
      // round-trips as valid nested Markdown. (It used to hardcode one level,
      // which silently dropped grandchildren.)
      const emitNodes = (nodes: Task[], depth: number) => {
        for (const t of nodes) {
          mdContent += `${'  '.repeat(depth)}- [${t.completed ? 'x' : ' '}] ${t.text}\n`;
          emitNodes(childrenOf(t), depth + 1);
        }
      };
      emitNodes(tasksToExport, 0);
      mdContent += `\n> *Automatically archived by Terminal Task at ${new Date().toLocaleTimeString()}*\n`;
      if (backlogTasks.length > 0) {
        mdContent += `> *Backlog items pending: ${backlogTasks.length}*\n`;
      }

      await writeTextFile(filePath, mdContent);
    } catch (error) {
      console.error("Markdown write failed:", error);
    }
  };

  const expandPanel = async () => {
    // Cancel any pending collapse — this kills the race where a stale
    // collapse timer shrank the window right after an expand.
    if (leaveTimeout.current) { clearTimeout(leaveTimeout.current); leaveTimeout.current = null; }
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    if (focusTimerRef.current) { clearTimeout(focusTimerRef.current); focusTimerRef.current = null; }
    setIsClosing(false);
    if (modeRef.current === 'panel') {
      // Already open — just re-focus instead of re-running the resize dance
      try {
        const w = getCurrentWindow();
        await w.show();
        await w.setFocus();
      } catch { /* focus is best-effort */ }
      inputRef.current?.focus();
      return;
    }

    const appWindow = getCurrentWindow();
    const targetWidth = 400;
    const targetHeight = 600;

    try {
      // Only capture the ball anchor while actually in ball mode,
      // so we never "remember" a panel position as the ball position.
      ballPosRef.current = await appWindow.outerPosition();

      const scaleFactor = await appWindow.scaleFactor();
      const logicalPos = ballPosRef.current!.toLogical(scaleFactor);

      const wa = await getWorkArea();
      const right = wa.x + wa.width;
      const bottom = wa.y + wa.height;

      let newX = logicalPos.x;
      let newY = logicalPos.y;

      if (logicalPos.x + targetWidth > right) {
        newX = Math.max(wa.x, right - targetWidth - 20);
      }
      if (logicalPos.y + targetHeight > bottom) {
        newY = Math.max(wa.y, bottom - targetHeight - 20);
      }

      await appWindow.setPosition(new LogicalPosition(newX, newY));
    } catch (error) {
      console.error("Smart positioning failed:", error);
    }

    modeRef.current = 'panel';
    try {
      await appWindow.setSize(new LogicalSize(targetWidth, targetHeight));
      await appWindow.show();
      await appWindow.setFocus();
    } catch (error) {
      console.warn("OS focus IPC interrupted, but continuing...", error);
    }
    setIsExpanded(true);
    focusTimerRef.current = setTimeout(() => inputRef.current?.focus(), 120);
  };

  const collapsePanel = () => {
    if (modeRef.current !== 'panel') return;      // nothing to collapse
    if (collapseTimer.current) return;             // already closing
    commitRef.current();                           // land any pending caret move
    if (leaveTimeout.current) { clearTimeout(leaveTimeout.current); leaveTimeout.current = null; }

    setIsClosing(true);                            // play exit animation first
    inputRef.current?.blur();

    collapseTimer.current = setTimeout(async () => {
      collapseTimer.current = null;
      modeRef.current = 'ball';
      setIsExpanded(false);
      setIsClosing(false);
      setSel(null);
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setSize(new LogicalSize(60, 60));
        if (ballPosRef.current) {
          // Clamp the restored position on-screen so the ball can never
          // land off-screen after a resolution / monitor change.
          const scaleFactor = await appWindow.scaleFactor();
          const lp = ballPosRef.current.toLogical(scaleFactor);
          const { x, y } = clampBall(await getWorkArea(), lp.x, lp.y);
          await appWindow.setPosition(new LogicalPosition(x, y));
        }
        await appWindow.show();                    // ball must always stay visible
      } catch (error) {
        console.error("Collapse failed:", error);
      }
    }, 150); // matches .animate-panel-out duration
  };

  const resetToDock = async () => {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    if (leaveTimeout.current) { clearTimeout(leaveTimeout.current); leaveTimeout.current = null; }
    modeRef.current = 'ball';
    setIsExpanded(false);
    setIsClosing(false);
    ballPosRef.current = null;
    try {
      const appWindow = getCurrentWindow();
      const dock = dockPoint(await getWorkArea());
      await appWindow.setSize(new LogicalSize(BALL, BALL));
      await appWindow.setPosition(new LogicalPosition(dock.x, dock.y));
      await appWindow.show();
    } catch (error) {
      console.error("Reset failed:", error);
    }
  };

  const handleMouseEnter = () => {
    if (leaveTimeout.current) {
      clearTimeout(leaveTimeout.current);
      leaveTimeout.current = null;
    }
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
  };

  const handleMouseLeave = () => {
    if (isTyping) return;
    leaveTimeout.current = setTimeout(collapsePanel, 300);
  };

  const handleBallPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, isDragging: false };
  };

  const handleBallPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current.isDragging) return;
    const dx = Math.abs(e.clientX - dragRef.current.x);
    const dy = Math.abs(e.clientY - dragRef.current.y);
    if (dx > 5 || dy > 5) {
      dragRef.current.isDragging = true;
      getCurrentWindow().startDragging();
    }
  };

  const handleBallPointerUp = () => {
    const wasDragging = dragRef.current.isDragging;
    dragRef.current.isDragging = false; // reset — a stale true blocks the watchdog
    if (!wasDragging) {
      expandPanel();
    }
  };

  // Watchdog: after standby/wake or monitor changes, Windows can strand the
  // collapsed ball off-screen (or a resize can half-apply). Periodically and
  // on visibility/focus resume, clamp it back into the work area and re-show.
  const ensureBallVisible = async () => {
    if (modeRef.current !== 'ball' || collapseTimer.current || dragRef.current.isDragging) return;
    try {
      const appWindow = getCurrentWindow();
      const scaleFactor = await appWindow.scaleFactor();
      const pos = (await appWindow.outerPosition()).toLogical(scaleFactor);
      const { x, y } = clampBall(await getWorkArea(), pos.x, pos.y);
      if (Math.abs(x - pos.x) > 1 || Math.abs(y - pos.y) > 1) {
        await appWindow.setPosition(new LogicalPosition(x, y));
        ballPosRef.current = null; // old anchor is stale after an OS move
      }
      const size = (await appWindow.innerSize()).toLogical(scaleFactor);
      if (Math.round(size.width) !== BALL || Math.round(size.height) !== BALL) {
        await appWindow.setSize(new LogicalSize(BALL, BALL));
      }
      await appWindow.show();
    } catch (error) {
      console.warn("Ball watchdog failed:", error);
    }
  };

  useEffect(() => {
    const init = async () => {
      const appWindow = getCurrentWindow();
      try {
        const dock = dockPoint(await getWorkArea());
        await appWindow.setSize(new LogicalSize(BALL, BALL));
        await appWindow.setPosition(new LogicalPosition(dock.x, dock.y));
      } finally {
        // Window starts hidden (tauri.conf.json) to avoid the 400px startup
        // flash; always reveal it once docked, even if positioning failed.
        await appWindow.show();
      }
    };
    init();
  }, []);

  // Autostart defaults to ON, but only on a genuine first run of a release
  // build. Three guards, each protecting against a different failure:
  //   1. `geek-autostart-init` — once-only. Without it we would re-enable on
  //      every boot and silently overwrite a user who turned it off.
  //   2. PROD only — in `tauri dev` the plugin registers `current_exe()`,
  //      i.e. the target/debug binary, leaving a stale Run-key path behind.
  //   3. Returning users predate the flag, so their existing choice wins;
  //      presence of task data is the tell that this isn't a first run.
  useEffect(() => {
    (async () => {
      try {
        let on = await isAutostartEnabled();
        if (import.meta.env.PROD && !localStorage.getItem('geek-autostart-init')) {
          const returning = !!localStorage.getItem('geek-tasks') || !!localStorage.getItem('geek-last-date');
          if (!returning && !on) {
            await enableAutostart();
            on = true;
            // The app boots collapsed to the ball, so a notice posted now
            // would expire unseen. Defer it to the first panel open — the
            // flag is in localStorage, so it survives until then.
            localStorage.setItem('geek-autostart-announce', '1');
          }
          localStorage.setItem('geek-autostart-init', '1');
        }
        setAutostartOn(on);
      } catch (error) {
        console.warn("Autostart unavailable:", error);
        setAutostartOn(null);
      }
    })();
  }, []);

  // Deferred first-run announcement — writing ourselves into the Run key
  // should never be something the user only discovers later.
  useEffect(() => {
    if (!isExpanded) return;
    if (!localStorage.getItem('geek-autostart-announce')) return;
    localStorage.removeItem('geek-autostart-announce');
    postNotice('[OK] launch at login: ON · /startup off to disable');
  }, [isExpanded]);

  useEffect(() => {
    const preventAltMenu = (e: KeyboardEvent) => {
      if (e.key === 'Alt') e.preventDefault();
    };
    window.addEventListener('keydown', preventAltMenu, { capture: true });
    window.addEventListener('keyup', preventAltMenu, { capture: true });
    return () => {
      window.removeEventListener('keydown', preventAltMenu, { capture: true });
      window.removeEventListener('keyup', preventAltMenu, { capture: true });
    };
  }, []);

  useEffect(() => {
    const handleBlur = () => collapsePanel();
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  // Standby/wake recovery: intervals freeze during standby but resume on wake,
  // so the 45s tick self-heals shortly after resume; visibility/focus events
  // give an immediate check the moment the webview comes back.
  useEffect(() => {
    const id = setInterval(() => { ensureBallVisible(); }, 45000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') ensureBallVisible();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Tray menu → frontend bridge
  useEffect(() => {
    const subs = [
      listen('tray:open', () => { expandPanel(); }),
      listen('tray:hide', () => { collapsePanel(); }),
      listen('tray:toggle', () => {
        if (modeRef.current === 'panel') collapsePanel(); else expandPanel();
      }),
      listen('tray:reset', () => { resetToDock(); }),
    ];
    return () => { subs.forEach(p => p.then(un => un())); };
  }, []);

  useEffect(() => {
    const runDayCheck = () => {
      const todayStr = new Date().toDateString();
      const lastActiveDate = localStorage.getItem('geek-last-date');

      if (lastActiveDate && lastActiveDate !== todayStr) {
        // Another load site: the rollover re-reads localStorage directly.
        const saved = normalizeTree(JSON.parse(localStorage.getItem('geek-tasks') || '[]')).tasks;
        const savedBacklog = normalizeFlat(JSON.parse(localStorage.getItem('geek_backlog') || '[]'));

        // Leaves for the archive entry (flat, what LOG renders and counts),
        // the pruned tree for the markdown (hierarchy, recursive emitter).
        // Gate on the leaves: they are what "did anything get done today"
        // actually means. See completedLeaves / completedTree.
        const doneLeaves = completedLeaves(saved);
        if (doneLeaves.length > 0) {
          const existing = JSON.parse(localStorage.getItem('geek-archive') || '[]');
          // Replace an entry for this date rather than appending a second one.
          // The LOG tab and weekStats both iterate ENTRIES, not dates, so a
          // duplicate showed the day twice and double-counted it in the 7-day
          // total. Reachable whenever `geek-last-date` goes backwards — the
          // disaster-recovery restore rewrites it from the disk mirror.
          const entry = { date: lastActiveDate, tasks: doneLeaves };
          const at = existing.findIndex((e: any) => e?.date === lastActiveDate);
          const newArchive = at >= 0
            ? existing.map((e: any, i: number) => (i === at ? entry : e))
            : [...existing, entry];
          setArchiveLogs(newArchive);
          localStorage.setItem('geek-archive', JSON.stringify(newArchive));
          exportDailyLog(lastActiveDate, completedTree(saved), savedBacklog);
        }

        // Carry over what is still open, at every depth (completion is derived,
        // so an incomplete node always has an incomplete descendant to keep).
        const carryOver = (arr: Task[]): Task[] =>
          arr.filter(t => !t.completed).map(t => ({ ...t, subtasks: carryOver(childrenOf(t)) }));
        const remaining = carryOver(saved);

        // Reseed daily rituals for the new day (skip ones already carried over)
        const templates: string[] = JSON.parse(localStorage.getItem('geek-daily') || '[]');
        const reseeded = templates
          .filter(t => !remaining.some((r: Task) => r.text === t))
          .map(t => ({ id: crypto.randomUUID(), text: t, completed: false, subtasks: [] }));

        // NOT a dispatch: the rollover is the clock's doing, not the user's, and
        // an undo step over it would restore yesterday's completed tasks over
        // today's list (and re-arm an archive that has already been written).
        const rolled = [...remaining, ...reseeded];
        // Invariant #7 still applies even though this bypasses dispatch: a caret
        // preview armed before the rollover would commit against a list that no
        // longer exists and silently reorder the wrong rows.
        cancelPendingMove();
        tasksRef.current = rolled;
        setTasks(rolled);
        resetHistory();
        setDeadline('');
        localStorage.removeItem('geek-deadline');
      }

      localStorage.setItem('geek-last-date', todayStr);
    };

    // 挂载时检测
    runDayCheck();

    // 窗口重新获得焦点也检测（兜底 Tauri 生产包的 webview 生命周期差异）
    window.addEventListener('focus', runDayCheck);
    const onVisible = () => { if (document.visibilityState === 'visible') runDayCheck(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', runDayCheck);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Disaster recovery: if the WebView cache was wiped (localStorage empty)
  // but a disk mirror exists, restore everything from it.
  useEffect(() => {
    const hasLocal = localStorage.getItem('geek-tasks') !== null
      || localStorage.getItem('geek_backlog') !== null;
    if (hasLocal) return;
    (async () => {
      try {
        const docPath = await documentDir();
        const filePath = await join(docPath, 'TerminalTasks', STATE_FILE);
        if (!(await exists(filePath))) return;
        const s = JSON.parse(await readTextFile(filePath));
        // Hand-edited state.json is the main way over-deep data can appear —
        // normalize before it ever reaches the tree.
        const restored = normalizeTree(s.tasks);
        // Also not a dispatch, for the same reason: Ctrl+Z must never revert a
        // disaster recovery back to the empty state it recovered from.
        // Same invariant-#7 reasoning as the rollover above.
        cancelPendingMove();
        if (Array.isArray(s.tasks)) { tasksRef.current = restored.tasks; setTasks(restored.tasks); }
        if (Array.isArray(s.backlog)) {
          const b = normalizeFlat(s.backlog);
          backlogRef.current = b;
          setBacklog(b);
        }
        if (Array.isArray(s.archive)) setArchiveLogs(s.archive);
        if (typeof s.deadline === 'string') setDeadline(s.deadline);
        if (typeof s.hotkey === 'string' && s.hotkey) setHotkey(s.hotkey);
        if (Array.isArray(s.daily)) { dailyRef.current = s.daily; setDailyTemplates(s.daily); }
        resetHistory();
        if (typeof s.lastDate === 'string' && s.lastDate) localStorage.setItem('geek-last-date', s.lastDate);
        // The clamp warning is deferred to the first panel open; the restore
        // confirmation is not worth carrying across a session.
        deferFlattenNotice(restored.flattened);
        postNotice('[OK] state restored from disk');
      } catch (error) {
        console.error("Disk restore failed:", error);
      }
    })();
  }, []);

  // Hand everything the boot-time load sites had to clamp to the deferred
  // announcement. Must run before the drain effect below, so that a session
  // which somehow boots already expanded still shows it on this same commit.
  useEffect(() => {
    if (bootFlattenCount <= 0) return;
    deferFlattenNotice(bootFlattenCount);
    bootFlattenCount = 0;
  }, []);

  // One notice for every clamp any load site made, on the first panel open.
  useEffect(() => {
    if (!isExpanded) return;
    const n = Number(localStorage.getItem(FLATTEN_ANNOUNCE_KEY)) || 0;
    if (n <= 0) return;
    localStorage.removeItem(FLATTEN_ANNOUNCE_KEY);
    postNotice(`[!] flattened ${n} items deeper than ${MAX_DEPTH} levels`);
  }, [isExpanded]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    localStorage.setItem('geek-tasks', JSON.stringify(tasks));
    localStorage.setItem('geek-hotkey', hotkey);
    localStorage.setItem('geek-deadline', deadline);
    localStorage.setItem('geek-theme', themeName);
    // Only written when OFF, so absent means on — a fresh profile keeps the ramp.
    if (rampOn) localStorage.removeItem('geek-ramp'); else localStorage.setItem('geek-ramp', 'off');
    localStorage.setItem('geek-archive', JSON.stringify(_archiveLogs));
    localStorage.setItem('geek_backlog', JSON.stringify(backlog));
    localStorage.setItem('geek-daily', JSON.stringify(dailyTemplates));
    // Debounced disk mirror — localStorage alone dies with the WebView cache
    if (stateSaveTimer.current) clearTimeout(stateSaveTimer.current);
    stateSaveTimer.current = setTimeout(() => { writeStateFile(); }, 800);
  }, [tasks, hotkey, deadline, _archiveLogs, backlog, dailyTemplates, themeName, rampOn]);

  // Minute tick for the deadline countdown
  useEffect(() => {
    const id = setInterval(() => setNowTick(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const normalizedKey = normalizeShortcut(hotkey);

    shortcutTaskQueue = shortcutTaskQueue.then(async () => {
      if (!isMounted) return;
      try {
        const registered = await isRegistered(normalizedKey);
        if (registered) await unregister(normalizedKey);
        if (!isMounted) return;
        await register(normalizedKey, (event) => {
          if (event.state === 'Pressed') {
            // While the recorder is open, pressing the CURRENT hotkey must be
            // captured as input, not toggle the panel out from under the user.
            if (isRecordingRef.current) return;
            const now = Date.now();
            if (now - lastToggleTime.current < 300) return;
            lastToggleTime.current = now;
            if (modeRef.current === 'panel') collapsePanel(); else expandPanel();
          }
        });
      } catch (e) {
        console.warn("Shortcut setup interrupted:", e);
        // Most common cause: the combo is already claimed by another app
        postNotice(`[ERR] ${displayShortcut(normalizedKey)} failed to register — try /shortcut`);
      }
    });

    return () => {
      isMounted = false;
      shortcutTaskQueue = shortcutTaskQueue.then(async () => {
        try {
          const registered = await isRegistered(normalizedKey);
          if (registered) await unregister(normalizedKey);
        } catch (e) {}
      });
    };
  }, [hotkey]);

  // Keep the keyboard-selected row visible inside the scroll area
  useEffect(() => {
    let key: string | null = null;
    if (sel?.kind === 'backlog') key = `b-${sel.index}`;
    else if (sel?.kind === 'task') key = rowKey(sel.path);
    if (key) rowRefs.current.get(key)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  // Where the id-anchored targets currently live. Re-resolved every render, so
  // a delete or reorder elsewhere in the list re-addresses them instead of
  // leaving them pointing at whatever moved into the old slot. null = the node
  // is really gone, which the effects below turn into "close the prompt".
  const subEntryPath = subEntryTarget === null ? null : findPathById(tasks, subEntryTarget);

  // Drop subtask-entry mode if its target node no longer exists. NOT "on any
  // mutation": Enter chaining adds a child on every keystroke-commit, and each
  // of those is a mutation the target is expected to survive.
  useEffect(() => {
    if (subEntryTarget !== null && !findPathById(tasks, subEntryTarget)) setSubEntryTarget(null);
  }, [tasks, subEntryTarget]);

  // Same for the edit prompt, which previously had no guard at all: deleting
  // the row being edited left `edit>` open over a dead target.
  useEffect(() => {
    if (!editingNode) return;
    const alive = editingNode.kind === 'backlog'
      ? backlog.some(t => t.id === editingNode.id)
      : !!findPathById(tasks, editingNode.id);
    // The buffer holds the dead node's text; committing it would silently
    // resurrect it as a brand-new task, so close the prompt cleanly.
    if (!alive) { setEditingNode(null); setInputValue(''); }
  }, [tasks, backlog, editingNode]);

  const setRowRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(key, el); else rowRefs.current.delete(key);
  };

  // Re-enable hover-selection only on genuine pointer motion (synthetic
  // post-scroll mousemoves carry unchanged coordinates and are ignored).
  const handlePanelMouseMove = (e: React.MouseEvent) => {
    const dx = Math.abs(e.clientX - lastMousePos.current.x);
    const dy = Math.abs(e.clientY - lastMousePos.current.y);
    if (dx > 2 || dy > 2) {
      mouseNavEnabled.current = true;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const hoverSelect = (next: Sel) => {
    // Modality guard FIRST: synthetic mouseenters (layout/scroll under a
    // stationary cursor) must never commit a pending caret-move preview.
    if (!mouseNavEnabled.current) return;
    // Really moving onto a different row lands any open preview
    const pm = pendingRef.current;
    if (pm) {
      const onSource = pm.parentPath === 'backlog'
        ? next?.kind === 'backlog' && next.index === pm.from
        : next?.kind === 'task' && samePath(next.path, [...pm.parentPath, pm.from]);
      if (!onSource) commitRef.current();
    }
    setSel(prev => (sameSel(prev, next) ? prev : next));
  };

  const { total, completed } = countLeaves(tasks);
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  // Ball badge counts MAIN tasks (headline items); the progress bar keeps
  // leaf-level granularity so subtask ticks still move PROG.
  const remainingMain = tasks.filter(t => !t.completed).length;

  // "T-1h24m" countdown to the daily deadline (ticks every 30s)
  const countdown = (() => {
    if (!deadline) return '';
    const [dh, dm] = deadline.split(':').map(Number);
    const mins = dh * 60 + dm - (nowTick.getHours() * 60 + nowTick.getMinutes());
    const abs = Math.abs(mins);
    const fmt = abs >= 60 ? `${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}m` : `${abs}m`;
    return mins >= 0 ? `T-${fmt}` : `T+${fmt}`;
  })();

  // Consecutive days with at least one completed task (today counts live)
  const streak = (() => {
    const days = new Set(
      _archiveLogs
        .filter((l: any) => Array.isArray(l.tasks) && l.tasks.length > 0)
        .map((l: any) => new Date(l.date).toDateString())
    );
    let s = completed > 0 ? 1 : 0;
    const d = new Date();
    d.setDate(d.getDate() - 1);
    while (days.has(d.toDateString())) {
      s++;
      d.setDate(d.getDate() - 1);
    }
    return s;
  })();

  const recentLogs = [..._archiveLogs].slice(-14).reverse();

  // Morning surfacing: once per day, offer the OLDEST backlog item that has
  // sat for ≥7 days (fresh items don't need a nudge; items with no timestamp
  // predate the createdAt field and count as old). Zero background cost —
  // pure render math + one localStorage key; the "skipped" marker naturally
  // expires when the date string changes.
  const todayKey = nowTick.toDateString();
  const [surfaceSkip, setSurfaceSkip] = useState<string>(() => localStorage.getItem('geek-surface-skip') || '');
  const surfaceIdx = (() => {
    let idx = -1, best = Infinity;
    backlog.forEach((t, i) => {
      const eligible = t.createdAt === undefined || ageDays(t.createdAt) >= 7;
      if (!eligible) return;
      const c = t.createdAt ?? 0; // no timestamp = oldest
      if (c < best) { best = c; idx = i; }
    });
    return idx;
  })();
  const showSurface = surfaceIdx >= 0 && surfaceSkip !== todayKey;
  const skipSurface = () => {
    setSurfaceSkip(todayKey);
    localStorage.setItem('geek-surface-skip', todayKey);
  };

  // Rolling 7-day summary from the archive (excludes today, which is live)
  const weekStats = (() => {
    const dayMs = 86400000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let done = 0, days = 0, bestN = 0, bestDay = '';
    for (const l of _archiveLogs as any[]) {
      const d = new Date(l.date);
      if (isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);
      const diff = (today.getTime() - d.getTime()) / dayMs;
      if (diff < 1 || diff > 7) continue;
      const n = Array.isArray(l.tasks) ? l.tasks.length : 0;
      if (n === 0) continue;
      done += n;
      days++;
      if (n > bestN) {
        bestN = n;
        bestDay = d.toLocaleDateString('en-US', { weekday: 'short' });
      }
    }
    return { done, days, bestN, bestDay };
  })();

  // Inline command autocomplete: when the typed "/prefix" matches exactly one
  // command, the remainder renders as ghost text; → or Tab accepts it.
  const typedCmd =
    inputValue.startsWith('/') && !inputValue.includes(' ') &&
    !editingNode && subEntryTarget === null && !isRecordingShortcut
      ? inputValue.toLowerCase()
      : null;
  const cmdMatches = typedCmd ? COMMANDS.filter(c => c.cmd.startsWith(typedCmd)) : [];
  const ghost = typedCmd && cmdMatches.length === 1 && cmdMatches[0].cmd.length > typedCmd.length
    ? cmdMatches[0].cmd.slice(typedCmd.length)
    : '';

  const acceptGhost = () => {
    const full = cmdMatches[0];
    setInputValue(full.usage.includes('<') ? full.cmd + ' ' : full.cmd);
    setShowHint(true);
  };

  // Cyan pulse on a row (reordered, added, promoted)
  const flashRow = (key: string) => {
    setFlashRowKey(key);
    if (flashRowTimer.current) clearTimeout(flashRowTimer.current);
    flashRowTimer.current = setTimeout(() => setFlashRowKey(null), 350);
  };

  // How many siblings live in the array a move addresses.
  // Both sides read the REF, not the render closure: a caret commit followed by
  // a caret nudge inside one tick must clamp against the list that first splice
  // produced, not the one this render was built from.
  const siblingCount = (parentPath: MoveParent): number =>
    parentPath === 'backlog' ? backlogRef.current.length : (childArrayOf(tasksRef.current, parentPath)?.length ?? 0);

  // The single from→to splice funnel. It addresses one sibling array by path,
  // which is what makes reorder SIBLING-ONLY: `to` is clamped/rejected inside
  // that array, so Alt+↑ on a first child can never pop it out of its parent.
  // Applies immediately, pulses the landing row, and freezes hover-selection so
  // the row sliding under the stationary cursor can't steal the selection.
  const applyMove = (parentPath: MoveParent, from: number, to: number) => {
    const flashMoved = (key: string) => { mouseNavEnabled.current = false; flashRow(key); };
    const len = siblingCount(parentPath);
    if (from === to || from < 0 || to < 0 || from >= len || to >= len) return;
    if (parentPath === 'backlog') {
      const n = [...backlogRef.current];
      const [it] = n.splice(from, 1);
      n.splice(to, 0, it);
      dispatch({ backlog: n });
      setSel({ kind: 'backlog', index: to });
      flashMoved(`b-${to}`);
      return;
    }
    const next: Task[] = JSON.parse(JSON.stringify(tasksRef.current));
    const arr = childArrayOf(next, parentPath);
    if (!arr) return;
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    dispatchTasks(next);
    const landed = [...parentPath, to];
    setSel({ kind: 'task', path: landed });
    flashMoved(rowKey(landed));
  };

  const commitPendingMove = () => {
    const pm = pendingRef.current;
    if (pendingTimer.current) { clearTimeout(pendingTimer.current); pendingTimer.current = null; }
    if (!pm) return;
    pendingRef.current = null;
    setPendingMove(null);
    applyMove(pm.parentPath, pm.from, pm.to);
  };
  commitRef.current = commitPendingMove; // fresh closure for timers & stale callers

  // Caret click: accumulate a preview move instead of reordering right away.
  const nudgeRow = (parentPathIn: MoveParent, index: number, dir: -1 | 1) => {
    const pm = pendingRef.current;
    let parentPath = parentPathIn;
    let from = index;
    let base = index;
    if (pm && sameParent(pm.parentPath, parentPath) && pm.from === index) {
      base = pm.to; // same row: extend the pending move
    } else if (pm) {
      commitRef.current(); // different row: land the previous move first…
      // …then re-address this row against the tree that splice just produced.
      // The previous move may have reordered this row's own sibling array OR
      // any ancestor array on the way down to it.
      if (parentPath !== 'backlog') {
        const shifted = shiftPathAfterMove([...parentPath, index], pm);
        parentPath = shifted.slice(0, -1);
        from = shifted[shifted.length - 1];
        base = from;
      } else if (pm.parentPath === 'backlog' && pm.to !== pm.from) {
        if (pm.from < index && pm.to >= index) { from = index - 1; base = from; }
        else if (pm.from > index && pm.to <= index) { from = index + 1; base = from; }
      }
    }
    const len = siblingCount(parentPath);
    const to = Math.min(Math.max(base + dir, 0), Math.max(len - 1, 0));
    const npm: PendingMove = { parentPath, from, to };
    pendingRef.current = npm;
    setPendingMove(npm);
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => commitRef.current(), 1200);
  };

  // Keyboard/wheel path: instant move — unless a caret preview is open,
  // in which case ↑/↓ extend that preview instead of moving a stale index.
  const moveSelected = (dir: -1 | 1) => {
    const pm = pendingRef.current;
    if (pm) { nudgeRow(pm.parentPath, pm.from, dir); return; }
    if (!sel) return;
    if (sel.kind === 'backlog') { applyMove('backlog', sel.index, sel.index + dir); return; }
    if (!nodeAt(tasksRef.current, sel.path)) return;
    // Sibling-only: the node keeps its parent, only its slot in that parent
    // changes. Depth 0 addresses the root array as parentPath [].
    const idx = sel.path[sel.path.length - 1];
    applyMove(sel.path.slice(0, -1), idx, idx + dir);
  };

  // Alt+wheel over the list reorders the hovered (= selected) row. Native
  // listener because React registers wheel as passive, so preventDefault —
  // needed to stop the list from scrolling mid-reorder — wouldn't work there.
  const moveSelectedRef = useRef(moveSelected);
  moveSelectedRef.current = moveSelected;
  useEffect(() => {
    if (!isExpanded) return;
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelLast.current < 80) return; // one step per tick, even on free-spin wheels
      wheelLast.current = now;
      // The moved row slides out from under the stationary cursor; without this
      // the synthetic mouseenter from the next row would steal the selection.
      mouseNavEnabled.current = false;
      moveSelectedRef.current(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isExpanded]);

  // Demote (§4): the node becomes the LAST CHILD of its previous sibling, with
  // its subtree INTACT — the old "carry the children along as siblings"
  // flattening (and its notice) is gone. Legal iff a previous sibling exists
  // and the whole subtree still fits under the cap; a depth violation says so,
  // "no previous sibling" is a silent no-op (nothing about it is a depth
  // problem, so the depth notice would be a lie).
  const demoteTask = (path: number[]) => {
    const idx = path[path.length - 1];
    const parentPath = path.slice(0, -1);
    const depth = path.length - 1;
    const node = nodeAt(tasksRef.current, path);
    if (!node) return;
    // Depth first, so a too-tall subtree always explains itself even when the
    // node also happens to be a first sibling.
    if (depth + 1 + subtreeHeight(node) > MAX_DEPTH_INDEX) { postNotice(MAX_DEPTH_NOTICE); return; }
    if (idx <= 0) return;
    const next: Task[] = JSON.parse(JSON.stringify(tasksRef.current));
    const arr = childArrayOf(next, parentPath);
    if (!arr) return;
    const [moved] = arr.splice(idx, 1);
    const prev = arr[idx - 1];
    if (!prev.subtasks) prev.subtasks = [];
    const at = prev.subtasks.length;
    prev.subtasks.push(moved);
    dispatchTasks(next);
    const landed = [...parentPath, idx - 1, at];
    setSel({ kind: 'task', path: landed });
    mouseNavEnabled.current = false;
    flashRow(rowKey(landed));
  };

  // Promote (§4): the node becomes the NEXT SIBLING of its parent, subtree
  // intact. Moving up can never break the cap, so the only illegal case is
  // depth 0 — there is no parent to step out of.
  const promoteSub = (path: number[]) => {
    if (path.length <= 1) return;
    const parentPath = path.slice(0, -1);
    const grandPath = parentPath.slice(0, -1);
    const parentIdx = parentPath[parentPath.length - 1];
    const next: Task[] = JSON.parse(JSON.stringify(tasksRef.current));
    const siblings = childArrayOf(next, parentPath);
    const uncles = childArrayOf(next, grandPath);
    const idx = path[path.length - 1];
    if (!siblings || !uncles || idx < 0 || idx >= siblings.length) return;
    const [moved] = siblings.splice(idx, 1);
    uncles.splice(parentIdx + 1, 0, moved);
    dispatchTasks(next);
    const landed = [...grandPath, parentIdx + 1];
    setSel({ kind: 'task', path: landed });
    mouseNavEnabled.current = false;
    flashRow(rowKey(landed));
  };

  // Toggle (§5): the click cascades DOWN to every descendant; dispatchTasks
  // then recomputes upward, so completing the last incomplete leaf completes
  // every ancestor of it.
  const toggleNode = (path: number[]) => {
    const next: Task[] = JSON.parse(JSON.stringify(tasksRef.current));
    const node = nodeAt(next, path);
    if (!node) return;
    setSubtreeCompleted(node, !node.completed);
    const snapshot = dispatchTasks(next);
    // Stash what this toggle was, for a dblclick arriving right behind it.
    // NOT idempotent for a parent with mixed children, which is exactly why the
    // dblclick has to restore this snapshot instead of "toggling back".
    lastToggleRef.current = { id: node.id, ts: Date.now(), snapshot };
  };

  // Delete the node and everything under it, then land the selection on the
  // slot it vacated (its next sibling, else the previous one, else the parent).
  const deleteNode = (path: number[]) => {
    const node = nodeAt(tasksRef.current, path);
    if (!node) return;
    const descendants = subtreeSize(node) - 1;
    const parentPath = path.slice(0, -1);
    const idx = path[path.length - 1];
    const next: Task[] = JSON.parse(JSON.stringify(tasksRef.current));
    const arr = childArrayOf(next, parentPath);
    if (!arr) return;
    arr.splice(idx, 1);
    dispatchTasks(next);
    if (arr.length > 0) setSel({ kind: 'task', path: [...parentPath, Math.min(idx, arr.length - 1)] });
    else setSel(parentPath.length > 0 ? { kind: 'task', path: parentPath } : null);
    postNotice(descendants > 0
      ? `[OK] deleted · ${descendants} descendant${descendants > 1 ? 's' : ''} · Ctrl+Z restores`
      : '[OK] deleted · Ctrl+Z restores');
  };

  // Sub-entry legality (§4): a node can host children only while the child
  // would still land inside the cap.
  const canHostChild = (path: number[]) => path.length - 1 + 1 <= MAX_DEPTH_INDEX;
  // Callers hand in the path they can see; it is converted to the node's id
  // immediately, so the target stays put no matter what happens to the rows
  // above it while the prompt is open.
  const openSubEntry = (path: number[]) => {
    if (!canHostChild(path)) { postNotice(MAX_DEPTH_NOTICE); return; }
    const node = nodeAt(tasks, path);
    if (!node) return;
    setSubEntryTarget(node.id);
    setSel(null);
  };

  const HELP_TABS = ['keys', 'mouse', 'cmds', 'log', 'about'] as const;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // While the manual is open it owns the keyboard: 1-4 / arrows switch tabs, Esc closes
    if (showHelp) {
      e.preventDefault();
      if (e.key === 'Escape' || e.key === 'Enter') { setShowHelp(false); return; }
      const num = Number(e.key);
      if (num >= 1 && num <= HELP_TABS.length) { setHelpTab(HELP_TABS[num - 1]); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const cur = HELP_TABS.indexOf(helpTab);
        const n = HELP_TABS.length;
        const nxt = e.key === 'ArrowRight' ? (cur + 1) % n : (cur + n - 1) % n;
        setHelpTab(HELP_TABS[nxt]);
      }
      return;
    }

    // The shortcut recorder owns EVERY key while open — it must run before
    // any other handler, or arrows would navigate the list, Ctrl+Z would
    // undo, etc., while the user is trying to type a combo.
    if (isRecordingShortcut) {
      e.preventDefault();

      if (e.key === 'Escape') {
        setIsRecordingShortcut(false);
        setTempShortcut('');
        setInputValue('');
        return;
      }

      if (e.key === 'Enter') {
        if (tempShortcut) {
          setHotkey(tempShortcut);
          postNotice(`[OK] hotkey: ${displayShortcut(tempShortcut)}`);
        } else {
          // Bare Enter = reset to the default binding
          setHotkey('Alt+X');
          postNotice('[OK] hotkey reset to default Alt+X');
        }
        setIsRecordingShortcut(false);
        setTempShortcut('');
        setInputValue('');
        return;
      }

      const keys: string[] = [];
      if (e.ctrlKey || e.metaKey) keys.push('CommandOrControl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');

      const isModifierOnly = ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);

      if (isModifierOnly) {
        // Live preview while modifiers are held, before the main key lands
        const held = keys.map(displayShortcut).join('+');
        setInputValue(`[Recording] ${held ? held + '+…' : '…'} · Enter=reset Alt+X · Esc=cancel`);
        return;
      }

      let mainKey = e.key.toUpperCase();
      if (mainKey === ' ') mainKey = 'Space';
      keys.push(mainKey);

      const tauriShortcut = keys.join('+');
      setTempShortcut(tauriShortcut);
      setInputValue(`[Confirm?] ${displayShortcut(tauriShortcut)} · Enter=save · Esc=cancel`);
      return;
    }

    // Tab must NEVER perform default focus-navigation: the command input is
    // the app's only keyboard owner, and an unhandled Tab/Shift+Tab walks
    // focus out of it — escaping the webview's focusables fires a window
    // blur, which collapses the panel to the ball mid-keystroke.
    if (e.key === 'Tab') e.preventDefault();

    // Accept ghost completion with → (or Tab) when the caret sits at the end
    if ((e.key === 'ArrowRight' || e.key === 'Tab') && ghost &&
        inputRef.current?.selectionStart === inputValue.length) {
      e.preventDefault();
      acceptGhost();
      return;
    }

    // ↑/↓ walk the flattened visible list: current index ± 1, wrapping around
    // the whole list (tasks → backlog → tasks). A stale selection (its row is
    // gone) reads as -1 and takes the "nothing selected" branch.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      mouseNavEnabled.current = false; // keyboard owns selection until the mouse moves again
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (e.altKey) { moveSelected(dir); return; }
      if (rows.length === 0) return;

      const cur = rowIndexOf(rows, sel);
      if (cur < 0) {
        // Nothing selected. ↓ takes the first row. ↑ takes the last TASK row
        // (NOT the last backlog row) — preserving today's behaviour exactly.
        if (dir === 1) { setSel(selOfRow(rows[0])); return; }
        let last = rows.length - 1;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].kind === 'task') { last = i; break; }
        }
        setSel(selOfRow(rows[last]));
        return;
      }

      setSel(selOfRow(rows[(cur + dir + rows.length) % rows.length]));
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (history.length > 0) {
        setHistory(prev => prev.slice(0, -1));
        restoreSnapshot(history[history.length - 1]);
      }
      return;
    }

    if (e.key === 'Escape') {
      if (pendingRef.current) {   // abort an uncommitted caret-move preview
        e.preventDefault();
        cancelPendingMove();
        return;
      }
      if (subEntryTarget !== null) {
        e.preventDefault();
        setSubEntryTarget(null);
        setInputValue('');
        return;
      }
      if (editingNode) {
        e.preventDefault();
        setInputValue('');
        setEditingNode(null);
        return;
      }
      if (isExpanded) {
        e.preventDefault();
        if (sel) {
          setSel(null);
        } else {
          setInputValue('');
          collapsePanel();
        }
      }
      return;
    }

    const text = inputValue.trim();
    const selTask = sel?.kind === 'task' ? sel : null;
    const selBack = sel?.kind === 'backlog' ? sel : null;

    if (text === '' && selTask && nodeAt(tasks, selTask.path)) {
      const path = selTask.path;

      if ((e.key === 'Backspace' || e.key === 'Delete') && !editingNode) {
        e.preventDefault();
        deleteNode(path);
        return;
      }

      if (e.key === ' ') {
        e.preventDefault();
        toggleNode(path);
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const node = nodeAt(tasks, path)!;
        setInputValue(node.text);
        setEditingNode({ kind: 'task', id: node.id });
        return;
      }

      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        demoteTask(path);
        return;
      }

      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        promoteSub(path);
        return;
      }

      // '>' on a selected node → rapid subtask entry mode, targeting THAT node
      // (the '+' alias was removed — one key, matching the sub> prompt and the '> ' prefix)
      if (e.key === '>') {
        e.preventDefault();
        openSubEntry(path);
        return;
      }

      return;
    }

    if (text === '' && selBack && selBack.index < backlog.length) {
      const bIdx = selBack.index;
      if (e.key === ' ') {
        e.preventDefault();
        const taskToPromote = backlog[bIdx];
        if (taskToPromote) {
          // ONE dispatch for both halves: the item leaves `backlog` and joins
          // `tasks` in a single undo step, so Ctrl+Z puts it back where it was
          // instead of deleting it (it used to be two mutations, only one of
          // which history knew about).
          // Re-stamp the id on the way in: ids are deduped per list, so a
          // backlog item sharing an id with an existing task (reachable via a
          // hand-edited state.json) would otherwise put a duplicate in the tree
          // and make findPathById resolve edit/sub-entry targets to the wrong node.
          const nextTasks = [...tasksRef.current, { ...taskToPromote, id: crypto.randomUUID() }];
          dispatch({
            backlog: backlogRef.current.filter((_, i) => i !== bIdx),
            tasks: nextTasks,
          });
          setSel(null);
          const landed = rowKey([nextTasks.length - 1]);
          flashRow(landed);
          setTimeout(() => rowRefs.current.get(landed)?.scrollIntoView({ block: 'nearest' }), 50);
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = backlog[bIdx];
        if (target) {
          setInputValue(target.text);
          setEditingNode({ kind: 'backlog', id: target.id });
        }
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        dispatch({ backlog: backlogRef.current.filter((_, i) => i !== bIdx) });
        const maxIdx = backlog.length - 2;
        const at = bIdx > maxIdx ? maxIdx : bIdx;
        setSel(at >= 0 ? { kind: 'backlog', index: at } : null);
        return;
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();

      // Rapid subtask entry: Enter adds and STAYS in the mode so you can
      // chain several subtasks; empty Enter (or Esc) exits.
      if (subEntryTarget !== null) {
        if (!text) { setSubEntryTarget(null); return; }
        // Re-resolved every commit, so chaining keeps hitting the same node
        // even though each added child is itself a mutation.
        const targetPath = subEntryPath;
        if (!targetPath) { setSubEntryTarget(null); setInputValue(''); return; }
        if (!canHostChild(targetPath)) { postNotice(MAX_DEPTH_NOTICE); setSubEntryTarget(null); setInputValue(''); return; }
        const next: Task[] = JSON.parse(JSON.stringify(tasks));
        const parent = nodeAt(next, targetPath);
        if (parent) {
          if (!parent.subtasks) parent.subtasks = [];
          parent.subtasks.push({ id: crypto.randomUUID(), text, completed: false, subtasks: [] });
          dispatchTasks(next);
        } else {
          setSubEntryTarget(null);
        }
        setInputValue('');
        return;
      }

      if (!text) return;

      if (text === '/help') {
        setShowHelp(true);
        setHelpTab('keys');
        setInputValue('');
        return;
      }
      if (text === '/about') {
        setShowHelp(true);
        setHelpTab('about');
        setInputValue('');
        return;
      }
      if (text === '/log' || text === '/daily') {
        setShowHelp(true);
        setHelpTab('log');
        setInputValue('');
        setShowHint(false);
        return;
      }
      if (text.startsWith('/daily ')) {
        const t = text.slice(7).trim();
        if (t) {
          // Template and the task it seeds land in ONE undo step. Nothing to
          // dispatch when both already exist — a no-op must not push a history
          // entry that a later Ctrl+Z would spend doing nothing visible.
          const addTemplate = !dailyRef.current.includes(t);
          const addTask = !tasksRef.current.some(task => task.text === t);
          if (addTemplate || addTask) {
            dispatch({
              daily: addTemplate ? [...dailyRef.current, t] : undefined,
              tasks: addTask
                ? [...tasksRef.current, { id: crypto.randomUUID(), text: t, completed: false, subtasks: [] }]
                : undefined,
            });
          }
          postNotice('[OK] daily ritual saved · reseeds every day');
        }
        setInputValue('');
        setShowHint(false);
        return;
      }
      if (text === '/export') {
        (async () => {
          try {
            const folderPath = await ensureLogFolder();
            const n = new Date();
            const p = (v: number) => String(v).padStart(2, '0');
            const stamp = `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
            const filePath = await join(folderPath, `export-${stamp}.json`);
            await writeTextFile(filePath, JSON.stringify(statePayload(), null, 2));
            postNotice(`[OK] Documents/TerminalTasks/export-${stamp}.json`);
          } catch (error) {
            console.error("Export failed:", error);
            postNotice('[ERR] export failed');
          }
        })();
        setInputValue('');
        setShowHint(false);
        return;
      }
      if (text === '/startup' || text === '/startup on' || text === '/startup off') {
        const arg = text.slice(8).trim(); // '' = toggle, else an explicit target
        (async () => {
          try {
            const cur = await isAutostartEnabled();
            const want = arg === 'on' ? true : arg === 'off' ? false : !cur;
            if (want !== cur) {
              if (want) await enableAutostart(); else await disableAutostart();
            }
            setAutostartOn(want);
            // An explicit choice is final: make sure the first-run default
            // can never revisit this, even if the flag was somehow lost.
            localStorage.setItem('geek-autostart-init', '1');
            localStorage.removeItem('geek-autostart-announce');
            postNotice(`[OK] launch at login: ${want ? 'ON' : 'OFF'}${want === cur ? ' (unchanged)' : ''}`);
          } catch (error) {
            console.error("Autostart toggle failed:", error);
            postNotice('[ERR] autostart unavailable');
          }
        })();
        setInputValue('');
        setShowHint(false);
        return;
      }
      if (text === '/clear') {
        dispatchTasks([]);
        postNotice('[OK] cleared · Ctrl+Z restores');
        setInputValue('');
        return;
      }

      if (text === '/l') {
        // Bare /l jumps to the backlog — the section lives below the fold
        // and is easy to forget exists.
        if (backlog.length > 0) {
          mouseNavEnabled.current = false;
          setSel({ kind: 'backlog', index: 0 });
          setTimeout(() => rowRefs.current.get('b-0')?.scrollIntoView({ block: 'nearest' }), 0);
        } else {
          postNotice('[..] backlog empty · /l <text> adds');
        }
        setInputValue('');
        setShowHint(false);
        return;
      }

      if (editingNode) {
        // Resolved HERE, not where the edit was opened: rows above the target
        // may have been deleted or reordered in between.
        const editId = editingNode.id;
        if (editingNode.kind === 'backlog') {
          dispatch({ backlog: backlogRef.current.map(t => t.id === editId ? { ...t, text } : t) });
        } else {
          const newTasks: Task[] = JSON.parse(JSON.stringify(tasks));
          const path = findPathById(newTasks, editId);
          const node = path ? nodeAt(newTasks, path) : null;
          if (node) node.text = text;
          dispatchTasks(newTasks);
        }
        setInputValue('');
        setEditingNode(null);
        return;
      }

      if (text === '/shortcut') {
        setIsRecordingShortcut(true);
        setTempShortcut('');
        setInputValue(`[Recording] now ${displayShortcut(hotkey)} · press combo · Enter=reset Alt+X · Esc=cancel`);
        return;
      }

      // Themes are command-driven because invariant #1 forbids adding any
      // focusable element to the panel — a clickable picker in the help modal
      // would take focus off the command input. Nothing here dispatches, so a
      // theme change costs no undo step (spec §8.6).
      if (text === '/theme' || text.startsWith('/theme ')) {
        const arg = text.slice('/theme'.length).trim().toLowerCase();
        if (arg === '') {
          postNotice(`[..] ${PRESET_NAMES.map(n => (n === themeName ? `*${n}` : n)).join(' · ')} · ramp ${rampOn ? 'on' : 'off'}`);
        } else if (arg === 'ramp off' || arg === 'ramp on') {
          const on = arg.endsWith('on');
          // Say so even when the ACTIVE preset has no ramp of its own —
          // otherwise `/theme ramp on` under `mono` looks like it did nothing.
          setRampOn(on);
          postNotice(on
            ? (preset.ramp ? '[OK] deadline ramp on' : '[OK] ramp on · this preset has none')
            : '[OK] deadline ramp off');
        } else if (PRESETS[arg]) {
          setThemeName(arg);
          postNotice(`[OK] theme ${arg}`);
        } else {
          postNotice(`[ERR] unknown theme · ${PRESET_NAMES.join(' · ')}`);
        }
        setInputValue('');
        setShowHint(false);
        return;
      }

      // Bare `/deadline` is matched too: without it the trailing-space test
      // failed and the word fell through to the task-capture path, adding a
      // task literally named "/deadline". Malformed input used to be swallowed
      // in silence — it now says so, since a mistyped deadline is invisible
      // until the glow fails to ramp hours later.
      if (text === '/deadline' || text.startsWith('/deadline ')) {
        const arg = text.slice('/deadline'.length).trim().toLowerCase();
        if (arg === '') {
          postNotice(deadline
            ? `[..] deadline ${deadline} · /deadline off clears it`
            : '[..] no deadline · /deadline HH:MM sets one');
        } else if (arg === 'off' || arg === 'clear' || arg === 'none') {
          // Clearing before rollover is the whole point: the ramp is a 2h
          // pressure signal, and a deadline that has passed leaves the entire
          // UI red until midnight with no way to call the day done.
          if (deadline) { setDeadline(''); postNotice('[OK] deadline cleared'); }
          else postNotice('[..] no deadline set');
        } else if (/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(arg)) {
          setDeadline(arg);
          postNotice(`[OK] deadline ${arg}`);
        } else {
          postNotice('[ERR] use /deadline HH:MM or /deadline off');
        }
        setInputValue('');
        setShowHint(false);
        return;
      }

      if (text.startsWith('/l ')) {
        const content = text.slice(3).trim();
        if (content) {
          dispatch({
            backlog: [...backlogRef.current, { id: crypto.randomUUID(), text: content, completed: false, subtasks: [], createdAt: Date.now() }],
          });
        }
        setInputValue('');
        setShowHint(false);
        return;
      }

      // THE one-shot subtask path ('/sub' and Shift+Enter were removed as
      // redundant): '> text' or '- text' adds under the selected task, else
      // the last one — which keeps the capture chain `task ⏎ > sub ⏎` working.
      const isQuickSymbol = text.startsWith('> ') || text.startsWith('- ');
      if (isQuickSymbol && tasks.length > 0) {
        const subText = text.substring(2).trim();
        if (subText) {
          // Targets the SELECTED node at any depth (§4); with nothing selected
          // it still falls back to the last top-level task.
          const target = selTask && nodeAt(tasks, selTask.path) ? selTask.path : [tasks.length - 1];
          if (!canHostChild(target)) {
            postNotice(MAX_DEPTH_NOTICE);
            setInputValue('');
            setShowHint(false);
            return;
          }
          const next: Task[] = JSON.parse(JSON.stringify(tasks));
          const parent = nodeAt(next, target)!;
          if (!parent.subtasks) parent.subtasks = [];
          parent.subtasks.push({ id: crypto.randomUUID(), text: subText, completed: false, subtasks: [] });
          dispatchTasks(next);
          // Make the landing spot unmistakable
          const landed = [...target, parent.subtasks.length - 1];
          mouseNavEnabled.current = false;
          flashRow(rowKey(landed));
          setTimeout(() => rowRefs.current.get(rowKey(landed))?.scrollIntoView({ block: 'nearest' }), 50);
        }
        setInputValue('');
        setShowHint(false);
        return;
      }

      dispatchTasks([...tasks, { id: crypto.randomUUID(), text, completed: false, subtasks: [] }]);
      // Confirm the capture: pulse the new row and bring it into view
      flashRow(rowKey([tasks.length]));
      setTimeout(() => rowRefs.current.get(rowKey([tasks.length]))?.scrollIntoView({ block: 'nearest' }), 50);
      setInputValue('');
      setShowHint(false);
      setSel(prev => (prev?.kind === 'task' ? null : prev));
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    if (!val.startsWith('/')) setSel(prev => (prev?.kind === 'task' ? null : prev));
    if (val.startsWith('/')) {
      setShowHint(true);
    } else {
      setShowHint(false);
    }
  };

  const handleTaskClick = (e: React.MouseEvent, path: number[]) => {
    e.preventDefault();
    e.stopPropagation();
    // A double-click delivers TWO click events before `dblclick`. Toggling on
    // both is destructive, not a no-op: for a parent with mixed children the
    // first click completes every descendant and the second clears them all,
    // so the originally-ticked ones come back unticked. Only the first click
    // of a sequence toggles; the dblclick handler reverts that one if it turns
    // out the user was opening the editor. No timer — the single click still
    // toggles immediately.
    if (e.detail > 1) return;
    toggleNode(path);
    setSel(prev => (prev?.kind === 'task' ? null : prev));
    inputRef.current?.focus();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
  }

  const promoteBacklogTask = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const taskToPromote = backlog[index];
    if (!taskToPromote) return;
    // Both halves in one dispatch (see the Space branch): removing it from the
    // backlog and appending it to the tasks is a single undoable action.
    // Fresh id on the way in — see the Space branch for why.
    const nextTasks = [...tasksRef.current, { ...taskToPromote, id: crypto.randomUUID() }];
    dispatch({
      backlog: backlogRef.current.filter((_, i) => i !== index),
      tasks: nextTasks,
    });
    // The item teleports from backlog to the task list — show where it landed
    const landed = rowKey([nextTasks.length - 1]);
    flashRow(landed);
    setTimeout(() => rowRefs.current.get(landed)?.scrollIntoView({ block: 'nearest' }), 50);
    if (inputRef.current) inputRef.current.focus();
  };

  // Ghost preview for a pending caret move: a semi-transparent, blurred,
  // dashed one-liner OVERLAID at the insertion boundary. It must NOT be in
  // normal flow — an in-flow ghost shifts the list, moves the caret out from
  // under the cursor, and the resulting synthetic hover killed the preview.
  // Which of the two ghost styles is drawn keys off the MEASURED height of the
  // source row (see `tall` below), not off whether it has children.
  const pmGhost = pendingMove && pendingMove.to !== pendingMove.from ? pendingMove : null;
  // Boundary slot: moving down inserts after `to` (source row is still in place)
  const ghostSlot = pmGhost ? (pmGhost.to < pmGhost.from ? pmGhost.to : pmGhost.to + 1) : -1;
  const ghostOverlay = () => {
    if (!pmGhost) return null;
    const { parentPath, from } = pmGhost;
    const isBacklog = parentPath === 'backlog';
    const len = siblingCount(parentPath);
    const keyAt = (i: number) => (isBacklog ? `b-${i}` : rowKey([...(parentPath as number[]), i]));
    const atEnd = ghostSlot >= len;
    const el = rowRefs.current.get(keyAt(atEnd ? len - 1 : ghostSlot));
    if (!el) return null;
    // Center on the visual boundary: rows are separated by a 4px gap
    // (space-y-1), so the midline sits 2px off the border-box edge.
    const y = atEnd ? el.offsetTop + el.offsetHeight + 2 : el.offsetTop - 2;
    const src = isBacklog ? backlog[from] : nodeAt(tasks, [...(parentPath as number[]), from]);
    if (!src) return null;
    // Depth of the moving row; the ghost indents to match it.
    const depth = isBacklog ? 0 : (parentPath as number[]).length;
    const subCount = childrenOf(src).length;
    // Which ghost to draw is a question about RENDERED HEIGHT, not parenthood:
    // at depth, "has children" and "is visually tall" diverge (a nested parent
    // of one short leaf is slimmer than a wrapped top-level row). The row
    // wrapper ref spans the subtree, so measuring it answers the real question.
    const srcEl = rowRefs.current.get(keyAt(from));
    const tall = (srcEl?.offsetHeight ?? 0) >= 32;
    return (
      <div
        // NOTE: no transform-animating class here — modalIn would override the
        // translateY(-50%) centering and make the ghost snap on mount. The
        // entrance lives on the inner div; this one only positions and glides
        // between slots via the `top` transition.
        className="absolute left-4 right-4 z-20 pointer-events-none select-none transition-[top] duration-200 ease-out"
        style={{ top: y, transform: 'translateY(-50%)' }}
      >
        {/* 16px per level = the (ml-2 + pl-2) each nesting container indents by,
            so either variant lines up with the row it came from. */}
        {tall ? (
          // Tall source → condensed block: one dashed-bordered line standing in
          // for a row too big to preview literally.
          <div
            className="border-l-2 border-dashed border-[var(--accent-action)]/70 bg-[var(--accent-action-wash)]/60 backdrop-blur-[2px] text-[var(--accent-action-soft)]/80 px-3 py-0.5 rounded-sm truncate animate-modal-in"
            style={{ marginLeft: depth * 16 }}
          >
            ⇥ {src.text}
            {subCount > 0 && <span className="text-[var(--accent-action-deep)]/80"> ·{subCount} sub</span>}
          </div>
        ) : (
          // Short source → a full-height ghost would blanket both neighbors, so
          // draw a thin insertion rule with a small label chip instead.
          <div className="flex items-center gap-2 animate-modal-in" style={{ marginLeft: depth * 16 }}>
            <span className="text-[10px] leading-tight text-[var(--accent-action-soft)]/90 bg-[var(--accent-action-wash)]/80 backdrop-blur-[2px] px-1.5 rounded-sm truncate max-w-[70%] shrink-0">⇥ {src.text}</span>
            <div className="flex-1 border-t border-dashed border-[var(--accent-action)]/70" />
          </div>
        )}
      </div>
    );
  };

  // --- Recursive row renderer (option C) -----------------------------------
  // One node = an outer wrapper (carries the row ref, and at depth 0 the
  // selection/flash chrome) + the row line + an optional nested container for
  // its children. Ancestry is that container's 1px LEFT BORDER, not `├─`/`└─`:
  // box-drawing rules break the moment a row wraps, a border does not.
  // Marker and text live in separate spans so wrapped lines align to the text
  // column at every depth.
  const renderNode = (task: Task, path: number[], depth: number): React.ReactNode => {
    const key = rowKey(path);
    const idx = path[path.length - 1];
    const isSel = sel?.kind === 'task' && samePath(sel.path, path);
    const isFlash = flashRowKey === key;
    const isSubTarget = subEntryTarget !== null && task.id === subEntryTarget;
    const isMoveSource = !!pmGhost && pmGhost.parentPath !== 'backlog' &&
      samePath([...pmGhost.parentPath, pmGhost.from], path);
    const kids = childrenOf(task);
    const marker = task.completed ? '[x]' : depth === 0 ? `[${idx + 1}]` : depth === 1 ? '[ ]' : '[·]';

    // Depth 0 keeps the theme-colored block with its left accent; deeper rows
    // are gray and get a rounded pad instead — a left border at depth either
    // reads as another ancestry rule or detaches from the row.
    const outerClass = depth === 0
      ? `px-3 py-2 transition-all duration-150 ${
          isMoveSource
            ? 'opacity-50 border-l-2 border-dashed border-[var(--accent-action)]/40'
            : isFlash
            ? 'bg-[var(--accent-action-wash)]/50 border-l-2 border-[var(--accent-action)]'
            : isSubTarget
            ? 'bg-[var(--accent-action-wash)]/30 border-l-2 border-[var(--accent-action)]/70'
            : isSel
            ? 'bg-gray-800/80 shadow-md border-l-2 border-[var(--theme-color)]'
            : 'border-l-2 border-transparent hover:bg-gray-900/40'
        }`
      : 'text-sm text-gray-400/80';
    // `px-1 -mx-1` cancels out, so the state swap can never reflow the row.
    const rowStateClass = depth === 0
      ? ''
      : isMoveSource
      ? 'opacity-50 rounded px-1 -mx-1'
      : isFlash
      ? 'bg-[var(--accent-action-wash)]/60 rounded px-1 -mx-1'
      : isSubTarget
      ? 'bg-[var(--accent-action-wash)]/30 rounded px-1 -mx-1'
      : isSel
      ? 'bg-gray-700/50 rounded px-1 -mx-1'
      : '';

    // `ownToggle` = this dblclick's own first click ran a toggle on this row,
    // i.e. the click and dblclick handlers sit on the same element (depth 0).
    // Deeper rows toggle on the marker and edit on the text — two different
    // elements — so nothing was toggled and there is nothing to take back.
    const startEdit = (e: React.MouseEvent, ownToggle: boolean) => {
      e.preventDefault(); e.stopPropagation();
      // Genuinely revert the one toggle that fired (the second click was
      // swallowed by the e.detail guard) by restoring its snapshot and popping
      // its history entry. The old code dropped two entries on the premise
      // that the two toggles cancelled out — false for a mixed subtree, and
      // the dropped entries were the only way back.
      //
      // Three conditions, all required, so an unrelated undo step can never be
      // eaten: same row, inside the double-click window, and the top of the
      // history stack is (by reference) THE entry that toggle pushed — still
      // the exact object dispatch pushed, now a Snapshot rather than a Task[].
      // If any fails, just open the editor — the toggle stays and Ctrl+Z still
      // undoes it.
      const lt = lastToggleRef.current;
      const top = history[history.length - 1];
      if (
        ownToggle && lt && lt.id === task.id &&
        Date.now() - lt.ts <= DBLCLICK_REVERT_MS &&
        top !== undefined && top === lt.snapshot
      ) {
        setHistory(prev => prev.slice(0, -1));
        restoreSnapshot(top);         // deep clone, and popping it leaves no aliasing
        lastToggleRef.current = null; // one revert per toggle, never twice
      }
      setInputValue(task.text);
      setEditingNode({ kind: 'task', id: task.id });
      inputRef.current?.focus();
    };
    const pillHi = isSel ? 'text-[var(--theme-color)]' : 'hover:text-[var(--theme-color)]';

    // Pill legality (§3): an action that would be refused is not rendered at
    // all, rather than rendered and answered with a notice. That also shrinks
    // the pill exactly at depth, which is where the row is narrowest.
    const canAddChild = depth + 1 <= MAX_DEPTH_INDEX;
    const canDemote = idx > 0 && depth + 1 + subtreeHeight(task) <= MAX_DEPTH_INDEX;
    const canPromote = depth >= 1;

    return (
      <div key={task.id || key} ref={setRowRef(key)} className={outerClass}>
        <div
          className={`relative flex items-start group w-full transition-all duration-150 ${rowStateClass}`}
          onMouseEnter={() => hoverSelect({ kind: 'task', path })}
        >
          <div
            className={`flex items-start min-w-0 flex-1 text-left ${
              depth === 0 ? 'text-[var(--theme-color)] transition-colors duration-1000' : ''
            }`}
            onClick={depth === 0 ? (e) => handleTaskClick(e, path) : undefined}
            onDoubleClick={depth === 0 ? (e) => startEdit(e, true) : undefined}
          >
            <span
              className={`mr-2 shrink-0 select-none font-mono ${
                depth === 0 ? 'opacity-90' : 'cursor-pointer hover:text-[var(--accent-affirm)] transition-colors'
              }`}
              onClick={depth === 0 ? undefined : (e) => handleTaskClick(e, path)}
            >
              {marker}
            </span>
            <span
              className={`min-w-0 break-words transition-all ${
                task.completed
                  ? 'opacity-40 line-through'
                  : depth === 0
                  ? 'opacity-90'
                  : 'group-hover:text-gray-300'
              }`}
              onDoubleClick={depth === 0 ? undefined : (e) => startEdit(e, false)}
            >
              {task.text}
            </span>
          </div>
          {/* Overlay actions, two-stage: row hover shows a tiny [ ⋯ ] chip
              (barely covers text); hovering the chip expands the full pill.
              No reserved width, so text still spans the full row.
              Illegal actions are omitted, not disabled — see the flags above. */}
          <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity font-mono text-sm group/pill">
          <span className="flex items-center text-gray-500 bg-black/70 backdrop-blur-[2px] rounded-sm px-1 select-none cursor-default group-hover/pill:hidden">[ ⋯ ]</span>
          <div className="hidden group-hover/pill:flex items-center text-gray-600 bg-black/85 backdrop-blur-[2px] rounded-sm px-1">
            <span
              className={`mr-2 cursor-pointer transition-colors ${pillHi}`}
              title="Move up (Alt+↑ / Alt+wheel)"
              onClick={(e) => { e.stopPropagation(); nudgeRow(path.slice(0, -1), idx, -1); }}
            >[ ^ ]</span>
            <span
              className={`mr-2 cursor-pointer transition-colors ${pillHi}`}
              title="Move down (Alt+↓ / Alt+wheel)"
              onClick={(e) => { e.stopPropagation(); nudgeRow(path.slice(0, -1), idx, 1); }}
            >[ v ]</span>
            {canAddChild && (
              <span
                className="mr-2 cursor-pointer hover:text-[var(--accent-action)] transition-colors"
                title="Add children (or press > on selection)"
                onClick={(e) => { e.stopPropagation(); openSubEntry(path); inputRef.current?.focus(); }}
              >[ + ]</span>
            )}
            {canDemote && (
              <span
                className="mr-2 cursor-pointer hover:text-[var(--theme-color)] transition-colors"
                title="Demote under the row above, subtree intact (Tab)"
                onClick={(e) => { e.stopPropagation(); demoteTask(path); }}
              >[ » ]</span>
            )}
            {canPromote && (
              <span
                className="mr-2 cursor-pointer hover:text-[var(--theme-color)] transition-colors"
                title="Promote one level, subtree intact (Shift+Tab)"
                onClick={(e) => { e.stopPropagation(); promoteSub(path); }}
              >[ « ]</span>
            )}
            <span
              className="cursor-pointer hover:text-[var(--accent-danger)] transition-colors"
              title="Delete"
              onClick={(e) => { e.stopPropagation(); deleteNode(path); inputRef.current?.focus(); }}
            >[ x ]</span>
          </div>
          </div>
        </div>
        {isSubTarget && (
          <div className="ml-2 pl-2 mt-1 text-xs text-[var(--accent-action)]/80 font-mono select-none animate-modal-in">
            └─ typing below adds here · Enter chains · Esc done
          </div>
        )}
        {kids.length > 0 && (
          <div className="ml-2 pl-2 border-l border-gray-400/30 space-y-1 mt-1">
            {kids.map((child, ci) => renderNode(child, [...path, ci], depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-screen h-screen bg-transparent font-mono text-sm" style={{ '--theme-color': themeColor, ...preset.accents } as React.CSSProperties}>
      {!isExpanded ? (
        <div className="w-[60px] h-[60px] bg-transparent flex items-center justify-center animate-ball-in">
          <div
            className="w-[50px] h-[50px] rounded-full bg-black/80 backdrop-blur-md flex items-center justify-center cursor-pointer select-none animate-soft-breathe transition-colors duration-1000 border border-[var(--theme-color)]"
            style={{
              boxShadow: `0 0 10px color-mix(in srgb, var(--theme-color) 30%, transparent), inset 0 0 5px color-mix(in srgb, var(--theme-color) 10%, transparent)`,
            }}
            onPointerDown={handleBallPointerDown}
            onPointerMove={handleBallPointerMove}
            onPointerUp={handleBallPointerUp}
          >
            <span className="font-bold text-sm tracking-tighter pointer-events-none transition-colors duration-1000 text-[var(--theme-color)]">
              {tasks.length === 0 ? '>_' : remainingMain > 0 ? remainingMain : '✓'}
            </span>
          </div>
        </div>
      ) : (
        <div
          className={`relative w-full h-full bg-[#0a0a0a]/90 backdrop-blur-xl rounded-lg flex flex-col overflow-hidden transition-colors duration-1000 ${isClosing ? 'animate-panel-out' : 'animate-panel-in'}`}
          style={{
            border: `1px solid color-mix(in srgb, var(--theme-color) 40%, transparent)`,
            boxShadow: `0 0 15px color-mix(in srgb, var(--theme-color) 25%, transparent)`,
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onMouseMove={handlePanelMouseMove}
          onMouseDown={(e) => {
            // Keep the command input focused no matter where the user clicks;
            // otherwise a stray click silently kills all keyboard handling.
            if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
          }}
        >
          <div
            className="w-full h-8 flex items-center justify-between px-4 cursor-default select-none border-b border-[var(--theme-color)]/20 shrink-0 transition-colors duration-1000"
          >
            <span className="font-bold transition-colors duration-1000 text-[var(--theme-color)]">admin@local:~#</span>
            <span className="text-xs transition-colors duration-1000 text-[var(--theme-color)]">
              {deadline ? `DL ${deadline} · ${countdown}` : 'DL --:--'}
            </span>
          </div>

          <div className="px-4 py-2 shrink-0 text-[var(--theme-color)] flex items-center justify-between gap-2">
            <span className="shrink-0">{asciiProgress(percent)}</span>
            {notice && (
              <span className={`text-[11px] truncate animate-modal-in ${notice.startsWith('[ERR]') ? 'text-[var(--accent-danger)]/90' : 'text-[var(--accent-action)]/90'}`}>
                {notice}
              </span>
            )}
          </div>

          <div
            ref={listRef}
            className="relative flex-1 overflow-y-auto px-4 py-2 space-y-1 no-scrollbar"
            onMouseLeave={() => setSel(prev => (prev?.kind === 'backlog' ? null : prev))}
          >
            {tasks.length === 0 && (
              <div className="text-[var(--theme-color)] opacity-30 italic transition-colors duration-1000">
                No tasks loaded. Type below to add — <span className="not-italic">/help</span> for the manual.
              </div>
            )}
            {tasks.map((task, i) => renderNode(task, [i], 0))}
            {backlog.length > 0 && (
            <div className="mt-2 pt-3 border-t border-dashed border-gray-700/60 opacity-80">
              <div className="text-xs text-gray-500 mb-2 font-mono select-none flex items-center justify-between gap-2">
                <span>» [BACKLOG / LONG-TERM] · {backlog.length}</span>
                {(() => {
                  const aging = backlog.filter(t => t.createdAt !== undefined && ageDays(t.createdAt) >= 14).length;
                  return aging > 0
                    ? <span className="text-[var(--accent-edit-dim)]/80 truncate">{aging} aging — promote or prune</span>
                    : null;
                })()}
              </div>
              {showSurface && (
                <div className="flex items-center gap-2 text-xs font-mono mb-2 text-gray-500 select-none animate-modal-in">
                  <span className="text-[var(--accent-action-deep)]/80 shrink-0">⌁ consider today?</span>
                  <span className="truncate text-gray-400 min-w-0">{backlog[surfaceIdx]?.text}</span>
                  <span
                    className="cursor-pointer hover:text-[var(--accent-affirm)] shrink-0"
                    title="Promote to today's tasks"
                    onClick={(e) => { promoteBacklogTask(e, surfaceIdx); skipSurface(); }}
                  >[ {'>'} ]</span>
                  <span
                    className="cursor-pointer hover:text-[var(--accent-danger)] shrink-0"
                    title="Not today — ask again tomorrow"
                    onClick={(e) => { e.stopPropagation(); skipSurface(); }}
                  >[ x ]</span>
                </div>
              )}
              {backlog.map((task, idx) => (
                <React.Fragment key={idx}>
                <div
                  ref={setRowRef(`b-${idx}`)}
                  // Selection here used to be a lone `bg-gray-800/40` — the same
                  // gray a selected task gets, at HALF the alpha, with no accent
                  // border and no shadow, sitting on the dimmest base text in the
                  // app. Three cues versus one, and the one at half strength.
                  // It now carries the theme-colored left rule that makes
                  // top-level task selection legible. The "a left border reads as
                  // another ancestry rule" objection is about NESTED rows; the
                  // backlog is flat, so it does not apply.
                  //
                  // Every layout-affecting class is CONSTANT — the border sits
                  // there transparent when unselected and `px-1 -mx-1` cancels
                  // out — so the state swap is pure color and can never reflow
                  // (invariant #8). `rounded-r` only: rounding the left corner
                  // would clip the accent rule.
                  className={`relative flex items-start text-sm py-1 group w-full transition-all duration-150 rounded-r px-1 -mx-1 border-l-2 ${
                    pmGhost?.parentPath === 'backlog' && pmGhost.from === idx
                      ? 'opacity-50 border-transparent'
                      : flashRowKey === `b-${idx}`
                      ? 'bg-[var(--accent-action-wash)]/50 border-[var(--accent-action)]'
                      : sel?.kind === 'backlog' && sel.index === idx
                      ? 'bg-gray-800/80 border-[var(--theme-color)]'
                      : 'border-transparent'
                  }`}
                  onMouseEnter={() => hoverSelect({ kind: 'backlog', index: idx })}
                >
                  <div className="flex items-start min-w-0 flex-1">
                    <span
                      className="text-gray-600 mr-2 cursor-pointer hover:text-[var(--accent-affirm)] transition-colors font-mono shrink-0"
                      onClick={(e) => promoteBacklogTask(e, idx)}
                      title="Promote to active tasks"
                    >
                      [ {'>'} ]
                    </span>
                    <span
                      // `group-hover` is pure CSS and knows nothing about `sel`,
                      // so arrowing onto a backlog row used to brighten nothing —
                      // the mouse got fill AND brighter text, the keyboard got
                      // only the fill. Selection now brightens it explicitly.
                      className={`min-w-0 break-words transition-colors ${
                        sel?.kind === 'backlog' && sel.index === idx
                          ? 'text-gray-300'
                          : 'text-gray-500 group-hover:text-gray-300'
                      }`}
                      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); setInputValue(task.text); setEditingNode({ kind: 'backlog', id: task.id }); inputRef.current?.focus(); }}
                    >
                      {task.text}
                    </span>
                    {task.createdAt !== undefined && ageDays(task.createdAt) >= 1 && (
                      <span
                        className={`ml-2 shrink-0 text-[10px] self-center ${
                          ageDays(task.createdAt) >= 14 ? 'text-[var(--accent-edit-dim)]/80' : 'text-gray-600'
                        }`}
                        title={`In backlog for ${ageDays(task.createdAt)} days`}
                      >
                        ·{ageDays(task.createdAt)}d
                      </span>
                    )}
                  </div>
                  <div className="absolute right-0 top-1 opacity-0 group-hover:opacity-100 transition-opacity font-mono group/pill">
                  <span className="flex items-center text-gray-500 bg-black/70 backdrop-blur-[2px] rounded-sm px-1 select-none cursor-default group-hover/pill:hidden">[ ⋯ ]</span>
                  <div className="hidden group-hover/pill:flex items-center text-gray-600 bg-black/85 backdrop-blur-[2px] rounded-sm px-1">
                    <span
                      className={`mr-2 cursor-pointer transition-colors ${sel?.kind === 'backlog' && sel.index === idx ? 'text-[var(--theme-color)]' : 'hover:text-[var(--theme-color)]'}`}
                      title="Move up (Alt+↑ / Alt+wheel)"
                      onClick={(e) => { e.stopPropagation(); nudgeRow('backlog', idx, -1); }}
                    >[ ^ ]</span>
                    <span
                      className={`mr-2 cursor-pointer transition-colors ${sel?.kind === 'backlog' && sel.index === idx ? 'text-[var(--theme-color)]' : 'hover:text-[var(--theme-color)]'}`}
                      title="Move down (Alt+↓ / Alt+wheel)"
                      onClick={(e) => { e.stopPropagation(); nudgeRow('backlog', idx, 1); }}
                    >[ v ]</span>
                    <span
                      className="cursor-pointer hover:text-[var(--accent-danger)] transition-colors"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Land the selection the way the keyboard twin
                        // (Backspace on a backlog row) does: the slot the
                        // deleted item vacated, else the one above, else
                        // nothing. Id-anchoring already prevents the old
                        // wrong-row highlight; this is the missing parity.
                        dispatch({ backlog: backlogRef.current.filter((_, i) => i !== idx) });
                        const maxIdx = backlogRef.current.length - 1;
                        const at = idx > maxIdx ? maxIdx : idx;
                        setSel(at >= 0 ? { kind: 'backlog', index: at } : null);
                      }}
                    >[ x ]</span>
                  </div>
                  </div>
                </div>
                </React.Fragment>
              ))}
            </div>
            )}
            {ghostOverlay()}
          </div>

          <div className="border-t border-[var(--theme-color)]/20 shrink-0 transition-colors duration-1000" />

          <form
            onSubmit={handleSubmit}
            className="shrink-0 px-4 py-2 border-t border-[var(--theme-color)]/20 flex items-center relative transition-colors duration-1000"
          >
            {showHint && inputValue.startsWith('/') && (
              <div className="absolute bottom-full left-0 mb-2 w-full bg-[#111]/95 border border-[var(--theme-color)]/20 rounded-md p-1 shadow-xl z-50 backdrop-blur-md">
                {COMMANDS.filter(c => c.cmd.startsWith(inputValue.split(' ')[0])).map((cmd, idx) => (
                  <div key={idx} className="flex justify-between items-center px-3 py-2 text-sm hover:bg-white/5 cursor-pointer"
                    onMouseDown={(e) => {
                      // use mousedown (not click) so the input never loses focus
                      e.preventDefault();
                      setInputValue(cmd.usage.includes('<') ? cmd.cmd + ' ' : cmd.cmd);
                      inputRef.current?.focus();
                    }}
                  >
                    <div className="flex space-x-3">
                      <span className="font-bold text-[var(--theme-color)] transition-colors">{cmd.cmd}</span>
                      <span className="opacity-50 text-xs text-white font-mono">{cmd.usage}</span>
                    </div>
                    <span className="opacity-40 text-xs text-white">{cmd.desc}</span>
                  </div>
                ))}
                {COMMANDS.filter(c => c.cmd.startsWith(inputValue.split(' ')[0])).length === 0 && (
                  <div className="px-3 py-2 text-sm text-white opacity-40 font-mono">Command not found...</div>
                )}
              </div>
            )}
            <span className={`mr-2 font-bold transition-colors duration-300 shrink-0 ${
              editingNode ? 'text-[var(--accent-edit)]' : subEntryTarget !== null ? 'text-[var(--accent-action)]' : 'text-[var(--theme-color)]'
            }`}>
              {/* The label shows the target's live PATH (`sub#2.1>`), resolved
                  from its id — so it renumbers itself when rows above move. */}
              {editingNode ? 'edit>' : subEntryTarget !== null ? (subEntryPath ? `sub#${subEntryPath.map(n => n + 1).join('.')}>` : 'sub>') : '>'}
            </span>
            <div className="relative flex-1 min-w-0">
              {ghost && (
                <div className="absolute inset-0 flex items-center pointer-events-none whitespace-pre" aria-hidden="true">
                  <span className="invisible">{inputValue}</span>
                  <span className="opacity-40 text-[var(--theme-color)]">{ghost}</span>
                  <span className="ml-3 text-[10px] opacity-30 text-[var(--theme-color)] tracking-tight">[→]</span>
                </div>
              )}
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  setIsTyping(true);
                  if (blurTimeoutRef.current) {
                    clearTimeout(blurTimeoutRef.current);
                    blurTimeoutRef.current = null;
                  }
                }}
                onBlur={() => {
                  // Small grace period so refocusing (e.g. clicking a task) doesn't
                  // flip isTyping; without this, isTyping stayed true forever and
                  // mouse-leave auto-collapse silently stopped working.
                  blurTimeoutRef.current = setTimeout(() => setIsTyping(false), 150);
                }}
                className={`w-full bg-transparent text-gray-200 focus:outline-none placeholder:opacity-30 ${
                  editingNode ? 'caret-[var(--accent-edit)] placeholder-[var(--accent-edit)]' : subEntryTarget !== null ? 'caret-[var(--accent-action)] placeholder-[var(--accent-action)]' : 'caret-[var(--theme-color)] placeholder-[var(--theme-color)]'
                }`}
                placeholder={
                  editingNode ? 'edit text · Enter saves · Esc cancels'
                  : subEntryTarget !== null ? 'subtask · Enter chains · Esc done'
                  : 'new task · "/" commands'
                }
                autoFocus
              />
            </div>
          </form>

          {showHelp && (
            <div
              className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex flex-col animate-modal-in"
              onClick={() => setShowHelp(false)}
            >
              <div
                className="m-3 flex-1 min-h-0 flex flex-col bg-[#0c0c0c]/95 rounded-md"
                style={{
                  border: `1px solid color-mix(in srgb, var(--theme-color) 40%, transparent)`,
                  boxShadow: `0 0 20px color-mix(in srgb, var(--theme-color) 15%, transparent)`,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 h-9 border-b border-[var(--theme-color)]/20 shrink-0 select-none">
                  <span className="text-[var(--theme-color)] font-bold text-xs tracking-widest">» SYSTEM MANUAL</span>
                  <span
                    className="cursor-pointer text-gray-500 hover:text-[var(--accent-danger)] font-mono"
                    onClick={() => setShowHelp(false)}
                  >[ x ]</span>
                </div>

                <div className="flex gap-1 px-2 py-2 border-b border-[var(--theme-color)]/10 shrink-0 select-none">
                  {([['keys', '1:KEYS'], ['mouse', '2:MOUSE'], ['cmds', '3:CMDS'], ['log', '4:LOG'], ['about', '5:ABOUT']] as const).map(([id, label]) => (
                    <button
                      key={id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setHelpTab(id)}
                      className={`px-2 py-1 text-[11px] font-mono rounded-sm border transition-colors ${
                        helpTab === id
                          ? 'border-[var(--theme-color)]/60 text-[var(--theme-color)] bg-[color-mix(in_srgb,var(--theme-color)_12%,transparent)]'
                          : 'border-transparent text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 text-sm font-mono">
                  {helpTab === 'keys' && (
                    <div className="space-y-3 text-gray-400">
                      {([
                        ['NAVIGATE', [
                          ['↑ / ↓', 'Through every row: tasks, children & backlog'],
                          ['Esc', 'Cancel mode / deselect / minimize'],
                          [displayShortcut(hotkey), 'Global show / hide'],
                        ]],
                        ['EDIT', [
                          ['Enter', 'Edit selected item'],
                          ['Space', 'Toggle complete / promote backlog'],
                          ['>', 'Add a child to the selected row (rapid entry)'],
                          ['Bksp / Del', 'Delete selected item'],
                          ['Ctrl+Z', 'Undo · tasks, backlog & rituals together (20 steps)'],
                        ]],
                        ['ORGANIZE', [
                          ['Alt+↑/↓', 'Reorder among siblings (mouse: carets / Alt+wheel)'],
                          ['Tab / Sft+Tab', 'Demote / promote — the subtree moves intact'],
                          ['Depth', `Max ${MAX_DEPTH} levels · deeper is refused with a notice`],
                        ]],
                      ] as const).map(([sec, rows]) => (
                        <div key={sec}>
                          <div className="text-[var(--theme-color)] font-bold mb-1 tracking-widest text-xs">» [ {sec} ]</div>
                          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 gap-y-1.5 break-words">
                            {rows.map(([k, d]) => (
                              <React.Fragment key={k}>
                                <div className="text-gray-300 font-bold">{k}</div><div>{d}</div>
                              </React.Fragment>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {helpTab === 'mouse' && (
                    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 gap-y-1.5 break-words text-gray-400">
                      {([
                        ['Hover', 'Sync focus · [ ⋯ ] chip appears at right'],
                        ['[ ⋯ ]', 'Hover it to expand the action buttons'],
                        ['Click text', 'Toggle complete'],
                        ['Dbl-click', 'Edit that item'],
                        ['[ ^ ][ v ]', 'Move row — ghost previews, then lands · Esc aborts'],
                        ['Alt+wheel', 'Reorder hovered row among its siblings'],
                        ['[ + ]', 'Add a child under that row'],
                        ['[ » ] [ « ]', 'Demote / promote — the subtree moves intact'],
                        ['[ x ]', 'Delete item'],
                        ['Missing btn', `An action illegal here is hidden (${MAX_DEPTH}-level cap, first row)`],
                        ['Depth cues', 'Indent + the left rule · [1] top, [ ] level 2, [·] level 3'],
                        ['[ > ]', 'Promote (backlog only)'],
                        ['Drag ball', 'Reposition widget'],
                        ['Tray icon', 'Left-click toggles · right-click menu'],
                      ] as const).map(([k, d]) => (
                        <React.Fragment key={k}>
                          <div className="text-gray-300 font-bold">{k}</div><div>{d}</div>
                        </React.Fragment>
                      ))}
                    </div>
                  )}

                  {helpTab === 'cmds' && (
                    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-2 gap-y-1.5 break-words text-gray-400">
                      {COMMANDS.map((c) => (
                        <React.Fragment key={c.cmd}>
                          <div className="text-gray-300 font-bold">{c.usage}</div><div>{c.desc}</div>
                        </React.Fragment>
                      ))}
                      <div className="text-gray-300 font-bold">&gt; or - &lt;msg&gt;</div><div>Add child · selected row, else last task</div>
                      <div className="text-gray-300 font-bold">→ / Tab</div><div>Accept ghost autocomplete</div>
                    </div>
                  )}

                  {helpTab === 'log' && (
                    <div className="space-y-4 text-gray-400">
                      <div className="text-[var(--theme-color)]">
                        STREAK: [{'█'.repeat(Math.min(streak, 10)).padEnd(10, '░')}] {streak}d
                        {streak === 0 && <span className="text-gray-600"> — complete a task to start one</span>}
                      </div>

                      <div>
                        <div className="text-[var(--theme-color)] font-bold mb-1 tracking-widest text-xs">» [ LAST 7 DAYS ]</div>
                        {weekStats.done === 0 ? (
                          <div className="opacity-50 italic">No archived completions this week yet.</div>
                        ) : (
                          <div>
                            {weekStats.done} done · {weekStats.days} active day{weekStats.days === 1 ? '' : 's'} · best {weekStats.bestDay} ({weekStats.bestN})
                            <span className="text-gray-600"> · today: {completed} so far</span>
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="text-[var(--theme-color)] font-bold mb-1 tracking-widest text-xs">» [ DAILY RITUALS ]</div>
                        {dailyTemplates.length === 0 && (
                          <div className="opacity-50 italic">None — add with /daily &lt;text&gt;, reseeds every morning.</div>
                        )}
                        {dailyTemplates.map((t, i) => (
                          <div key={i} className="flex items-start justify-between group py-0.5">
                            <span className="min-w-0 break-words">↻ {t}</span>
                            <span
                              className="cursor-pointer text-gray-600 hover:text-[var(--accent-danger)] shrink-0 ml-2"
                              onClick={() => dispatch({ daily: dailyRef.current.filter((_, j) => j !== i) })}
                            >[ x ]</span>
                          </div>
                        ))}
                      </div>

                      <div>
                        <div className="text-[var(--theme-color)] font-bold mb-1 tracking-widest text-xs">» [ HISTORY · LAST 14 DAYS ]</div>
                        {recentLogs.length === 0 && (
                          <div className="opacity-50 italic">No archived days yet — history appears after the first day rollover.</div>
                        )}
                        {recentLogs.map((entry: any, i: number) => (
                          <div key={i} className="mb-2">
                            <div className="text-gray-300">
                              {entry.date} <span className="text-gray-600">· {entry.tasks?.length ?? 0} done</span>
                            </div>
                            {(entry.tasks ?? []).map((t: Task) => (
                              <div key={t.id} className="ml-3 text-gray-500 break-words">[x] {t.text}</div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {helpTab === 'about' && (
                    <div className="space-y-3 text-gray-400">
                      <div>
                        <span className="text-[var(--theme-color)] font-bold">TERMINAL TASK</span>
                        <span className="text-gray-600"> v{__APP_VERSION__}</span>
                      </div>
                      <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1.5 break-words">
                        <div className="text-gray-300 font-bold">Hotkey</div>
                        <div>{displayShortcut(hotkey)}{hotkey === 'Alt+X' && <span className="text-gray-600"> (default)</span>} <span className="text-gray-600">— rebind with /shortcut</span></div>
                        <div className="text-gray-300 font-bold">Deadline</div>
                        <div>One-time, today only — /deadline HH:MM, auto-clears at day rollover</div>
                        <div className="text-gray-300 font-bold">Backlog</div>
                        <div>Persists across days (never auto-cleared) · items age with ·Nd tags · ⌁ surfaces the oldest 7d+ item once daily · amber warning at 14d+</div>
                        <div className="text-gray-300 font-bold">Storage</div><div>Local only — mirrored to Documents/TerminalTasks/state.json</div>
                        <div className="text-gray-300 font-bold">Daily log</div><div>Documents/TerminalTasks/*.md (auto-archived at day change)</div>
                        <div className="text-gray-300 font-bold">Startup</div>
                        <div>{autostartOn === null
                          ? <span className="text-gray-500">unavailable on this system</span>
                          : autostartOn
                          ? <>Launches at login <span className="text-gray-600">(default) — /startup off to disable</span></>
                          : <>Does not launch at login <span className="text-gray-600">— /startup on to enable</span></>}</div>
                        <div className="text-gray-300 font-bold">Theme</div><div>/theme {PRESET_NAMES.join(' · ')} · glow ramps over the 2h before the deadline (/theme ramp off)</div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="px-4 py-1.5 border-t border-[var(--theme-color)]/10 text-[10px] text-gray-600 shrink-0 select-none">
                  ← → or 1-5 switch tabs · Esc / Enter close
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
