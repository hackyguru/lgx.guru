"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AppState, ButtonAction, ButtonNode, CallModuleArg, CoreMethod, CoreModuleSpec,
  CoreStateField, FrameNode, ImageFit, ImageNode, LeafNode, ListDirection,
  ModuleId, ModuleParam, ModuleSpec, Node, NodeId, NodeKind, PageData, PageId,
  ParamType, SetVariableMode, TextNode, Trigger, TriggerId, TriggerKind,
  Variable, VariableId, VariableType,
  defaultNode, defaultStyle, isContainer, newApp, newCoreMethod, newCoreModule,
  newCoreStateField, newId, newPage, newRoot, newTrigger, newVariable,
} from "./types";
import { MODULE_CATALOG, findModuleSpec, findModuleMethod } from "./modules/catalog";
import { emitMainQml, usesDelivery } from "./qmlEmit";
import { computeUiDeps } from "./lib/uiDeps";
import { exportLgx, placeholderIcon } from "./lgxExport";
import { readLgx } from "./lgxImport";
import { TEMPLATES, Template } from "./templates";
import { generateCoreModuleFiles } from "./codegen/coreModule";
import { packTarGz } from "./codegen/sourceBundle";
import {
  emptySettings,
  isGitHubConfigured,
  probeGitHubAccess,
  readGitHubSettings,
  writeGitHubSettings,
  type GitHubSettings,
} from "./lib/githubSettings";
import { readAISettings, settingsToRequestAuth } from "./lib/aiSettings";
import { pushAndBuild, type BuildPhase } from "./lib/githubBuilder";
import { ModuleDetailModal, ModuleInfo } from "./ModuleDetailModal";
import { AskAIModal, AIHistoryEntry } from "./AskAIModal";
import { RendererStatus, useRendererStatus } from "./RendererStatus";
import {
  getProjectMeta, getProjectState, renameProject, saveProjectState,
  type ProjectMeta,
} from "./lib/projects";
import { suggestKickoffMethod, wireLiveData, type LiveDataSpec } from "./lib/wireLiveData";
import { Sun, Moon, CircleHalf, Trash, Code } from "@phosphor-icons/react";

// Renderer iframe URL — same-origin static files. Next.js serves them
// from `web/public/renderer/` with the COOP/COEP headers configured in
// next.config.ts (required for Qt-WASM's SharedArrayBuffer use).
//
// Override via env for local renderer-source iteration:
//   NEXT_PUBLIC_RENDERER_URL=http://127.0.0.1:8765/index.html  pnpm dev
// (pair with `python3 renderer/serve.py 8765` to serve the build dir
// directly without copying via `pnpm sync-renderer`.)
const RENDERER_URL =
  process.env.NEXT_PUBLIC_RENDERER_URL ?? "/renderer/index.html";

interface PaletteItem { kind: NodeKind; label: string }
interface PaletteCategory { name: string; items: PaletteItem[] }

const PALETTE: PaletteCategory[] = [
  {
    name: "Layout",
    items: [
      { kind: "Frame",     label: "Frame" },
      { kind: "Rectangle", label: "Rectangle" },
    ],
  },
  {
    name: "Display",
    items: [
      { kind: "Text",          label: "Text" },
      { kind: "Button",        label: "Button" },
      { kind: "ProgressBar",   label: "Progress bar" },
      { kind: "BusyIndicator", label: "Busy indicator" },
    ],
  },
  {
    name: "Inputs",
    items: [
      { kind: "TextField",   label: "Text field" },
      { kind: "TextArea",    label: "Text area" },
      { kind: "CheckBox",    label: "Checkbox" },
      { kind: "RadioButton", label: "Radio button" },
      { kind: "Switch",      label: "Switch" },
      { kind: "Slider",      label: "Slider" },
      { kind: "SpinBox",     label: "SpinBox" },
      { kind: "ComboBox",    label: "ComboBox" },
    ],
  },
  {
    name: "Media",
    items: [
      { kind: "Image",         label: "Image" },
      { kind: "AnimatedImage", label: "Animated image" },
    ],
  },
  {
    name: "Data",
    items: [
      { kind: "List", label: "List" },
    ],
  },
];

const HISTORY_LIMIT = 50;
const MIN_SIZE = 16;
const NUDGE = 1;
const NUDGE_BIG = 10;

// ── Tree helpers ────────────────────────────────────────────────────────────

function findNode(root: FrameNode, id: NodeId): {
  node: Node | null;
  parent: FrameNode | null;
  index: number;
} {
  if (id === root.id) return { node: root, parent: null, index: -1 };
  const stack: FrameNode[] = [root];
  while (stack.length) {
    const parent = stack.pop()!;
    for (let i = 0; i < parent.children.length; i++) {
      const c = parent.children[i];
      if (c.id === id) return { node: c, parent, index: i };
      if (isContainer(c)) stack.push(c);
    }
  }
  return { node: null, parent: null, index: -1 };
}

function mutateTree(root: FrameNode, fn: (clone: FrameNode) => void): FrameNode {
  const clone = JSON.parse(JSON.stringify(root)) as FrameNode;
  fn(clone);
  return clone;
}

// True if `descendantId` is `ancestorId` itself or anywhere in its subtree.
function isSelfOrDescendant(root: FrameNode, ancestorId: NodeId, descendantId: NodeId): boolean {
  if (ancestorId === descendantId) return true;
  const { node } = findNode(root, ancestorId);
  if (!node || !isContainer(node)) return false;
  const stack: Node[] = [...node.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === descendantId) return true;
    if (isContainer(n)) stack.push(...n.children);
  }
  return false;
}

// Recursively assign fresh ids — used when duplicating a subtree.
function reassignIds<T extends Node>(node: T): T {
  const cloned = { ...node, id: newId() };
  if (cloned.kind === "Frame") {
    cloned.children = cloned.children.map((c) => reassignIds(c));
  }
  return cloned;
}

// Absolute canvas-coord rect for a node (sums ancestor offsets).
function absoluteRect(root: FrameNode, id: NodeId): { x: number; y: number; w: number; h: number } | null {
  let x = 0, y = 0;
  const path: FrameNode[] = [];
  const find = (n: Node, parents: FrameNode[]): boolean => {
    if (n.id === id) {
      for (const p of parents) { x += p.x; y += p.y; }
      x += n.x; y += n.y;
      return true;
    }
    if (isContainer(n)) {
      for (const c of n.children) {
        if (find(c, [...parents, n])) return true;
      }
    }
    return false;
  };
  if (!find(root, path)) return null;
  const { node } = findNode(root, id);
  if (!node) return null;
  return { x, y, w: node.width, h: node.height };
}

// All visible nodes (excluding root) whose absolute rect overlaps the given
// canvas-coord rectangle. Used for marquee selection.
function nodesIntersecting(root: FrameNode, x1: number, y1: number, x2: number, y2: number): NodeId[] {
  const hits: NodeId[] = [];
  const visit = (n: Node, ax: number, ay: number) => {
    const nx = ax + n.x;
    const ny = ay + n.y;
    if (n.id !== root.id && !n.hidden) {
      const overlaps = !(x2 < nx || x1 > nx + n.width || y2 < ny || y1 > ny + n.height);
      if (overlaps) hits.push(n.id);
    }
    if (isContainer(n)) {
      for (const c of n.children) visit(c, nx, ny);
    }
  };
  visit(root, 0, 0);
  return hits;
}

// ── Snap to siblings + parent edges during drag ─────────────────────────────
//
// Returns the (dx, dy) deltas adjusted to snap, plus any guide lines to
// draw. Snap targets per axis: parent left/center/right (top/center/bottom
// for Y), and each sibling's left/center/right (top/center/bottom for Y).
// Snap is per-axis: pick the closest target within SNAP_THRESHOLD for each
// dragged edge (left/center/right) and adjust by the difference.
//
// Single-node drag only — multi-node snap with bounding-box semantics is
// follow-up work.

const SNAP_THRESHOLD = 4;

export type GuideLine =
  | { kind: "v"; x: number; y1: number; y2: number }
  | { kind: "h"; y: number; x1: number; x2: number };

interface SnapResult {
  dx: number;
  dy: number;
  guides: GuideLine[];
}

function snapDrag(
  baseRoot: FrameNode,
  draggedId: NodeId,
  dx: number,
  dy: number,
): SnapResult {
  const found = findNode(baseRoot, draggedId);
  if (!found.node || !found.parent) return { dx, dy, guides: [] };
  const node = found.node;
  const parent = found.parent;
  const newX = node.x + dx;
  const newY = node.y + dy;

  const xCands: number[] = [0, parent.width / 2, parent.width];
  const yCands: number[] = [0, parent.height / 2, parent.height];
  for (const sib of parent.children) {
    if (sib.id === draggedId) continue;
    if (sib.hidden) continue;
    xCands.push(sib.x, sib.x + sib.width / 2, sib.x + sib.width);
    yCands.push(sib.y, sib.y + sib.height / 2, sib.y + sib.height);
  }
  const draggedX = [newX, newX + node.width / 2, newX + node.width];
  const draggedY = [newY, newY + node.height / 2, newY + node.height];

  const findBest = (cands: number[], edges: number[]) => {
    let bestAdjust = 0, bestDist = SNAP_THRESHOLD + 1, bestLine = NaN;
    for (const c of cands) {
      for (const e of edges) {
        const d = Math.abs(c - e);
        if (d <= SNAP_THRESHOLD && d < bestDist) {
          bestDist = d; bestAdjust = c - e; bestLine = c;
        }
      }
    }
    return Number.isNaN(bestLine) ? null : { adjust: bestAdjust, line: bestLine };
  };
  const x = findBest(xCands, draggedX);
  const y = findBest(yCands, draggedY);

  const parentAbs = absoluteRect(baseRoot, parent.id) ?? { x: 0, y: 0, w: parent.width, h: parent.height };
  const guides: GuideLine[] = [];
  if (x) guides.push({ kind: "v", x: parentAbs.x + x.line, y1: parentAbs.y, y2: parentAbs.y + parent.height });
  if (y) guides.push({ kind: "h", y: parentAbs.y + y.line, x1: parentAbs.x, x2: parentAbs.x + parent.width });

  return { dx: dx + (x?.adjust ?? 0), dy: dy + (y?.adjust ?? 0), guides };
}

// ── History reducer (operates on the whole AppState, not a single root) ────

interface HistoryState {
  app: AppState;
  past: AppState[];
  future: AppState[];
}

type Action =
  | { type: "snapshot" }                  // push current app to past, clear future
  | { type: "set"; app: AppState }        // replace app with no history change
  | { type: "commit"; app: AppState }     // snapshot + set in one shot
  // Resize every page's root to match the iframe's current dimensions.
  // Reads state.app inside the reducer so it ALWAYS uses the freshest app
  // — fixes a bug where iframe-sync dispatched with `...appRef.current`
  // before hydration's dispatch had been observed, overwriting the
  // hydrated saved state with a default empty app.
  | { type: "resizeAllRoots"; width: number; height: number }
  | { type: "undo" }
  | { type: "redo" };

function reducer(state: HistoryState, action: Action): HistoryState {
  switch (action.type) {
    case "snapshot":
      return {
        ...state,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.app],
        future: [],
      };
    case "set":
      return { ...state, app: action.app };
    case "commit":
      return {
        app: action.app,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.app],
        future: [],
      };
    case "resizeAllRoots": {
      const { width, height } = action;
      // Bail if every root already matches — avoids a re-render on
      // ResizeObserver firings that bring no real change.
      const allMatch = state.app.pages.every(
        (p) => p.root.width === width && p.root.height === height,
      );
      if (allMatch) return state;
      return {
        ...state,
        app: {
          ...state.app,
          pages: state.app.pages.map((p) => ({
            ...p,
            root: { ...p.root, width, height },
          })),
        },
      };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        app: prev,
        future: [...state.future, state.app],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        past: [...state.past, state.app],
        app: next,
        future: state.future.slice(0, -1),
      };
    }
  }
}

// ── Module metadata helpers (unchanged from previous iteration) ─────────────

interface ModuleMeta {
  name: string;
  version: string;
  description: string;
  category: string;
  author: string;
}

const sanitizeName = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");

const isPng = (u8: Uint8Array) =>
  u8.length >= 8 &&
  u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
  u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a;

// ── Persistence ─────────────────────────────────────────────────────────────
//
// Auto-saved to localStorage on every change (debounced) and restored on
// mount. Same shape is used for explicit Save/Open via the JSON file picker.
// Versioned so we can migrate later. iconPng is base64-encoded since
// Uint8Array doesn't survive JSON.stringify.

// SaveState versioning is for the *contents* of a single project (page tree
// migration etc.). Multi-project persistence sits one layer above this in
// lib/projects.ts — each project is its own SaveState entry.

// v2 = multi-page format. v1 = legacy single-root; migrateSave() lifts it
// to v2 by wrapping the root in a single "Home" page.
interface SaveStateV2 {
  version: 2;
  pages: PageData[];
  currentPageId: PageId;
  variables: Variable[];
  modules: ModuleId[];
  coreModule?: CoreModuleSpec;
  triggers: Trigger[];
  moduleMeta: ModuleMeta;
  iconBase64: string;
  iconFilename: string;
  collapsedIds: NodeId[];
}
interface SaveStateV1 {
  version: 1;
  root: FrameNode;
  moduleMeta: ModuleMeta;
  iconBase64: string;
  iconFilename: string;
  collapsedIds: NodeId[];
}
type SaveState = SaveStateV2;

const u8ToBase64 = (u8: Uint8Array): string => {
  let s = "";
  // chunked to avoid blowing the call stack on huge images
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  }
  return btoa(s);
};
const base64ToU8 = (s: string): Uint8Array => {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
};

// Migrate v1 (single root) to v2 (single-page app). Returns null if the
// payload is unparseable.
const migrateSave = (parsed: unknown): SaveState | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.version === 2 && Array.isArray(p.pages) && typeof p.currentPageId === "string") {
    const s = p as unknown as SaveStateV2;
    // Back-fill missing fields — older v2 saves predate variables / modules.
    return {
      ...s,
      variables: Array.isArray(s.variables) ? s.variables : [],
      modules: Array.isArray(s.modules) ? s.modules : [],
      triggers: Array.isArray(s.triggers) ? s.triggers : [],
    };
  }
  if (p.version === 1 && p.root) {
    const v1 = p as unknown as SaveStateV1;
    const home: PageData = { id: newId(), name: "Home", root: v1.root };
    return {
      version: 2,
      pages: [home],
      currentPageId: home.id,
      variables: [],
      modules: [],
      triggers: [],
      moduleMeta: v1.moduleMeta,
      iconBase64: v1.iconBase64,
      iconFilename: v1.iconFilename,
      collapsedIds: v1.collapsedIds,
    };
  }
  return null;
};

// Per-project read/write — both delegate to the projects.ts storage layer
// keyed by the active project id. The editor obtains the id from the URL
// (?project=<id>) on mount and never mutates it during the session.
const loadFromStorage = (projectId: string): SaveState | null => {
  const raw = getProjectState(projectId);
  return raw ? migrateSave(raw) : null;
};

const saveToStorage = (projectId: string, s: SaveState) => {
  saveProjectState(projectId, s);
};

// ── Page ────────────────────────────────────────────────────────────────────

export default function BuilderClient() {
  // SSR/hydration gate. The reducer below seeds AppState through newApp(),
  // which calls newId() — and newId() bakes Date.now() into every id. That
  // means the server's lazy-init AppState carries different ids than the
  // client's, so any DOM attribute derived from app state mismatches at
  // hydration time. React 19 surfaces this as the "tree hydrated but some
  // attributes ... didn't match the client" warning.
  //
  // Fix: render a deterministic placeholder until after first mount, then
  // swap in the real editor. The hooks below all still run during SSR and
  // first commit (so hook ordering stays valid), but the JSX they produce
  // isn't rendered until mounted=true — which only flips inside useEffect,
  // i.e. after hydration completes. No mismatch possible.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // First render must produce identical HTML on the server and the client
  // for hydration to succeed. We initialise from defaults and apply any
  // localStorage-restored snapshot in a post-mount effect below.
  const [hist, dispatch] = useReducer(reducer, undefined, () => ({
    app: newApp(),
    past: [],
    future: [],
  }));
  const app = hist.app;

  // Active project — the editor is always scoped to one. Read once from the
  // ?project=<id> URL param on mount; if absent or stale the user gets sent
  // to the dashboard.
  const [activeProject, setActiveProject] = useState<ProjectMeta | null>(null);
  // Active page derivation. If currentPageId points at a removed page we
  // fall back to the first page so the editor keeps working.
  const currentPage: PageData =
    app.pages.find((p) => p.id === app.currentPageId) ?? app.pages[0];
  const root = currentPage.root;

  // Build a new AppState by mutating only the active page's tree. Used by
  // every tree-edit dispatch so unrelated pages stay byte-identical.
  const mutateActivePage = (
    a: AppState,
    fn: (clone: FrameNode) => void,
  ): AppState => ({
    ...a,
    pages: a.pages.map((p) =>
      p.id === a.currentPageId ? { ...p, root: mutateTree(p.root, fn) } : p
    ),
  });

  // Renderer iframe lifecycle: capability check, load/error, timeout, retry.
  const renderer = useRendererStatus();

  const [selectedIds, setSelectedIds] = useState<Set<NodeId>>(new Set());
  // Smart-guide overlay shown only during drag.
  const [guideLines, setGuideLines] = useState<GuideLine[]>([]);
  // Marquee rectangle (canvas-local px) drawn while the user drags on the
  // canvas background. Null = no marquee in progress.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Grid snap pixel size. 0 = off; cycle through 0/8/16/24 with the header
  // button. Applied at the end of drag and resize as a delta/position round.
  const [gridSize, setGridSize] = useState(0);
  const gridSizeRef = useRef(gridSize);
  useEffect(() => { gridSizeRef.current = gridSize; }, [gridSize]);
  // In-app clipboard for Cmd+C / Cmd+V. Holds deep-cloned nodes WITH their
  // original ids; reassignIds runs at paste time so each paste produces a
  // fresh subtree even if you paste twice.
  const [clipboard, setClipboard] = useState<Node[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  // Selection helpers — most callers want one of these instead of touching
  // the Set directly. `selectSingle(null)` clears the selection.
  const selectSingle = (id: NodeId | null) =>
    setSelectedIds(id == null ? new Set() : new Set([id]));
  const toggleSelected = (id: NodeId) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  // True multi-select select-handler used by canvas + layers rows.
  const handleSelect = (id: NodeId | null, additive: boolean) => {
    if (id == null) { setSelectedIds(new Set()); return; }
    if (additive) toggleSelected(id);
    else selectSingle(id);
  };
  const [draggingKind, setDraggingKind] = useState<NodeKind | null>(null);
  // Canvas iframe — the only Qt-WASM instance. Renders the user's QML the
  // exact same way Basecamp will. Click forwarding behavior depends on
  // `runMode` (see the top-level toggle).
  const canvasIframeRef = useRef<HTMLIFrameElement>(null);
  // Run mode: false = Edit (React overlay absorbs clicks for selection &
  // drag); true = Run (overlay hides, iframe takes events, the user can
  // actually interact with their widget — click buttons, type, etc.).
  const [runMode, setRunMode] = useState(false);

  // Sidebar tab — two mode-based views so only one panel-set is visible:
  //   "design" — Pages + Components (placing widgets)
  //   "logic"  — Variables + Triggers (state + behavior, including delivery)
  // Layers stays anchored at the bottom across both tabs.
  //
  // (A "backend" tab existed previously for Networking + Build-a-module, but
  // it was empty in practice — Networking is informational, Build-a-module
  // was hidden until the no-code logic composer ships, so the tab added more
  // chrome than value.)
  type SidebarTab = "design" | "logic" | "modules";
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("design");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("lgx.sidebarTab");
    if (stored === "design" || stored === "logic" || stored === "modules") setSidebarTab(stored);
    // Migrate users who had the now-removed "backend" tab selected.
    else if (stored === "backend") setSidebarTab("modules");
  }, []);
  const switchSidebarTab = (t: SidebarTab) => {
    setSidebarTab(t);
    try { window.localStorage.setItem("lgx.sidebarTab", t); } catch {}
  };
  const canvasRef = useRef<HTMLDivElement>(null);
  const designFileInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  // Track the latest root + app in refs so async observers can read them
  // without re-binding their callbacks on every state change.
  const rootRef = useRef(root);
  const appRef = useRef(app);
  useEffect(() => { rootRef.current = root; }, [root]);
  useEffect(() => { appRef.current = app; }, [app]);

  // Auto-save the editor state to localStorage. We deliberately do NOT
  // debounce — localStorage writes are sub-millisecond and the previous
  // 400ms-debounced version had a class of races where edits made within
  // the debounce window before navigation got lost (we kept finding new
  // ones: link click, browser back, tab close, focus loss). Sync-on-every-
  // commit eliminates the race entirely.
  // firstSaveSkip suppresses the initial post-hydration write of the same
  // state we just loaded — wasteful, not incorrect.
  const firstSaveSkip = useRef(true);

  // Post-mount: hydrate from localStorage. Runs only on the client, so
  // first paint matches SSR (defaults), then we swap in the saved state.
  // The autosave effect below sees this dispatch as the "first change"
  // and skips its own write so we don't immediately rewrite what we read.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("project");
    if (!id) {
      window.location.replace("/dashboard");
      return;
    }
    const meta = getProjectMeta(id);
    if (!meta) {
      // Stale URL (e.g. project deleted from another tab). Send the user back
      // to the dashboard rather than silently spawning an orphan project.
      window.location.replace("/dashboard");
      return;
    }
    setActiveProject(meta);

    const saved = loadFromStorage(id);
    if (!saved || saved.version !== 2) return;
    if (saved.pages?.length) {
      const cur = saved.pages.find((p) => p.id === saved.currentPageId)?.id ?? saved.pages[0].id;
      dispatch({
        type: "set",
        app: {
          pages: saved.pages,
          currentPageId: cur,
          variables: saved.variables ?? [],
          modules: saved.modules ?? [],
          coreModule: saved.coreModule,
          triggers: saved.triggers ?? [],
        },
      });
    }
    if (saved.moduleMeta) setModuleMeta(saved.moduleMeta);
    if (saved.iconBase64) setIconPng(base64ToU8(saved.iconBase64));
    if (saved.iconFilename) setIconFilename(saved.iconFilename);
    if (saved.collapsedIds) setCollapsedIds(new Set(saved.collapsedIds));
  }, []);

  // The Qt-WASM renderer uses SizeRootObjectToView, so the QML root sizes to
  // whatever pixel dimensions the iframe gets from CSS layout. The canvas
  // iframe defines the "design surface" — the editor's root width/height
  // mirrors its clientRect so absolute coords match what gets exported.
  // The bottom live-preview iframe trails along by sharing the same QML.
  // We don't snapshot history for layout-driven resizes — undo shouldn't
  // step through window-resize events.
  useEffect(() => {
    const iframe = canvasIframeRef.current;
    if (!iframe) return;
    const sync = () => {
      const w = iframe.clientWidth;
      const h = iframe.clientHeight;
      if (w <= 0 || h <= 0) return;
      // CRITICAL: dispatch the dedicated resize action, not "set" with
      // appRef.current. The latter races with hydration: appRef is updated
      // by an effect that hasn't run yet during initial mount, so it still
      // points at the default empty app — and dispatching with that
      // overwrites hydration's just-loaded saved app. The reducer reads
      // state.app live, so this is race-free regardless of mount order.
      dispatch({ type: "resizeAllRoots", width: w, height: h });
    };
    const ro = new ResizeObserver(sync);
    ro.observe(iframe);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);

  // ── Theme (light / dark / follow system) ───────────────────────────────
  // The actual class flipping happens via an inline bootstrap script in
  // layout.tsx (so first paint is correct). This hook keeps state in sync
  // with later toggles and writes the preference back to localStorage.
  type ThemePref = "light" | "dark" | "system";
  const [themePref, setThemePref] = useState<ThemePref>("system");
  useEffect(() => {
    const stored = (typeof window !== "undefined" ? window.localStorage.getItem("lgx.theme") : null) as ThemePref | null;
    if (stored === "light" || stored === "dark" || stored === "system") setThemePref(stored);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const dark = themePref === "dark" || (themePref === "system" && prefersDark);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    if (themePref === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [themePref]);
  const cycleTheme = () => {
    const next: ThemePref = themePref === "light" ? "dark" : themePref === "dark" ? "system" : "light";
    setThemePref(next);
    try { window.localStorage.setItem("lgx.theme", next); } catch {}
  };

  const [moduleMeta, setModuleMeta] = useState<ModuleMeta>({
    name: "my_widget",
    version: "0.1.0",
    description: "A widget built with lgx.guru",
    category: "example",
    author: "",
  });
  const [iconPng, setIconPng] = useState<Uint8Array>(() => placeholderIcon());
  const [iconFilename, setIconFilename] = useState<string>("icon.png");
  const [iconPreviewUrl, setIconPreviewUrl] = useState<string | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);

  useEffect(() => {
    const blob = new Blob([new Uint8Array(iconPng)], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    setIconPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [iconPng]);

  const handleIconUpload = async (file: File) => {
    setIconError(null);
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (!isPng(u8)) { setIconError("Icon must be a PNG file"); return; }
    setIconPng(u8);
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    setIconFilename(safe.toLowerCase().endsWith(".png") ? safe : safe + ".png");
  };

  const [iconGenerating, setIconGenerating] = useState(false);

  const handleGenerateIcon = async () => {
    setIconError(null);
    setIconGenerating(true);
    try {
      // BYO key — same store as the Ask AI sidebar uses. Falls back to
      // server env when the user hasn't configured one (local-dev flow).
      const auth = settingsToRequestAuth(readAISettings());
      const res = await fetch("/api/generate-icon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: moduleMeta.name,
          description: moduleMeta.description,
          ...(auth ? { auth } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate icon");
      // data.image is base64 PNG
      const raw = atob(data.image);
      const u8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
      setIconPng(u8);
      setIconFilename("ai-icon.png");
    } catch (e: unknown) {
      setIconError(e instanceof Error ? e.message : "Icon generation failed");
    } finally {
      setIconGenerating(false);
    }
  };

  // Read a File as a base64 data URL.
  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });

  // Decode a data URL into an Image element so we can grab natural dims.
  const dataUrlToDims = (url: string): Promise<{ w: number; h: number }> =>
    new Promise((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error("invalid image"));
      img.src = url;
    });

  const handleImageUpload = async (
    file: File,
    opts: { x?: number; y?: number; parentId?: NodeId; replaceId?: NodeId } = {},
  ) => {
    if (!file.type.startsWith("image/")) return;
    const src = await fileToDataUrl(file);
    if (opts.replaceId) {
      // Replace the existing image's src; preserve geometry/style.
      updateNode(opts.replaceId, { src } as Partial<ImageNode>);
      return;
    }
    let width = 200, height = 120;
    try {
      const { w, h } = await dataUrlToDims(src);
      const MAX = 400;
      width = w; height = h;
      if (width > MAX) { height = Math.round(height * MAX / width); width = MAX; }
      if (height > MAX) { width = Math.round(width * MAX / height); height = MAX; }
    } catch { /* fall back to defaults */ }
    const node: ImageNode = {
      id: newId(),
      kind: "Image",
      x: opts.x ?? 40,
      y: opts.y ?? 40,
      width,
      height,
      style: defaultStyle(),
      hidden: false,
      locked: false,
      src,
      fit: "contain",
    };
    insertChild(opts.parentId ?? root.id, node);
    selectSingle(node.id);
  };

  const qmlPreview = useMemo(() => emitMainQml(app, false), [app]);
  const qmlExport = useMemo(() => emitMainQml(app, true), [app]);

  // Track the latest QML in a ref so the iframe's onLoad handler (which
  // can fire AT ANY TIME — initial load, JS-layer auto-retry, manual
  // reload) can always post the current source. Without this, after an
  // auto-retry the iframe boots, shows its built-in "Renderer ready"
  // placeholder, and the editor never reposts because qmlPreview hasn't
  // changed — so the user sees the placeholder forever.
  const qmlPreviewRef = useRef(qmlPreview);
  useEffect(() => { qmlPreviewRef.current = qmlPreview; }, [qmlPreview]);

  // Live updates: every time qmlPreview changes, push to the iframe.
  // (No-op on first render if the iframe is still booting — the iframe's
  // index.html has a pending queue that drains on Qt-WASM onLoaded.)
  useEffect(() => {
    const id = setTimeout(() => {
      console.log("[parent] posting qmlPreview-changed loadQml, length:", qmlPreview.length);
      const msg = { type: "loadQml", source: qmlPreview };
      canvasIframeRef.current?.contentWindow?.postMessage(msg, "*");
    }, 100);
    return () => clearTimeout(id);
  }, [qmlPreview]);

  // The iframe's index.html posts { type: "renderer-ready" } when Qt-WASM
  // finishes booting. That's our reliable signal — onLoad fires when HTML
  // parses, but Qt-WASM takes seconds more to boot, and posting earlier
  // races against the iframe's own pending-queue drain. Posting here
  // guarantees the renderer is alive AND the loadQml binding is wired.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type !== "renderer-ready") return;
      console.log("[parent] received renderer-ready, posting current qmlPreview, length:", qmlPreviewRef.current.length);
      // The renderer-ready ping is our ground-truth "renderer is alive"
      // signal — iframe.onLoad is unreliable in practice (sometimes
      // doesn't fire even though Qt-WASM finished booting). Flip the
      // status state machine to "ready" here too so the spinner clears.
      renderer.handleLoad();
      const msg = { type: "loadQml", source: qmlPreviewRef.current };
      canvasIframeRef.current?.contentWindow?.postMessage(msg, "*");
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Iframe-load callback. Primary signal for "iframe is ready" is the
  // renderer-ready ping above. But we ALSO post on iframe.onLoad as a
  // fallback for two cases:
  //   1. The iframe is serving an OLD cached index.html that doesn't
  //      yet send the ping (post-deploy / browser cache lag).
  //   2. The iframe successfully boots Qt-WASM but the parent's listener
  //      isn't yet attached (extremely fast boot, theoretical).
  // Posts go into the iframe's pending queue if Qt-WASM is still booting,
  // and drain on Qt-WASM's onLoaded — so this is safe even when the ping
  // path also fires; the iframe just calls loadQml twice with identical
  // source, which is idempotent.
  const handleIframeLoad = useCallback(() => {
    console.log("[parent] iframe onLoad fired");
    renderer.handleLoad();
    setTimeout(() => {
      console.log("[parent] posting onLoad-fallback loadQml, length:", qmlPreviewRef.current.length);
      const msg = { type: "loadQml", source: qmlPreviewRef.current };
      canvasIframeRef.current?.contentWindow?.postMessage(msg, "*");
    }, 50);
  }, [renderer]);

  // ── Edit ops (each one snapshots history at the right boundary) ──────────

  const updateNode = (id: NodeId, patch: Partial<Node>) => {
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        const { node } = findNode(clone, id);
        if (node) Object.assign(node, patch);
      }),
    });
  };

  const insertChild = (parentId: NodeId, child: Node) => {
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        const { node } = findNode(clone, parentId);
        if (node && isContainer(node)) node.children.push(child);
      }),
    });
  };

  // Delete every selected node (root excluded). One commit, one undo step.
  // The mutate callback re-finds each id in the live clone so indices stay
  // accurate after each splice — no need to pre-sort.
  const deleteSelected = () => {
    if (selectedIds.size === 0) return;
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        for (const id of selectedIds) {
          if (id === root.id) continue;
          const { parent, index } = findNode(clone, id);
          if (parent && index >= 0) parent.children.splice(index, 1);
        }
      }),
    });
    setSelectedIds(new Set());
  };

  // Snapshot the selection into the in-app clipboard. Deep-clones so later
  // edits to the original don't bleed into the clipboard payload.
  const copySelected = () => {
    if (selectedIds.size === 0) return;
    const cloned: Node[] = [];
    for (const id of selectedIds) {
      if (id === root.id) continue;
      const { node } = findNode(root, id);
      if (node) cloned.push(JSON.parse(JSON.stringify(node)) as Node);
    }
    if (cloned.length > 0) setClipboard(cloned);
  };

  const cutSelected = () => {
    copySelected();
    deleteSelected();
  };

  // Paste into the deepest selected Frame (or its parent), or the root if
  // nothing is selected. Each paste re-assigns ids and offsets by 12px so
  // repeated pastes stack visibly.
  const pasteFromClipboard = () => {
    if (clipboard.length === 0) return;
    let parentId: NodeId = root.id;
    const primary = selectedIds.size === 1 ? [...selectedIds][0] : null;
    if (primary) {
      const { node, parent } = findNode(root, primary);
      if (node && isContainer(node)) parentId = node.id;
      else if (parent) parentId = parent.id;
    }
    const newIds: NodeId[] = [];
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        const target = findNode(clone, parentId);
        if (!target.node || !isContainer(target.node)) return;
        for (const item of clipboard) {
          const fresh = reassignIds(item);
          fresh.x += 12; fresh.y += 12;
          target.node.children.push(fresh);
          newIds.push(fresh.id);
        }
      }),
    });
    if (newIds.length > 0) setSelectedIds(new Set(newIds));
  };

  // ── Z-order (reorder within parent's children array) ─────────────────────
  //
  // Children render painter-style: later in the array = on top in canvas
  // and emitted QML. The four ops match Wix/Figma vocabulary:
  //   bringToFront    → move to end of parent.children
  //   bringForward    → swap with the next sibling
  //   sendBackward    → swap with the previous sibling
  //   sendToBack      → move to start
  //
  // Operates on every selected node. Each op = one history entry.

  type ZOrderOp = "front" | "forward" | "backward" | "back";

  const zOrderSelected = (op: ZOrderOp) => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds].filter((id) => id !== root.id);
    if (ids.length === 0) return;
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        for (const id of ids) {
          const f = findNode(clone, id);
          if (!f.parent || f.index < 0) continue;
          const arr = f.parent.children;
          const i = f.index;
          if (op === "front") {
            const [n] = arr.splice(i, 1);
            arr.push(n);
          } else if (op === "back") {
            const [n] = arr.splice(i, 1);
            arr.unshift(n);
          } else if (op === "forward" && i < arr.length - 1) {
            [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
          } else if (op === "backward" && i > 0) {
            [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
          }
        }
      }),
    });
  };

  // ── Align + distribute (multi-select only) ───────────────────────────────
  //
  // Both operate on selected nodes that share the same parent (otherwise
  // we'd be mixing absolute and relative coords). The toolbar is only
  // shown when this precondition holds — see commonParentId below.

  type AlignOp = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";
  type DistAxis = "horizontal" | "vertical";

  const commonParentId = (): NodeId | null => {
    let p: NodeId | null = null;
    for (const id of selectedIds) {
      const f = findNode(root, id);
      if (!f.parent) return null;
      if (p === null) p = f.parent.id;
      else if (p !== f.parent.id) return null;
    }
    return p;
  };

  const alignSelected = (op: AlignOp) => {
    if (selectedIds.size < 2 || commonParentId() === null) return;
    const sel: { id: NodeId; n: Node }[] = [];
    for (const id of selectedIds) {
      const { node } = findNode(root, id);
      if (node) sel.push({ id, n: node });
    }
    if (sel.length < 2) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { n } of sel) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        for (const { id } of sel) {
          const f = findNode(clone, id);
          if (!f.node) continue;
          switch (op) {
            case "left":    f.node.x = Math.round(minX); break;
            case "right":   f.node.x = Math.round(maxX - f.node.width); break;
            case "centerX": f.node.x = Math.round(cx - f.node.width / 2); break;
            case "top":     f.node.y = Math.round(minY); break;
            case "bottom":  f.node.y = Math.round(maxY - f.node.height); break;
            case "centerY": f.node.y = Math.round(cy - f.node.height / 2); break;
          }
        }
      }),
    });
  };

  const distributeSelected = (axis: DistAxis) => {
    if (selectedIds.size < 3 || commonParentId() === null) return;
    const sel: { id: NodeId; n: Node }[] = [];
    for (const id of selectedIds) {
      const { node } = findNode(root, id);
      if (node) sel.push({ id, n: node });
    }
    if (sel.length < 3) return;
    // Sort by center on the relevant axis. Keep first + last fixed; spread
    // the middle nodes evenly between their centers.
    const centerOf = (n: Node) =>
      axis === "horizontal" ? n.x + n.width / 2 : n.y + n.height / 2;
    sel.sort((a, b) => centerOf(a.n) - centerOf(b.n));
    const firstC = centerOf(sel[0].n);
    const lastC  = centerOf(sel[sel.length - 1].n);
    const step = (lastC - firstC) / (sel.length - 1);
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        for (let i = 1; i < sel.length - 1; i++) {
          const f = findNode(clone, sel[i].id);
          if (!f.node) continue;
          const target = firstC + step * i;
          if (axis === "horizontal") {
            f.node.x = Math.round(target - f.node.width / 2);
          } else {
            f.node.y = Math.round(target - f.node.height / 2);
          }
        }
      }),
    });
  };

  // Duplicate every selected node, offset by 12px. Selects the new dups.
  const duplicateSelected = () => {
    if (selectedIds.size === 0) return;
    const newIds: NodeId[] = [];
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        for (const id of selectedIds) {
          if (id === root.id) continue;
          const { node, parent, index } = findNode(clone, id);
          if (!node || !parent || index < 0) continue;
          const dup = reassignIds(node);
          dup.x += 12; dup.y += 12;
          parent.children.splice(index + 1, 0, dup);
          newIds.push(dup.id);
        }
      }),
    });
    if (newIds.length > 0) setSelectedIds(new Set(newIds));
  };

  // Move an existing node to a new parent + index. Used by the layers
  // panel for reorder / reparent. Guards against creating cycles
  // (dropping a Frame onto its own descendant).
  const moveNode = (sourceId: NodeId, newParentId: NodeId, newIndex: number) => {
    if (sourceId === root.id) return;
    if (isSelfOrDescendant(root, sourceId, newParentId)) return;
    dispatch({
      type: "commit",
      app: mutateActivePage(app, (clone) => {
        const src = findNode(clone, sourceId);
        if (!src.node || !src.parent || src.index < 0) return;
        const node = src.node;
        const fromParent = src.parent;
        const fromIndex = src.index;
        const tgt = findNode(clone, newParentId);
        if (!tgt.node || !isContainer(tgt.node)) return;
        // Detach.
        fromParent.children.splice(fromIndex, 1);
        // Adjust insertion index if moving downward in the same parent
        // (after the removal the indices shifted).
        let idx = newIndex;
        if (fromParent.id === tgt.node.id && fromIndex < newIndex) idx -= 1;
        idx = Math.max(0, Math.min(idx, tgt.node.children.length));
        tgt.node.children.splice(idx, 0, node);
      }),
    });
  };

  const toggleHidden = (id: NodeId) => {
    const { node } = findNode(root, id);
    if (node) updateNode(id, { hidden: !node.hidden });
  };
  const toggleLocked = (id: NodeId) => {
    const { node } = findNode(root, id);
    if (node) updateNode(id, { locked: !node.locked });
  };

  // Layers-panel UI state — which Frame ids are collapsed (children hidden
  // in the tree). Independent of node.hidden.
  const [collapsedIds, setCollapsedIds] = useState<Set<NodeId>>(new Set());
  const toggleCollapsed = (id: NodeId) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Synchronous autosave. Runs after every state change. Idempotent (same
  // state → same write); cheap (localStorage is sync, sub-ms for our
  // sizes); race-free (no debounce → no in-flight save to lose on nav).
  useEffect(() => {
    if (!activeProject) return;
    if (firstSaveSkip.current) { firstSaveSkip.current = false; return; }
    saveToStorage(activeProject.id, buildSaveState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, moduleMeta, iconPng, iconFilename, collapsedIds, activeProject]);

  // Latest-state ref — populated INLINE during render (a documented React
  // pattern for "current-value" refs) so non-React code paths can read
  // the up-to-the-render-commit state without closure capture issues.
  // No effect timing window means a click handler bound on render N
  // always sees state N's values, never stale.
  const latestStateRef = useRef<{
    activeProject: ProjectMeta | null;
    state: SaveState;
  } | null>(null);

  // Synchronous flush — guaranteed to write the latest state. Reads from
  // the ref above (which we'll populate just before this is callable) so
  // it's immune to stale closure capture in long-lived event listeners
  // (beforeunload, pagehide, link onClick handlers).
  const flushSave = useCallback(() => {
    const latest = latestStateRef.current;
    if (!latest || !latest.activeProject) return;
    saveToStorage(latest.activeProject.id, latest.state);
  }, []);

  // Tab close / browser-back / cross-page nav — last-chance write.
  // beforeunload covers explicit closes; pagehide also fires on bfcache
  // restores (mobile Safari, some browser-back flows). Both are
  // synchronous-safe for localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => flushSave();
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
    };
  }, [flushSave]);

  // ── Save / Open / New ─────────────────────────────────────────────────────

  const buildSaveState = (): SaveState => ({
    version: 2,
    pages: app.pages,
    currentPageId: app.currentPageId,
    variables: app.variables,
    modules: app.modules,
    coreModule: app.coreModule,
    triggers: app.triggers,
    moduleMeta,
    iconBase64: u8ToBase64(iconPng),
    iconFilename,
    collapsedIds: [...collapsedIds],
  });

  // Populate the latest-state ref inline — runs every render right after
  // buildSaveState is in scope. By the time flushSave is callable from
  // any event handler, this ref is current. (Refs updated during render
  // are documented-safe in React; we're not setting state, just pointing.)
  latestStateRef.current = { activeProject, state: buildSaveState() };

  const applySaveState = (raw: unknown) => {
    const s = migrateSave(raw);
    if (!s || !s.pages?.length) return;
    const cur = s.pages.find((p) => p.id === s.currentPageId)?.id ?? s.pages[0].id;
    dispatch({
      type: "set",
      app: {
        pages: s.pages,
        currentPageId: cur,
        variables: s.variables ?? [],
        modules: s.modules ?? [],
        coreModule: s.coreModule,
        triggers: s.triggers ?? [],
      },
    });
    if (s.moduleMeta) setModuleMeta(s.moduleMeta);
    if (s.iconBase64) setIconPng(base64ToU8(s.iconBase64));
    if (s.iconFilename) setIconFilename(s.iconFilename);
    setCollapsedIds(new Set(s.collapsedIds ?? []));
    setSelectedIds(new Set());
  };

  // "Save" used to download a .json file. That conflated two concerns: the
  // primary "persist my work" action (which should just go to localStorage
  // so projects survive across sessions and show up on the dashboard), and
  // the rarer "give me a portable backup" action (download). Now Save just
  // flushes to localStorage; the download lives in Export → Download
  // project (.json). saveState gives the user a transient "Saved" tick so
  // they know the click registered, since localStorage writes are silent.
  const [saveFeedback, setSaveFeedback] = useState<"idle" | "saved">("idle");
  const handleSaveLocal = useCallback(() => {
    flushSave();
    setSaveFeedback("saved");
    window.setTimeout(() => setSaveFeedback("idle"), 1500);
  }, [flushSave]);

  // Download the current project as a portable .lgx-design.json. Wired
  // into the export modal so users can grab a backup or share their
  // project with another browser/colleague. Round-trips through Open
  // (which still imports JSON / .lgx-with-snapshot files).
  const handleDownloadDesign = () => {
    const json = JSON.stringify(buildSaveState(), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = sanitizeName(moduleMeta.name) || "design";
    a.download = `${safe}.lgx-design.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const handleOpenDesign = async (file: File) => {
    try {
      const isLgx = file.name.toLowerCase().endsWith(".lgx");
      let json: string;
      if (isLgx) {
        const { designJson } = await readLgx(file);
        if (!designJson) {
          window.alert(
            "That .lgx doesn't carry an editor snapshot — it was either built " +
            "by a different tool or pre-dates the round-trip-import feature. " +
            "Re-export from lgx.guru to get an importable file.",
          );
          return;
        }
        json = designJson;
      } else {
        json = await file.text();
      }
      applySaveState(JSON.parse(json));
    } catch (e) {
      console.error("Failed to open design", e);
      window.alert("Couldn't read that file. Open accepts .lgx-design.json or .lgx exported from this editor.");
    }
  };

  // ── Page CRUD ────────────────────────────────────────────────────────────
  //
  // Pages are the multi-page layer above the canvas. Switching is just UI
  // state (no history snapshot); add/rename/delete are committed.

  const switchPage = (id: PageId) => {
    if (!app.pages.some((p) => p.id === id)) return;
    if (id === app.currentPageId) return;
    dispatch({ type: "set", app: { ...app, currentPageId: id } });
    setSelectedIds(new Set());
  };

  const addPage = () => {
    const used = new Set(app.pages.map((p) => p.name.toLowerCase()));
    let name = `Page ${app.pages.length + 1}`;
    let n = app.pages.length + 1;
    while (used.has(name.toLowerCase())) { n++; name = `Page ${n}`; }
    const pg = newPage(name);
    // Inherit the active page's dimensions so the new page looks consistent.
    pg.root.width = root.width;
    pg.root.height = root.height;
    dispatch({
      type: "commit",
      app: { ...app, pages: [...app.pages, pg], currentPageId: pg.id },
    });
    setSelectedIds(new Set());
  };

  const renamePage = (id: PageId, name: string) => {
    const trimmed = name.trim() || "Untitled";
    dispatch({
      type: "commit",
      app: { ...app, pages: app.pages.map((p) => p.id === id ? { ...p, name: trimmed } : p) },
    });
  };

  const deletePage = (id: PageId) => {
    if (app.pages.length <= 1) return;
    if (!window.confirm("Delete this page? Its content will be lost.")) return;
    const idx = app.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const remaining = app.pages.filter((p) => p.id !== id);
    const nextCurrent = id === app.currentPageId
      ? remaining[Math.min(idx, remaining.length - 1)].id
      : app.currentPageId;
    // After delete, also rewrite any Button.onClick navigate actions that
    // pointed at the removed page back to "none".
    const cleaned = remaining.map((p) => ({
      ...p,
      root: mutateTree(p.root, (clone) => {
        const walk = (n: Node) => {
          if (n.kind === "Button" && n.onClick?.kind === "navigate" && n.onClick.pageId === id) {
            n.onClick = { kind: "none" };
          }
          if (isContainer(n)) n.children.forEach(walk);
        };
        walk(clone);
      }),
    }));
    dispatch({
      type: "commit",
      app: { ...app, pages: cleaned, currentPageId: nextCurrent },
    });
    setSelectedIds(new Set());
  };

  // ── Variables CRUD ──────────────────────────────────────────────────────
  //
  // Variables are app-level state slots. Each has a stable id (used by
  // bindings + setVariable actions), a user-edited name (sanitised at QML
  // emit time), a type, and an `initial` string (parsed by emit per type).
  //
  // Deleting a variable cleans up: any TextNode.binding pointing at it
  // becomes undefined, and any Button.onClick = setVariable on it resets
  // to none.

  // Returns the new variable's id so callers (e.g. the inline "+ new"
  // button in the setVariable action picker) can wire it up immediately
  // without a render round-trip.
  //
  // Accepts either a bare name (legacy callers in the action pickers) or a
  // full config (the New Variable modal) — the modal sets type + initial
  // up front so users don't have to inline-edit a freshly-created row.
  const addVariable = (
    input?: string | { name?: string; type?: VariableType; initial?: string },
  ): VariableId => {
    const cfg = typeof input === "string" ? { name: input } : input ?? {};
    const used = new Set(app.variables.map((v) => v.name));
    let name = cfg.name?.trim() || "var";
    if (used.has(name)) {
      let n = 1;
      while (used.has(`${name}${n}`)) n++;
      name = `${name}${n}`;
    }
    const v: Variable = {
      ...newVariable(name),
      ...(cfg.type ? { type: cfg.type } : {}),
      ...(cfg.initial !== undefined ? { initial: cfg.initial } : {}),
    };
    dispatch({
      type: "commit",
      app: { ...app, variables: [...app.variables, v] },
    });
    return v.id;
  };

  const updateVariable = (id: VariableId, patch: Partial<Variable>) => {
    dispatch({
      type: "commit",
      app: {
        ...app,
        variables: app.variables.map((v) => (v.id === id ? { ...v, ...patch } : v)),
      },
    });
  };

  const deleteVariable = (id: VariableId) => {
    if (!app.variables.some((v) => v.id === id)) return;
    if (!window.confirm("Delete this variable? Any bindings or set-variable actions referencing it will be cleared.")) return;
    const cleanedPages = app.pages.map((p) => ({
      ...p,
      root: mutateTree(p.root, (clone) => {
        const walk = (n: Node) => {
          // Text binding (display)
          if (n.kind === "Text" && n.binding === id) n.binding = undefined;
          // Two-way input bindings
          if ((n.kind === "TextField" || n.kind === "TextArea" ||
               n.kind === "Slider" || n.kind === "Switch" ||
               n.kind === "CheckBox") && n.binding === id) {
            n.binding = undefined;
          }
          // Button setVariable action targeting this var
          if (n.kind === "Button" && n.onClick?.kind === "setVariable" && n.onClick.varId === id) {
            n.onClick = { kind: "none" };
          }
          if (isContainer(n)) n.children.forEach(walk);
        };
        walk(clone);
      }),
    }));
    dispatch({
      type: "commit",
      app: {
        ...app,
        pages: cleanedPages,
        variables: app.variables.filter((v) => v.id !== id),
      },
    });
  };

  // ── Triggers (event-driven actions) ──────────────────────────────────────
  //
  // Each trigger fires actions in response to either app load (`appStart`)
  // or a module event (`moduleEvent`). Actions are the same union we use
  // for Button.onClick. When a trigger has multiple actions they run
  // sequentially.

  // Accepts either a bare kind (legacy callers) or a full config (the New
  // Trigger modal) so users can fill in topic / interval / event up front.
  const addTrigger = (
    input: TriggerKind | {
      kind: TriggerKind;
      intervalMs?: number;
      topic?: string;
      moduleId?: string;
      eventName?: string;
    },
  ) => {
    const cfg = typeof input === "string" ? { kind: input } : input;
    const t = newTrigger(cfg.kind);
    let extraVars: Variable[] = [];
    if (cfg.kind === "moduleEvent") {
      if (cfg.moduleId) t.moduleId = cfg.moduleId;
      if (cfg.eventName) t.eventName = cfg.eventName;
      // Default to the first enabled module + its first event so the
      // dropdowns aren't blank when the modal didn't pre-pick something.
      if (!t.moduleId || !t.eventName) {
        const mod = app.modules.map(findModuleSpec).find((m) => m && (m.events?.length ?? 0) > 0);
        if (mod) {
          if (!t.moduleId) t.moduleId = mod.id;
          if (!t.eventName) t.eventName = mod.events?.[0]?.name;
        }
      }
    } else if (cfg.kind === "onMessageReceived") {
      // Sensible default topic so the editor renders something readable;
      // the user is expected to overwrite this with their app's topic.
      t.topic = cfg.topic?.trim() || "/myapp/1/messages/json";
      // Pre-populate a working setup so a fresh onMessageReceived trigger
      // already does something instead of being a hollow shell. Auto-create
      // a `lastMessage` variable + a default action that captures the
      // incoming payload into it. User can bind a Text widget to it and
      // immediately see receives; rename / delete from there.
      const v: Variable = { id: newId(), name: "lastMessage", type: "string", initial: "(none yet)" };
      extraVars = [v];
      t.actions = [
        { kind: "setVariable", varId: v.id, value: "payload", mode: "expression" } as ButtonAction,
      ];
    } else if (cfg.kind === "interval") {
      // 1s default cadence — slow enough that an empty trigger isn't a
      // CPU drain, fast enough that a stopwatch-style display feels alive.
      t.intervalMs = cfg.intervalMs && cfg.intervalMs > 0 ? cfg.intervalMs : 1000;
    }
    dispatch({
      type: "commit",
      app: {
        ...app,
        variables: [...app.variables, ...extraVars],
        triggers: [...app.triggers, t],
      },
    });
  };
  const updateTrigger = (id: TriggerId, patch: Partial<Trigger>) => {
    dispatch({
      type: "commit",
      app: { ...app, triggers: app.triggers.map((t) => t.id === id ? { ...t, ...patch } : t) },
    });
  };
  const deleteTrigger = (id: TriggerId) => {
    dispatch({
      type: "commit",
      app: { ...app, triggers: app.triggers.filter((t) => t.id !== id) },
    });
  };
  const addTriggerAction = (id: TriggerId) => {
    const t = app.triggers.find((tt) => tt.id === id);
    if (!t) return;
    updateTrigger(id, { actions: [...t.actions, { kind: "none" }] });
  };
  const updateTriggerAction = (id: TriggerId, idx: number, action: ButtonAction) => {
    const t = app.triggers.find((tt) => tt.id === id);
    if (!t) return;
    updateTrigger(id, {
      actions: t.actions.map((a, i) => (i === idx ? action : a)),
    });
  };
  const deleteTriggerAction = (id: TriggerId, idx: number) => {
    const t = app.triggers.find((tt) => tt.id === id);
    if (!t) return;
    updateTrigger(id, { actions: t.actions.filter((_, i) => i !== idx) });
  };

  // Toggle a primitive module (e.g. "delivery_module") in the project's
  // enabled-modules list. The inspector's callModule picker reads
  // app.modules to decide which methods to surface, so this is the single
  // switch that turns module APIs on/off across the editor.
  const toggleModule = (id: ModuleId) => {
    const has = app.modules.includes(id);
    const next = has ? app.modules.filter((m) => m !== id) : [...app.modules, id];
    dispatch({ type: "commit", app: { ...app, modules: next } });
  };

  // One-shot "Show live data" wiring: creates the variable, the necessary
  // triggers (appStart + moduleEvent for events; just appStart for sync
  // methods), and updates the Text node's binding — all in one commit so
  // it's a single undo step.
  const handleWireLiveData = (spec: LiveDataSpec) => {
    dispatch({ type: "commit", app: wireLiveData(app, spec) });
  };

  // Build the read-only ModuleInfo the detail modal renders. The same modal
  // serves Logos primitives (data sourced from MODULE_CATALOG) and the
  // user's AI-built custom module (data sourced from app.coreModule).
  const showModuleDetails = (m: { id: ModuleId; label: string; description: string; available: boolean }) => {
    const isCustom = !!app.coreModule && app.coreModule.id === m.id;
    if (isCustom && app.coreModule) {
      const c = app.coreModule;
      setModuleDetail({
        id: c.id,
        name: c.name || c.id,
        description: c.description,
        available: true,
        variant: "custom",
        methods: c.methods.map((mm) => ({
          name: mm.name,
          args: mm.args.map((a) => ({ name: a.name, type: a.type, description: a.description })),
          returns: mm.returns,
          description: mm.description,
        })),
        events: (c.events ?? []).map((ev) => ({
          name: ev.name,
          data: ev.data.map((d) => ({ name: d.name, type: d.type })),
          description: ev.description,
        })),
      });
      return;
    }
    const spec = findModuleSpec(m.id);
    if (spec) {
      setModuleDetail({
        id: spec.id,
        name: spec.name,
        description: spec.description,
        available: true,
        variant: "logos",
        methods: spec.methods.map((mm) => ({
          name: mm.name,
          args: mm.args.map((a) => ({ name: a.name, type: a.type, description: a.description })),
          returns: mm.returns,
          description: mm.description,
        })),
        events: (spec.events ?? []).map((ev) => ({
          name: ev.name,
          data: ev.data.map((d) => ({ name: d.name, type: d.type })),
          description: ev.description,
        })),
      });
      return;
    }
    // Coming-soon primitive — show the panel's brief description until the
    // module ships and lands in MODULE_CATALOG with full method/event lists.
    setModuleDetail({
      id: m.id,
      name: m.label,
      description: m.description,
      available: m.available,
      variant: "logos",
      methods: [],
      events: [],
    });
  };

  // ── Core module authoring ────────────────────────────────────────────────
  //
  // The user's own backend module spec — optional. When present, its
  // methods join the inspector's callModule picker (alongside primitives)
  // and the export modal exposes a "Core source" download.

  const enableCoreModule = () => {
    if (app.coreModule) return;
    dispatch({ type: "commit", app: { ...app, coreModule: newCoreModule() } });
  };
  const disableCoreModule = () => {
    if (!app.coreModule) return;
    if (!window.confirm("Remove your core module from this project? Any Button onClick → callModule actions targeting it will reset.")) return;
    const goneId = app.coreModule.id;
    const cleanedPages = app.pages.map((p) => ({
      ...p,
      root: mutateTree(p.root, (clone) => {
        const walk = (n: Node) => {
          if (n.kind === "Button" && n.onClick?.kind === "callModule" && n.onClick.moduleId === goneId) {
            n.onClick = { kind: "none" };
          }
          if (isContainer(n)) n.children.forEach(walk);
        };
        walk(clone);
      }),
    }));
    dispatch({ type: "commit", app: { ...app, pages: cleanedPages, coreModule: undefined } });
  };
  const updateCoreModule = (patch: Partial<CoreModuleSpec>) => {
    if (!app.coreModule) return;
    dispatch({ type: "commit", app: { ...app, coreModule: { ...app.coreModule, ...patch } } });
  };
  const addCoreMethod = () => {
    if (!app.coreModule) return;
    updateCoreModule({ methods: [...app.coreModule.methods, newCoreMethod()] });
  };
  const updateCoreMethod = (idx: number, patch: Partial<CoreMethod>) => {
    if (!app.coreModule) return;
    const methods = app.coreModule.methods.map((m, i) => (i === idx ? { ...m, ...patch } : m));
    updateCoreModule({ methods });
  };
  const deleteCoreMethod = (idx: number) => {
    if (!app.coreModule) return;
    updateCoreModule({ methods: app.coreModule.methods.filter((_, i) => i !== idx) });
  };
  const toggleCoreDep = (depId: string) => {
    if (!app.coreModule) return;
    const has = app.coreModule.dependencies.includes(depId);
    updateCoreModule({
      dependencies: has
        ? app.coreModule.dependencies.filter((d) => d !== depId)
        : [...app.coreModule.dependencies, depId],
    });
  };
  const addCoreStateField = () => {
    if (!app.coreModule) return;
    updateCoreModule({ state: [...app.coreModule.state, newCoreStateField()] });
  };
  const updateCoreStateField = (idx: number, patch: Partial<CoreStateField>) => {
    if (!app.coreModule) return;
    const state = app.coreModule.state.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    updateCoreModule({ state });
  };
  const deleteCoreStateField = (idx: number) => {
    if (!app.coreModule) return;
    updateCoreModule({ state: app.coreModule.state.filter((_, i) => i !== idx) });
  };

  // Replace the current design with a built-in template. Keeps the user's
  // current icon/filename — only the canvas tree and the suggested module
  // metadata change.
  const applyTemplate = (t: Template) => {
    const built = t.build();
    // Templates produce a single page. Replace the current app with a one-
    // page app named after the template; existing pages are discarded.
    // Variables/triggers from the template overwrite when present (they're
    // wired up to the new layout); otherwise the user's existing state is
    // preserved so layout-only templates don't wipe their work.
    const home: PageData = { id: newId(), name: built.meta.name || "Home", root: built.root };
    dispatch({
      type: "commit",
      app: {
        pages: [home],
        currentPageId: home.id,
        variables: built.variables ?? app.variables,
        modules: app.modules,
        coreModule: app.coreModule,
        triggers: built.triggers ?? app.triggers,
      },
    });
    setModuleMeta((prev) => ({
      ...prev,
      name: built.meta.name,
      description: built.meta.description,
    }));
    setSelectedIds(new Set());
    setCollapsedIds(new Set());
    setTemplatesOpen(false);
  };

  // "New" lives on /dashboard now — the editor is always scoped to one
  // existing project. To start fresh, head to Projects → New project.

  // ── Marquee (rubber-band selection on empty canvas) ──────────────────────
  //
  // Pointerdown on the canvas background starts a rectangle that updates
  // selection live as it grows. Shift-down marquees ADD to the existing
  // selection; otherwise the existing selection is replaced. A pure click
  // (no drag) deselects.

  const startMarquee = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const additive = e.shiftKey || e.metaKey;
    const canvasDiv = e.currentTarget;
    const rect = canvasDiv.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    const baseSelection = additive ? new Set(selectedIds) : new Set<NodeId>();
    let moved = false;
    setMarquee({ x: x0, y: y0, w: 0, h: 0 });

    const onMove = (ev: PointerEvent) => {
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const x1 = Math.min(x0, cx), x2 = Math.max(x0, cx);
      const y1 = Math.min(y0, cy), y2 = Math.max(y0, cy);
      const w = x2 - x1, h = y2 - y1;
      if (!moved && (w > 2 || h > 2)) moved = true;
      setMarquee({ x: x1, y: y1, w, h });
      if (moved) {
        const hits = nodesIntersecting(rootRef.current, x1, y1, x2, y2);
        const next = new Set(baseSelection);
        for (const id of hits) next.add(id);
        setSelectedIds(next);
      }
    };
    const onUp = () => {
      setMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Plain click (no movement, no shift) → clear selection. With shift,
      // leave the existing selection alone.
      if (!moved && !additive) setSelectedIds(new Set());
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Drag (move) — pointer-event based, supports multi-select ─────────────
  //
  // If the grabbed node is part of the current selection, drag every selected
  // node by the same delta. Otherwise replace the selection with just this
  // node and drag it solo. Shift-click for additive selection happens in the
  // node click handler before we ever get here.

  const startMove = (e: React.PointerEvent, id: NodeId) => {
    if (e.button !== 0 || id === root.id) return;
    e.stopPropagation();

    // Decide which set of nodes participates in the drag.
    let dragIds: Set<NodeId>;
    if (selectedIds.has(id)) {
      dragIds = new Set(selectedIds);
    } else {
      dragIds = new Set([id]);
      selectSingle(id);
    }
    // The root is selectable but never draggable.
    dragIds.delete(root.id);
    if (dragIds.size === 0) return;

    const baseApp = app;
    const baseRoot = root;
    const initial = new Map<NodeId, { x: number; y: number }>();
    for (const sid of dragIds) {
      const f = findNode(baseRoot, sid);
      if (f.node) initial.set(sid, { x: f.node.x, y: f.node.y });
    }
    if (initial.size === 0) return;

    const startCx = e.clientX, startCy = e.clientY;
    let snapshotted = false;

    const onMove = (ev: PointerEvent) => {
      let dx = ev.clientX - startCx;
      let dy = ev.clientY - startCy;
      if (!snapshotted && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        dispatch({ type: "snapshot" });
        snapshotted = true;
      }
      // Snap to siblings + parent edges (single-node drags only — multi
      // would need bounding-box semantics).
      let guides: GuideLine[] = [];
      if (initial.size === 1) {
        const onlyId = [...initial.keys()][0];
        const r = snapDrag(baseRoot, onlyId, dx, dy);
        dx = r.dx;
        dy = r.dy;
        guides = r.guides;
      }
      // Snap delta to grid (preserves intra-selection spacing for multi).
      const g = gridSizeRef.current;
      if (g > 0) { dx = Math.round(dx / g) * g; dy = Math.round(dy / g) * g; }
      setGuideLines(guides);
      const nextApp = mutateActivePage(baseApp, (clone) => {
        for (const [sid, pos] of initial) {
          const f = findNode(clone, sid);
          if (f.node) {
            f.node.x = Math.round(pos.x + dx);
            f.node.y = Math.round(pos.y + dy);
          }
        }
      });
      dispatch({ type: "set", app: nextApp });
    };
    const onUp = () => {
      setGuideLines([]);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Resize — same pattern, with anchor-aware geometry ─────────────────────

  type ResizeAnchor = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

  const startResize = (e: React.PointerEvent, id: NodeId, anchor: ResizeAnchor) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const baseApp = app;
    const baseRoot = root;
    const found = findNode(baseRoot, id);
    if (!found.node) return;
    const startCx = e.clientX, startCy = e.clientY;
    const sx = found.node.x, sy = found.node.y;
    const sw = found.node.width, sh = found.node.height;
    let snapshotted = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startCx;
      const dy = ev.clientY - startCy;
      if (!snapshotted && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        dispatch({ type: "snapshot" });
        snapshotted = true;
      }
      let nx = sx, ny = sy, nw = sw, nh = sh;
      if (anchor.includes("w")) {
        nw = Math.max(MIN_SIZE, sw - dx);
        nx = sx + (sw - nw);
      }
      if (anchor.includes("e")) {
        nw = Math.max(MIN_SIZE, sw + dx);
      }
      if (anchor.includes("n")) {
        nh = Math.max(MIN_SIZE, sh - dy);
        ny = sy + (sh - nh);
      }
      if (anchor.includes("s")) {
        nh = Math.max(MIN_SIZE, sh + dy);
      }
      const g = gridSizeRef.current;
      if (g > 0) {
        nx = Math.round(nx / g) * g;
        ny = Math.round(ny / g) * g;
        nw = Math.max(MIN_SIZE, Math.round(nw / g) * g);
        nh = Math.max(MIN_SIZE, Math.round(nh / g) * g);
      }
      const nextApp = mutateActivePage(baseApp, (clone) => {
        const f = findNode(clone, id);
        if (f.node) {
          f.node.x = Math.round(nx); f.node.y = Math.round(ny);
          f.node.width = Math.round(nw); f.node.height = Math.round(nh);
        }
      });
      dispatch({ type: "set", app: nextApp });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Multi-select resize ──────────────────────────────────────────────────
  //
  // When 2+ same-parent nodes are selected, the resize handles wrap their
  // bounding box. Dragging a handle scales the bbox; each child's offset
  // and size scale proportionally so their relative layout is preserved.

  const startMultiResize = (e: React.PointerEvent, anchor: ResizeAnchor) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const baseApp = app;
    const baseRoot = root;
    const initial: { id: NodeId; x: number; y: number; width: number; height: number }[] = [];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const id of selectedIds) {
      if (id === root.id) continue;
      const { node } = findNode(baseRoot, id);
      if (!node || node.locked) continue;
      initial.push({ id, x: node.x, y: node.y, width: node.width, height: node.height });
      bx0 = Math.min(bx0, node.x);
      by0 = Math.min(by0, node.y);
      bx1 = Math.max(bx1, node.x + node.width);
      by1 = Math.max(by1, node.y + node.height);
    }
    if (initial.length < 2) return;
    const sw = bx1 - bx0, sh = by1 - by0;
    if (sw === 0 || sh === 0) return;

    const startCx = e.clientX, startCy = e.clientY;
    let snapshotted = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startCx, dy = ev.clientY - startCy;
      if (!snapshotted && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        dispatch({ type: "snapshot" });
        snapshotted = true;
      }
      let nbx = bx0, nby = by0, nbw = sw, nbh = sh;
      const minBox = MIN_SIZE;
      if (anchor.includes("w")) { nbw = Math.max(minBox, sw - dx); nbx = bx0 + (sw - nbw); }
      if (anchor.includes("e")) { nbw = Math.max(minBox, sw + dx); }
      if (anchor.includes("n")) { nbh = Math.max(minBox, sh - dy); nby = by0 + (sh - nbh); }
      if (anchor.includes("s")) { nbh = Math.max(minBox, sh + dy); }
      const g = gridSizeRef.current;
      if (g > 0) {
        nbx = Math.round(nbx / g) * g; nby = Math.round(nby / g) * g;
        nbw = Math.max(minBox, Math.round(nbw / g) * g);
        nbh = Math.max(minBox, Math.round(nbh / g) * g);
      }
      const sxR = nbw / sw, syR = nbh / sh;
      dispatch({
        type: "set",
        app: mutateActivePage(baseApp, (clone) => {
          for (const i of initial) {
            const f = findNode(clone, i.id);
            if (!f.node) continue;
            f.node.x = Math.round(nbx + (i.x - bx0) * sxR);
            f.node.y = Math.round(nby + (i.y - by0) * syR);
            f.node.width = Math.max(MIN_SIZE, Math.round(i.width * sxR));
            f.node.height = Math.max(MIN_SIZE, Math.round(i.height * syR));
          }
        }),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Bounding box of the current selection in canvas coords. Null if not a
  // multi-select-with-shared-parent (single-select uses primaryAbs instead).
  const multiBbox = (() => {
    if (selectedIds.size < 2 || commonParentId() === null) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const id of selectedIds) {
      if (id === root.id) continue;
      const r = absoluteRect(root, id);
      if (!r) continue;
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
      count++;
    }
    if (count < 2) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  })();

  // ── Drop handling: palette items or image files from the OS ──────────────

  // True if this drag carries actual files from the OS.
  const dragHasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  // Drops are gated on renderer readiness — without the live preview it's
  // confusing for users to drop a node and see nothing happen (the canvas
  // wouldn't render until the wasm finishes booting). We refuse the drop
  // event entirely so the browser shows the "no-drop" cursor.
  const rendererReady = renderer.status.kind === "ready";

  const handleCanvasDragOver = (e: React.DragEvent) => {
    if (!rendererReady) return;  // cursor falls back to "no-drop"
    if (draggingKind || dragHasFiles(e)) e.preventDefault();
  };

  const handleCanvasDrop = (e: React.DragEvent, targetFrameId: NodeId) => {
    if (!rendererReady) {
      // Defensive: shouldn't reach here if dragOver returned early, but
      // some browsers fire drop without a matching dragover.
      e.preventDefault();
      return;
    }
    // Compute drop coords once (relative to the frame's content origin).
    const target = e.currentTarget as HTMLDivElement;
    const rect = target.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    // OS file drop — treat any image/* file as a new Image node.
    if (dragHasFiles(e)) {
      const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        e.stopPropagation();
        // Center the new image roughly at the drop point. We don't know
        // its natural size yet, so center with our default 200×120; the
        // upload helper resizes after the image loads.
        handleImageUpload(file, {
          x: Math.round(localX - 100),
          y: Math.round(localY - 60),
          parentId: targetFrameId,
        });
      }
      return;
    }

    if (!draggingKind) return;
    e.preventDefault();
    e.stopPropagation();
    const fresh = defaultNode(draggingKind);
    fresh.x = Math.round(localX - fresh.width / 2);
    fresh.y = Math.round(localY - fresh.height / 2);
    const { node: parent } = findNode(root, targetFrameId);
    if (parent && isContainer(parent)) {
      fresh.x = Math.max(0, Math.min(fresh.x, parent.width - fresh.width));
      fresh.y = Math.max(0, Math.min(fresh.y, parent.height - fresh.height));
    }
    insertChild(targetFrameId, fresh);
    selectSingle(fresh.id);
    setDraggingKind(null);
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+S works EVERYWHERE — including from inside text inputs. Users
      // expect "save my work" to be available while typing in a property
      // panel, label field, etc. We override the browser's "save page"
      // default so Cmd+S routes to the project autosave instead.
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveLocal();
        return;
      }

      // Ignore the rest when typing into form inputs.
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        if (selectedIds.size > 0) { e.preventDefault(); duplicateSelected(); }
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        if (selectedIds.size > 0) { e.preventDefault(); copySelected(); }
        return;
      }
      if (meta && e.key.toLowerCase() === "x") {
        if (selectedIds.size > 0) { e.preventDefault(); cutSelected(); }
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        if (clipboard.length > 0) { e.preventDefault(); pasteFromClipboard(); }
        return;
      }
      // Z-order: Cmd+] = forward, Cmd+[ = backward, plus Shift for to-front/back.
      if (meta && e.key === "]") {
        if (selectedIds.size > 0) { e.preventDefault(); zOrderSelected(e.shiftKey ? "front" : "forward"); }
        return;
      }
      if (meta && e.key === "[") {
        if (selectedIds.size > 0) { e.preventDefault(); zOrderSelected(e.shiftKey ? "back" : "backward"); }
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selectedIds.size > 0) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (selectedIds.size > 0) {
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        let dx = 0, dy = 0;
        if (e.key === "ArrowLeft")  dx = -step;
        if (e.key === "ArrowRight") dx =  step;
        if (e.key === "ArrowUp")    dy = -step;
        if (e.key === "ArrowDown")  dy =  step;
        if (dx !== 0 || dy !== 0) {
          e.preventDefault();
          // Nudge each selected non-root node — single commit, single undo.
          dispatch({
            type: "commit",
            app: mutateActivePage(app, (clone) => {
              for (const sid of selectedIds) {
                if (sid === root.id) continue;
                const { node } = findNode(clone, sid);
                if (node) { node.x += dx; node.y += dy; }
              }
            }),
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, root, clipboard, handleSaveLocal]);

  // ── Export ────────────────────────────────────────────────────────────────

  // True when the user has at least drafted a core module (id + ≥1 method).
  const hasCoreModule = !!app.coreModule && app.coreModule.id.trim().length > 0;

  // ── Export: UI plugin (.lgx) ─────────────────────────────────────────────
  // Builds the UI .lgx in-memory and returns the blob + filename. Factored
  // out of handleExportUi so the GitHub-build path can grab the same bytes
  // and ship them as a release asset alongside the multi-arch backend lgx.
  const buildUiLgxBlob = async (): Promise<{ blob: Blob; filename: string }> => {
    const name = sanitizeName(moduleMeta.name) || "my_widget";

    // Collect every Image node's data URL across every page, write each to
    // assets/<n>.<ext>, and rewrite the trees so the emitted QML references
    // those files instead of inline base64. We deep-clone the whole AppState
    // so the editor state is untouched.
    type AssetEntry = { rel: string; data: Uint8Array };
    const assets: AssetEntry[] = [];
    const seen = new Map<string, string>();
    const exportApp: AppState = JSON.parse(JSON.stringify(app));
    let assetCounter = 0;
    const walk = (n: Node) => {
      if ((n.kind === "Image" || n.kind === "AnimatedImage") && n.src.startsWith("data:")) {
        let assetPath = seen.get(n.src);
        if (!assetPath) {
          const m = /^data:([^;]+);base64,(.+)$/.exec(n.src);
          if (m) {
            const ext = (m[1].split("/")[1] || "bin").replace("jpeg", "jpg");
            const bin = atob(m[2]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const fname = `image_${assetCounter++}.${ext}`;
            assetPath = `assets/${fname}`;
            assets.push({ rel: assetPath, data: bytes });
            seen.set(n.src, assetPath);
          }
        }
        if (assetPath) n.src = assetPath;
      } else if (isContainer(n)) {
        n.children.forEach(walk);
      }
    };
    for (const p of exportApp.pages) p.root.children.forEach(walk);
    const qmlSource = emitMainQml(exportApp, true);

    // Embed an editor-side snapshot so the .lgx is round-trip importable
    // (Open button can read this back). Uses the *original* root with data
    // URLs intact, not the asset-rewritten exportRoot — so re-imports get
    // the in-editor representation back exactly.
    const designSnapshot: SaveState = buildSaveState();
    const designJsonBytes = new TextEncoder().encode(JSON.stringify(designSnapshot));
    const allExtras = [...assets, { rel: "design.json", data: designJsonBytes }];

    // UI dependencies — primitives + the user's core + transitive core
    // deps + delivery_relay (when any send/receive action exists). Single
    // source of truth in lib/uiDeps so tests cover exactly what we ship.
    const uiDeps = computeUiDeps(app);

    const result = await exportLgx({
      name,
      version: moduleMeta.version.trim() || "0.1.0",
      description: moduleMeta.description,
      category: moduleMeta.category.trim() || "example",
      author: moduleMeta.author,
      iconPng,
      iconFilename,
      qmlSource,
      extraFiles: allExtras,
      dependencies: uiDeps,
    });
    return { blob: result.blob, filename: result.filename };
  };

  const handleExportUi = async () => {
    const { blob, filename } = await buildUiLgxBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Export: custom core module ────────────────────────────────────────────
  // Always exports the SOURCE archive — caller has chosen "Build locally" in
  // the Export modal, which means they want to run `nix build` on their own
  // machine and get a binary that matches their host OS. The "Build via
  // GitHub Actions" path bypasses this function entirely: it pushes the
  // spec to the user's repo and downloads the multi-arch .lgx from the
  // resulting release.
  const handleExportCore = async () => {
    if (!app.coreModule) return;
    const id = app.coreModule.id || "my_module";

    const files = generateCoreModuleFiles(app.coreModule);
    const blob = packTarGz(files, `${id}-core`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}-core-source.lgx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Export: shared delivery_relay (pre-built, ships with the editor) ────
  // Same .lgx for every project. Just fetches the bundled static asset and
  // triggers a download. User installs once per Basecamp; every delivery-
  // enabled widget reuses it.
  const handleExportRelay = async () => {
    const res = await fetch("/delivery_relay.lgx");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "delivery_relay.lgx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Modal-driven export. The user picks UI + (optionally) the relay + their
  // custom core. When delivery is in use, the relay download is forced on.
  const [exportOpen, setExportOpen] = useState(false);
  const [askAIOpen, setAskAIOpen] = useState(false);
  const [aiHistory, setAiHistory] = useState<AIHistoryEntry[]>([]);
  const [moduleDetail, setModuleDetail] = useState<ModuleInfo | null>(null);
  // New-variable / new-trigger modals. Replaces the previous inline + buttons
  // that created with defaults — users now fill in the relevant fields up
  // front and the freshly-created row already reflects their intent.
  const [newVarOpen, setNewVarOpen] = useState(false);
  const [newTrigOpen, setNewTrigOpen] = useState(false);
  // Read-only viewer for the generated QML. Pulled out of the inspector
  // (where it was an inline <details>) so the inspector stays focused on
  // editing the selected node and the QML view has room to breathe.
  const [qmlOpen, setQmlOpen] = useState(false);
  // Read-only viewer for the user's custom backend's C++ source bundle —
  // every file generateCoreModuleFiles emits (impl.h/impl.cpp, flake.nix,
  // tests, etc.). Same intent as the QML modal: keep the inspector clean
  // while still letting the user peek at what gets shipped.
  const [coreSrcOpen, setCoreSrcOpen] = useState(false);
  const [exportUi, setExportUi] = useState(true);
  const [exportCore, setExportCore] = useState(false);
  const [exportRelay, setExportRelay] = useState(false);
  // How to build the custom core when exportCore is on:
  //  - "local"  → download source archive, user runs `nix build` themselves.
  //               Single-arch (their machine), fast (~30s warm cache).
  //  - "github" → push spec to a GitHub repo, Actions builds for both Linux
  //               and macOS, returns multi-arch .lgx. (Coming soon — Phase 2.)
  const [coreBuildMethod, setCoreBuildMethod] = useState<"local" | "github">("local");
  const deliveryNeedsRelay = usesDelivery(app);

  // GitHub config (Phase 2 MVP — BYO fine-grained PAT, no OAuth yet).
  // Stored in localStorage; loaded once on mount.
  const [ghSettings, setGhSettings] = useState<GitHubSettings>(emptySettings);
  const [ghProbe, setGhProbe] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ghProbing, setGhProbing] = useState(false);
  useEffect(() => {
    setGhSettings(readGitHubSettings());
  }, []);
  const saveGhSettings = (next: GitHubSettings) => {
    setGhSettings(next);
    writeGitHubSettings(next);
    setGhProbe(null);   // invalidate probe result whenever config changes
  };
  const probeGh = async () => {
    setGhProbing(true);
    try {
      const err = await probeGitHubAccess(ghSettings);
      setGhProbe(err === null ? { ok: true, msg: "Connected ✓" } : { ok: false, msg: err });
    } finally {
      setGhProbing(false);
    }
  };

  // Live build progress when "Build via GitHub" is in flight. null when
  // idle. Used by the inline progress UI below the radio chooser.
  const [buildProgress, setBuildProgress] = useState<BuildPhase | null>(null);
  const [building, setBuilding] = useState(false);

  // Default checkboxes when opening: relay on if delivery is used; custom
  // core on if the user has authored one.
  useEffect(() => {
    if (exportOpen) {
      setExportRelay(deliveryNeedsRelay);
      setExportCore(hasCoreModule);
      setBuildProgress(null);
    }
  }, [exportOpen, hasCoreModule, deliveryNeedsRelay]);
  const runExport = async () => {
    if (exportUi) await handleExportUi();
    if (exportRelay || deliveryNeedsRelay) await handleExportRelay();
    if (hasCoreModule && exportCore) {
      if (coreBuildMethod === "local") {
        handleExportCore();
      } else if (coreBuildMethod === "github") {
        if (!isGitHubConfigured(ghSettings)) {
          window.alert("Configure your GitHub repo + PAT first (in this modal).");
          return;
        }
        setBuilding(true);
        try {
          const files = generateCoreModuleFiles(app.coreModule!);

          // If the user also wants the UI in this build, build the UI .lgx
          // in-browser and ship it as a prebuilt release asset. The workflow's
          // merge job picks it up out of prebuilt/ and attaches it to the
          // release alongside the multi-arch backend lgx — so anyone grabbing
          // the release gets both halves of the widget without re-opening the
          // editor.
          const prebuiltAssets: { filename: string; data: Uint8Array }[] = [];
          if (exportUi) {
            const ui = await buildUiLgxBlob();
            const uiBytes = new Uint8Array(await ui.blob.arrayBuffer());
            prebuiltAssets.push({ filename: ui.filename, data: uiBytes });
          }

          const lgx = await pushAndBuild(
            ghSettings,
            files,
            (phase) => setBuildProgress(phase),
            { prebuiltAssets },
          );
          // Save the multi-arch .lgx the workflow returned.
          const id = app.coreModule!.id || "my_module";
          const url = URL.createObjectURL(lgx);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${id}.lgx`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {
          // pushAndBuild already calls onProgress with kind:"error" on
          // hard failure — keep that message visible. Otherwise dump the
          // exception text to the progress slot.
          if (!buildProgress || buildProgress.kind !== "error") {
            const raw = (e as Error).message;
            const msg = raw === "Failed to fetch"
              ? "Network error — couldn't reach api.github.com. Check your internet connection and that the GitHub token + repo are configured correctly."
              : raw;
            setBuildProgress({ kind: "error", message: msg });
          }
          setBuilding(false);
          return;   // keep modal open so the user sees the error
        }
        setBuilding(false);
      }
    }
    if (!building) setExportOpen(false);
  };

  // The Inspector + ResizeOverlay are single-selection only. `primaryId` is
  // the lone selected id; null when zero or many are selected.
  const primaryId: NodeId | null = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const primaryNode = primaryId ? findNode(root, primaryId).node : null;
  const primaryAbs = primaryId ? absoluteRect(root, primaryId) : null;
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  // SSR / pre-hydration: render a deterministic spinner. See comment on
  // `mounted` at the top of this component. All hooks above ran already,
  // so hook ordering across renders stays consistent.
  if (!mounted) {
    return (
      <div
        className="flex h-screen items-center justify-center bg-canvas"
        role="status"
        aria-label="Loading editor"
      >
        <svg
          className="h-7 w-7 animate-spin text-ink-muted"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.2" />
          <path
            d="M22 12a10 10 0 0 1-10 10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-surface-warm text-ink">
      <header className="flex h-12 items-center justify-between border-b border-border-subtle bg-canvas px-4">
        <h1 className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/lgx-logo.svg"
            alt="lgx.guru"
            width={28}
            height={28}
            className="h-7 w-7 dark:invert"
          />
          <span className="sr-only">lgx.guru</span>
          {activeProject && (
            <>
              <a
                href="/dashboard"
                onClick={(e) => {
                  e.preventDefault();
                  flushSave();
                  window.location.assign("/dashboard");
                }}
                title="Back to all projects"
                className="ml-1 flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-normal text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
              >
                Projects
              </a>
              <span className="text-ink-muted">/</span>
              <button
                onClick={() => {
                  const next = window.prompt("Rename project", activeProject.name);
                  if (next === null) return;
                  const trimmed = next.trim();
                  if (!trimmed || trimmed === activeProject.name) return;
                  renameProject(activeProject.id, trimmed);
                  setActiveProject({ ...activeProject, name: trimmed });
                }}
                title="Click to rename"
                className="min-w-0 truncate rounded-pill px-2 py-0.5 text-ink transition-colors hover:bg-surface-warm"
              >
                {activeProject.name}
              </button>
            </>
          )}
        </h1>
        <div className="flex items-center gap-1.5">
          {/* Primary AI action — distinct accent so it stands out */}
          <button
            onClick={() => setAskAIOpen(true)}
            className="rounded-pill gradient-accent px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
            title="Describe a change in plain English; AI wires it up (variables, triggers, bindings)."
          >Ask AI</button>

          {/* Templates dropdown */}
          <div className="relative">
            <button
              className={`rounded-pill border px-3 py-1 text-xs transition-colors ${
                templatesOpen
                  ? "border-accent bg-surface-warm text-accent"
                  : "border-border-subtle bg-canvas text-ink-muted hover:bg-surface-warm hover:border-border-soft hover:text-ink"
              }`}
              onClick={() => setTemplatesOpen((v) => !v)}
              title="Replace canvas with a starter template"
            >Templates</button>
            {templatesOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setTemplatesOpen(false)}
                />
                <div
                  className="absolute right-0 top-full z-20 mt-1.5 w-64 overflow-hidden rounded-card border border-border-subtle bg-canvas shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="border-b border-border-subtle px-3 py-2.5">
                    <p className="eyebrow">Pick a template</p>
                  </div>
                  <div className="max-h-80 overflow-y-auto py-1">
                    {TEMPLATES.map((t) => (
                      <button
                        key={t.id}
                        className="block w-full px-3 py-2 text-left transition-colors hover:bg-surface-warm"
                        onClick={() => applyTemplate(t)}
                      >
                        <div className="text-[12px] font-medium text-ink">{t.name}</div>
                        <div className="mt-0.5 text-[11px] leading-snug text-ink-muted">{t.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Subtle divider between primary tools and file ops */}
          <span className="mx-0.5 h-5 w-px bg-border-subtle" />

          {/* File ops */}
          <button
            className="rounded-pill border border-border-subtle bg-canvas px-3 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-warm hover:border-border-soft hover:text-ink"
            onClick={() => designFileInputRef.current?.click()}
            title="Open a .lgx-design.json or a .lgx exported from this editor"
          >Open</button>
          <button
            className={`rounded-pill border px-3 py-1 text-xs transition-colors ${
              saveFeedback === "saved"
                ? "border-success bg-success-bg text-success"
                : "border-border-subtle bg-canvas text-ink-muted hover:bg-surface-warm hover:border-border-soft hover:text-ink"
            }`}
            onClick={handleSaveLocal}
            title="Save this project to your browser (⌘S). Opens from the dashboard. For a portable backup, use Export → Download project (.json)."
          >{saveFeedback === "saved" ? "Saved ✓" : "Save"}</button>
          <input
            ref={designFileInputRef}
            type="file"
            accept=".lgx,.json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleOpenDesign(f);
              e.target.value = "";
            }}
          />

          <span className="mx-0.5 h-5 w-px bg-border-subtle" />

          {/* History */}
          <button
            className="rounded-pill border border-border-subtle bg-canvas px-3 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-warm hover:border-border-soft hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={!canUndo}
            onClick={() => dispatch({ type: "undo" })}
            title="Undo (⌘Z)"
          >Undo</button>
          <button
            className="rounded-pill border border-border-subtle bg-canvas px-3 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-warm hover:border-border-soft hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={!canRedo}
            onClick={() => dispatch({ type: "redo" })}
            title="Redo (⌘⇧Z)"
          >Redo</button>

          <span className="mx-0.5 h-5 w-px bg-border-subtle" />

          {/* Theme toggle — icon-only */}
          <button
            className="flex h-7 w-7 items-center justify-center rounded-pill border border-border-subtle bg-canvas text-ink-muted transition-colors hover:bg-surface-warm hover:border-border-soft hover:text-ink"
            onClick={cycleTheme}
            title={`Theme: ${themePref} (click to cycle light → dark → system)`}
            aria-label="Cycle theme"
          >
            {themePref === "light" ? <Sun size={14} weight="duotone" /> : themePref === "dark" ? <Moon size={14} weight="duotone" /> : <CircleHalf size={14} weight="duotone" />}
          </button>

          {/* Primary export action — pulled visually distinct */}
          <button
            className="ml-1.5 rounded-pill gradient-accent px-4 py-1 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            onClick={() => setExportOpen(true)}
          >Export</button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left column. Two scroll regions, anchored to the column:
            - top: panels (Pages, Variables, Triggers, Networking, Build a
              module, Components). Scrolls so any combination of panels fits.
            - bottom: Layers, capped to 40% of the column height with its own
              scroll so deeply-nested designs stay manageable. */}
        <aside className="flex w-96 shrink-0 flex-col border-r border-border-subtle bg-canvas min-h-0">
          {/* Tab strip — three mode-based views, only one rendered at a
              time. Badges (count when non-zero) signal that a tab has
              content even when not currently active. */}
          <div className="shrink-0 flex border-b border-border-subtle">
            {([
              { id: "design"  as SidebarTab, label: "Design",  badge: app.pages.length > 1 ? app.pages.length : undefined },
              { id: "logic"   as SidebarTab, label: "Logic",   badge: (app.variables.length + app.triggers.length) || undefined },
              { id: "modules" as SidebarTab, label: "Modules", badge: (app.modules.length + (app.coreModule ? 1 : 0)) || undefined },
            ]).map((t) => {
              const active = sidebarTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => switchSidebarTab(t.id)}
                  className={`flex-1 px-2 py-2.5 text-[10px] font-semibold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
                    active
                      ? "border-ink text-ink dark:text-ink"
                      : "border-transparent text-ink-muted hover:bg-surface-warm hover:text-ink-muted"
                  }`}
                >
                  {t.label}
                  {t.badge !== undefined && (
                    <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium leading-none ${
                      active
                        ? "bg-surface-warm text-accent dark:bg-surface-warm dark:text-accent"
                        : "bg-surface-cool text-ink-muted dark:bg-surface-warm dark:text-ink-muted"
                    }`}>{t.badge}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {sidebarTab === "design" && (
              <PagesPanel
                pages={app.pages}
                currentPageId={app.currentPageId}
                onSwitch={switchPage}
                onAdd={addPage}
                onRename={renamePage}
                onDelete={deletePage}
              />
            )}
            {sidebarTab === "logic" && (
              <>
                <VariablesPanel
                  variables={app.variables}
                  onAdd={() => setNewVarOpen(true)}
                  onUpdate={updateVariable}
                  onDelete={deleteVariable}
                />
                <TriggersPanel
                  triggers={app.triggers}
                  pages={app.pages}
                  variables={app.variables}
                  enabledModuleIds={app.modules}
                  coreModule={app.coreModule}
                  onAdd={() => setNewTrigOpen(true)}
                  onUpdate={updateTrigger}
                  onDelete={deleteTrigger}
                  onAddAction={addTriggerAction}
                  onUpdateAction={updateTriggerAction}
                  onDeleteAction={deleteTriggerAction}
                  onAddVariable={addVariable}
                />
              </>
            )}
            {sidebarTab === "modules" && (
              <ModulesPanel
                app={app}
                onToggle={toggleModule}
                onOpenBuildModule={() => setAskAIOpen(true)}
                onShowDetails={showModuleDetails}
              />
            )}
            {sidebarTab === "design" && (
            <SidebarSection
              title="Components"
              defaultOpen
              headerRight={
                <button
                  type="button"
                  className="rounded border border-border-soft px-1.5 text-[10px] leading-tight text-ink-muted hover:bg-surface-cool"
                  title={[
                    "Shortcuts",
                    "Shift-click multi-select",
                    "Cmd+Z undo · Cmd+Shift+Z redo",
                    "Cmd+C/X/V copy/cut/paste",
                    "Cmd+D duplicate",
                    "Del/Backspace remove",
                    "Arrows nudge (Shift = 10px)",
                  ].join("\n")}
                >?</button>
              }
            >
              <div className="flex flex-col gap-2">
                {PALETTE.map((cat) => (
                  <div key={cat.name}>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                      {cat.name}
                    </div>
                    {/* Two-column grid — packs ~2x denser than the previous
                        single-column stack, eliminating most palette overflow. */}
                    <div className="grid grid-cols-2 gap-1">
                      {cat.items.map((p) => (
                        <button
                          key={p.kind}
                          // Gate drag + click on renderer readiness so users
                          // don't drop nodes into a half-booted canvas where
                          // nothing visibly happens.
                          draggable={rendererReady}
                          disabled={!rendererReady}
                          onDragStart={() => rendererReady && setDraggingKind(p.kind)}
                          onDragEnd={() => setDraggingKind(null)}
                          onClick={p.kind === "Image" && rendererReady ? () => imageFileInputRef.current?.click() : undefined}
                          className={`flex items-center gap-1.5 truncate rounded border px-1.5 py-1 text-left text-[11px] transition-colors ${
                            rendererReady
                              ? "border-border-subtle bg-surface-warm cursor-grab active:cursor-grabbing hover:border-border-soft dark:hover:border-border-soft"
                              : "border-border-subtle bg-surface-warm/50 dark:bg-surface-warm/40 opacity-50 cursor-not-allowed"
                          }`}
                          title={
                            !rendererReady
                              ? "Waiting for the live preview to finish loading…"
                              : p.kind === "Image"
                                ? "Click to upload, or drag for a placeholder"
                                : p.label
                          }
                        >
                          <NodeIcon kind={p.kind} className="text-ink-muted" />
                          <span className="truncate">{p.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <input
                ref={imageFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleImageUpload(f);
                  e.target.value = "";
                }}
              />
              <p className="mt-2 text-[10px] leading-tight text-ink-muted">
                Drag onto the canvas, or drop image files from your OS.
              </p>
            </SidebarSection>
            )}
          </div>

          {/* Layers used to live here — moved below the canvas so it
              occupies the empty space under the page where the grid
              doesn't extend, and so the left sidebar can give its full
              height to the Pages / Variables / Triggers / Modules
              panels without the 40vh layer-tree cap. See the panel mount
              inside <main> below the canvas <section>. */}
        </aside>

        {/* Single-pane canvas. The Qt-WASM iframe IS the canvas — it
            renders the QML the same way Basecamp will. The React overlay
            on top captures pointer events for selection / drag / resize.
            A Run-mode toggle lifts that overlay's pointer-events-auto so
            clicks fall through to Qt and the user can interact with their
            widget (test buttons, type into fields, send messages). */}
        <main className="flex flex-1 flex-col min-w-0">
          <section className="flex flex-1 flex-col bg-surface-cool min-h-0">
            <div className="flex items-center justify-between border-b border-border-subtle bg-canvas px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase text-ink-muted">
                  {runMode ? "Run" : "Canvas"}
                </span>
                <span className="text-[11px] text-ink-muted">
                  Qt-WASM @ {RENDERER_URL}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    runMode
                      ? "border-success bg-success-bg text-success dark:border-success dark:bg-success-bg/60 dark:text-success"
                      : "border-border-subtle bg-canvas text-ink-muted hover:bg-surface-warm hover:border-border-soft dark:text-ink-muted"
                  }`}
                  onClick={() => setRunMode((v) => !v)}
                  title="Toggle Edit ↔ Run. Edit lets you select & drag widgets; Run forwards clicks to Qt so you can test the live widget."
                >
                  {runMode ? "▶ Run" : "✎ Edit"}
                </button>
                <button
                  className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                    gridSize > 0
                      ? "border-accent bg-surface-warm text-accent dark:border-accent dark:bg-surface-warm/60 dark:text-accent"
                      : "border-border-subtle bg-canvas text-ink-muted hover:bg-surface-warm hover:border-border-soft dark:text-ink-muted"
                  }`}
                  onClick={() => setGridSize((g) => (g === 0 ? 8 : g === 8 ? 16 : g === 16 ? 24 : 0))}
                  title="Toggle snap-to-grid (cycles off / 8 / 16 / 24 px)"
                  disabled={runMode}
                >
                  grid {gridSize === 0 ? "off" : `${gridSize}px`}
                </button>
                <span className="text-[11px] text-ink-muted">
                  {root.width}×{root.height}px
                </span>
              </div>
            </div>
            <div
              ref={canvasRef}
              className="relative flex-1 overflow-hidden"
            >
              {/* Qt-WASM rendering of the user's QML — the only renderer in
                  the editor now. In Edit mode this iframe gets `pointer-events:
                  none` so the React overlay captures clicks for selection /
                  drag. In Run mode the React overlay disappears, the iframe
                  takes events, and the user can interact with their widget. */}
              {renderer.status.kind !== "unsupported" && (
                <iframe
                  ref={canvasIframeRef}
                  // reloadKey query param forces the browser to refetch the
                  // renderer when the user clicks "Reload renderer" without
                  // remounting the iframe element (preserves the ResizeObserver
                  // binding above).
                  src={`${RENDERER_URL}${RENDERER_URL.includes("?") ? "&" : "?"}r=${renderer.reloadKey}`}
                  className="absolute inset-0 h-full w-full bg-surface-warm"
                  style={{ pointerEvents: runMode ? "auto" : "none" }}
                  title="canvas-renderer"
                  onLoad={handleIframeLoad}
                  onError={renderer.handleError}
                />
              )}
              {/* Grid overlay — sits on top of the iframe (whose Qt content
                  paints a white bg that would otherwise cover any grid on
                  the parent), and below the React overlays (CanvasArea,
                  ResizeOverlay) which come after this in source order so
                  widgets and selection chrome render above the grid.
                  pointer-events:none so it doesn't intercept clicks. Spans
                  the full canvas viewport, not just the page rect, so the
                  workspace doesn't have a bare strip below the page. */}
              {gridSize > 0 && !runMode && (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(rgba(0,0,0,0.06) 1px, transparent 1px)," +
                      "linear-gradient(90deg, rgba(0,0,0,0.06) 1px, transparent 1px)",
                    backgroundSize: `${gridSize}px ${gridSize}px`,
                  }}
                />
              )}
              <RendererStatus
                status={renderer.status}
                url={RENDERER_URL}
                onRetry={renderer.retry}
              />
              {/* Empty-canvas onboarding hint. Only shown in Edit mode when
                  the active page has zero children AND the renderer is
                  ready. Pointer-events:none so it doesn't intercept drops. */}
              {!runMode
                && renderer.status.kind === "ready"
                && root.children.length === 0
                && (
                  <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
                    <div className="rounded-lg border border-dashed border-border-soft bg-canvas/70 px-6 py-5 text-center backdrop-blur-sm/60">
                      <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-surface-warm text-accent dark:bg-surface-warm dark:text-accent">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="3" y="3" width="7" height="7" rx="1" />
                          <rect x="14" y="3" width="7" height="7" rx="1" />
                          <rect x="3" y="14" width="7" height="7" rx="1" />
                          <rect x="14" y="14" width="7" height="7" rx="1" />
                        </svg>
                      </div>
                      <div className="text-xs font-semibold text-ink">
                        Empty canvas
                      </div>
                      <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-ink-muted">
                        Drag a component from the left palette, pick a <span className="text-ink-muted">Template</span>, or hit <span className="font-medium text-accent">✦ Ask AI</span> to describe what you want.
                      </p>
                    </div>
                  </div>
              )}
              {!runMode && (
                <CanvasArea
                  root={root}
                  selectedIds={selectedIds}
                  onSelect={handleSelect}
                  onStartMove={startMove}
                  onCanvasDrop={handleCanvasDrop}
                  onCanvasDragOver={handleCanvasDragOver}
                  onMarqueeStart={startMarquee}
                  draggingKind={draggingKind}
                  gridSize={gridSize}
                  resizeOverlay={
                    primaryAbs && primaryId && primaryId !== root.id && primaryNode && !primaryNode.locked ? (
                      <ResizeOverlay
                        rect={primaryAbs}
                        onStart={(anchor, e) => startResize(e, primaryId, anchor)}
                      />
                    ) : multiBbox ? (
                      <ResizeOverlay
                        rect={multiBbox}
                        onStart={(anchor, e) => startMultiResize(e, anchor)}
                      />
                    ) : null
                  }
                  guideOverlay={guideLines.length > 0 ? <GuideOverlay lines={guideLines} /> : null}
                  marquee={marquee}
                />
              )}
            </div>
          </section>

          {/* Layers — full width of the canvas column, sitting below the
              canvas section. Page area is fixed (e.g. 1024×640) so the
              workspace below the page tends to be empty surface anyway;
              this fills it with something useful. Capped at 220px so the
              canvas keeps the lion's share of vertical space; internal
              scroll for deep trees. */}
          <div className="shrink-0 flex flex-col border-t border-border-subtle bg-canvas max-h-[220px] min-h-[140px]">
            <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-2">
              <p className="eyebrow">Layers</p>
              <span className="text-[11px] text-ink-muted">drag to reorder</span>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-1">
              <LayersPanel
                root={root}
                selectedIds={selectedIds}
                onSelect={handleSelect}
                collapsedIds={collapsedIds}
                onToggleCollapsed={toggleCollapsed}
                onToggleHidden={toggleHidden}
                onToggleLocked={toggleLocked}
                onMove={moveNode}
              />
            </div>
          </div>
        </main>

        {/* Inspector */}
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-border-subtle bg-canvas p-4">
          <ModulePanel
            meta={moduleMeta}
            onChange={setModuleMeta}
            iconPreviewUrl={iconPreviewUrl}
            iconFilename={iconFilename}
            iconError={iconError}
            onIconUpload={handleIconUpload}
            onGenerateIcon={handleGenerateIcon}
            iconGenerating={iconGenerating}
            sanitizedName={sanitizeName(moduleMeta.name) || "my_widget"}
          />

          <div className="my-4 border-t border-border-subtle" />

          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-ink-muted dark:text-ink-muted">
              Inspector
            </span>
            {(selectedIds.size > 0 && (selectedIds.size > 1 || (primaryNode && primaryId !== root.id))) && (
              <div className="flex items-center gap-1">
                <button
                  className="rounded-pill px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
                  onClick={duplicateSelected}
                >duplicate</button>
                <button
                  className="rounded-pill p-1.5 text-ink-muted transition-colors hover:bg-danger-bg hover:text-danger"
                  onClick={deleteSelected}
                  aria-label="Delete selected"
                  title="Delete selected"
                >
                  <Trash size={14} weight="duotone" />
                </button>
              </div>
            )}
          </div>

          {selectedIds.size > 0 && (selectedIds.size > 1 || (primaryNode && primaryId !== root.id)) && (
            <div className="mb-3 flex items-center gap-1">
              <IconBtn title="Send to back (Cmd+Shift+[)"  onClick={() => zOrderSelected("back")}     ><AlignIcon kind="left" /></IconBtn>
              <IconBtn title="Send backward (Cmd+[)"        onClick={() => zOrderSelected("backward")} ><AlignIcon kind="centerX" /></IconBtn>
              <IconBtn title="Bring forward (Cmd+])"        onClick={() => zOrderSelected("forward")}  ><AlignIcon kind="right" /></IconBtn>
              <IconBtn title="Bring to front (Cmd+Shift+])" onClick={() => zOrderSelected("front")}    ><AlignIcon kind="distH" /></IconBtn>
              <span className="ml-1 text-[10px] text-ink-muted">z-order</span>
            </div>
          )}
          {selectedIds.size === 0 ? (
            <p className="text-xs text-ink-muted dark:text-ink-muted">
              Click a node in the canvas to edit. Shift-click to add to selection.
              Click empty space to deselect.
            </p>
          ) : selectedIds.size > 1 ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-ink-muted dark:text-ink-muted">
                <span className="font-mono">{selectedIds.size}</span> items selected.
                Drag to move together; Delete / Cmd+D / arrows apply to all.
              </p>
              <AlignToolbar
                canAlign={commonParentId() !== null}
                canDistribute={commonParentId() !== null && selectedIds.size >= 3}
                onAlign={alignSelected}
                onDistribute={distributeSelected}
              />
            </div>
          ) : primaryNode ? (
            <Inspector
              node={primaryNode}
              isRoot={primaryId === root.id}
              onChange={(patch) => primaryId && updateNode(primaryId, patch)}
              pages={app.pages}
              variables={app.variables}
              enabledModuleIds={app.modules}
              coreModule={app.coreModule}
              onAddVariable={addVariable}
              onWireLiveData={handleWireLiveData}
            />
          ) : null}
          {/* Generated source viewers — open in modals rather than expanding
              inline, so the inspector stays focused on editing. Both are
              advanced/diagnostic; most users never need them. The C++
              button only renders when there's actually a custom backend. */}
          <div className="mt-6 flex flex-col gap-2">
            <button
              onClick={() => setQmlOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-pill border border-border-subtle bg-canvas px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
            >
              <Code size={14} weight="duotone" />
              View generated QML
            </button>
            {hasCoreModule && (
              <button
                onClick={() => setCoreSrcOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-pill border border-border-subtle bg-canvas px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
              >
                <Code size={14} weight="duotone" />
                View module C++ source
              </button>
            )}
          </div>
        </aside>
      </div>

      {exportOpen && (
        // Export modal redesigned to match Titan vocabulary: warm canvas
        // surface, sage feature cards, eyebrow section labels, font-display
        // headline, pill-shaped CTAs. Wider (520px) so the GitHub config
        // form doesn't crowd the radio cards. Scrollable body for cases
        // with both a custom core and a long progress strip.
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
          onClick={() => setExportOpen(false)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-160 flex-col overflow-hidden rounded-card-lg border border-border-subtle bg-canvas shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Export project"
          >
            {/* Header */}
            <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
              <div className="min-w-0">
                <h2 className="font-display text-[20px] font-medium leading-[1.15] tracking-tight text-ink">
                  Export this project
                </h2>
              </div>
              <button
                onClick={() => setExportOpen(false)}
                aria-label="Close"
                className="-mt-1 -mr-1 shrink-0 rounded-pill px-2 py-1 text-[14px] leading-none text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
              >×</button>
            </header>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <section>
                <p className="eyebrow">Files to install</p>

                <div className="mt-3 space-y-2.5">
                  {/* UI widget — always offered. Cross-platform pure QML
                      built in the browser. */}
                  <label className="flex cursor-pointer items-start gap-3 rounded-card border border-border-subtle bg-canvas p-4 transition-colors hover:bg-surface-warm">
                    <input
                      type="checkbox"
                      checked={exportUi}
                      onChange={(e) => setExportUi(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-ink"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[13px] font-medium text-ink">UI widget</span>
                        <span className="font-mono text-[11px] text-ink-muted">{sanitizeName(moduleMeta.name) || "my_widget"}.lgx</span>
                        <span className="rounded-pill bg-surface-cool px-2 py-0.5 text-[10px] font-medium text-ink-muted">cross-platform</span>
                      </div>
                      <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
                        The visual interface — pages, components, triggers, all the wiring. Pure QML, so the same file installs on macOS and Linux. Required for the widget to render.
                      </p>
                    </div>
                  </label>

                  {/* Relay — only shown when delivery is in use. */}
                  {deliveryNeedsRelay && (
                    <div className="flex items-start gap-3 rounded-card border border-warning bg-warning-bg p-4">
                      <input
                        type="checkbox"
                        checked
                        disabled
                        className="mt-0.5 h-4 w-4 accent-warning"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-[13px] font-medium text-ink">Delivery relay</span>
                          <span className="font-mono text-[11px] text-ink-muted">delivery_relay.lgx</span>
                          <span className="rounded-pill bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">required</span>
                        </div>
                        <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
                          Pre-built C++ relay needed for <span className="font-mono">sendMessage</span> / <span className="font-mono">onMessageReceived</span>. Same file for every project — install once per Basecamp and every delivery-enabled widget reuses it.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Custom backend — only when a core module exists. */}
                  {hasCoreModule && (
                    <div className="rounded-card border border-border-subtle bg-canvas">
                      <label className="flex cursor-pointer items-start gap-3 p-4 transition-colors hover:bg-surface-warm">
                        <input
                          type="checkbox"
                          checked={exportCore}
                          onChange={(e) => setExportCore(e.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-ink"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="text-[13px] font-medium text-ink">Custom backend</span>
                            <span className="font-mono text-[11px] text-ink-muted">{app.coreModule!.id}.lgx</span>
                            <span className="rounded-pill bg-surface-cool px-2 py-0.5 text-[10px] font-medium text-ink-muted">native C++</span>
                          </div>
                          <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
                            The backend logic the AI built for you. Native C++ — has to be compiled for the OS your Basecamp runs on. Pick how to build it below.
                          </p>
                        </div>
                      </label>

                      {/* Build method — visible only when the backend is checked */}
                      {exportCore && (
                        <div className="border-t border-border-subtle bg-surface-warm/40 p-4">
                          <p className="eyebrow mb-3">Build method</p>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <label
                              className={`flex cursor-pointer flex-col gap-1.5 rounded-card border p-3 transition-colors ${
                                coreBuildMethod === "local"
                                  ? "border-accent bg-canvas"
                                  : "border-border-subtle bg-canvas hover:border-border-soft"
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <input
                                  type="radio"
                                  name="coreBuildMethod"
                                  value="local"
                                  checked={coreBuildMethod === "local"}
                                  onChange={() => setCoreBuildMethod("local")}
                                  className="h-3.5 w-3.5 accent-ink"
                                />
                                <span className="text-[12px] font-medium text-ink">Build locally</span>
                              </div>
                              <p className="text-[11px] leading-snug text-ink-muted">
                                Download a source archive and run <span className="font-mono">nix build</span> on your own machine. Single OS (whichever you run it on). ~30s with warm cache.
                              </p>
                              <p className="text-[10px] text-ink-muted">
                                Requires{" "}
                                <a className="underline hover:text-ink" href="https://nixos.org/download" target="_blank" rel="noopener">nix</a>{" "}
                                on your PATH.
                              </p>
                            </label>

                            <label
                              className={`flex cursor-pointer flex-col gap-1.5 rounded-card border p-3 transition-colors ${
                                coreBuildMethod === "github"
                                  ? "border-accent bg-canvas"
                                  : "border-border-subtle bg-canvas hover:border-border-soft"
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <input
                                  type="radio"
                                  name="coreBuildMethod"
                                  value="github"
                                  checked={coreBuildMethod === "github"}
                                  onChange={() => setCoreBuildMethod("github")}
                                  className="h-3.5 w-3.5 accent-ink"
                                />
                                <span className="text-[12px] font-medium text-ink">Build via GitHub</span>
                                {isGitHubConfigured(ghSettings) && (
                                  <span className="ml-auto rounded-pill bg-success-bg px-2 py-0.5 text-[10px] font-medium text-success">connected</span>
                                )}
                              </div>
                              <p className="text-[11px] leading-snug text-ink-muted">
                                Push to your repo; Actions compiles for both Linux and macOS, attaches a multi-arch <span className="font-mono">.lgx</span> + the UI widget to a Release.
                              </p>
                              <p className="text-[10px] text-ink-muted">
                                Free on public repos · ~5–10 min per build.
                              </p>
                            </label>
                          </div>

                          {/* Local: post-download instructions */}
                          {coreBuildMethod === "local" && (
                            <div className="mt-3 rounded-card bg-canvas p-3">
                              <p className="eyebrow mb-2">After download</p>
                              <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-ink">{`tar -xzf ${app.coreModule!.id}-core-source.lgx
cd ${app.coreModule!.id}-core && nix build '.#lgx-portable'
cp result/${app.coreModule!.id}.lgx ~/Desktop/`}</pre>
                            </div>
                          )}

                          {/* GitHub: config form */}
                          {coreBuildMethod === "github" && !building && (
                            <div className="mt-3 space-y-3 rounded-card bg-canvas p-3">
                              <p className="eyebrow">GitHub configuration</p>
                              <div>
                                <label className="text-[11px] font-medium text-ink-muted">Repo</label>
                                <input
                                  type="text"
                                  placeholder="username/lgx-modules"
                                  value={ghSettings.repo}
                                  onChange={(e) => saveGhSettings({ ...ghSettings, repo: e.target.value.trim() })}
                                  className="mt-1 w-full rounded-control border border-border-soft bg-canvas px-2 py-1.5 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-ink-muted">
                                  Fine-grained PAT
                                  <span className="ml-1 font-normal text-ink-muted">— Contents R/W, Workflows R/W, Actions R, Metadata R</span>
                                </label>
                                <input
                                  type="password"
                                  placeholder="github_pat_…"
                                  value={ghSettings.token}
                                  onChange={(e) => saveGhSettings({ ...ghSettings, token: e.target.value })}
                                  className="mt-1 w-full rounded-control border border-border-soft bg-canvas px-2 py-1.5 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
                                />
                                <a
                                  href="https://github.com/settings/personal-access-tokens/new"
                                  target="_blank"
                                  rel="noopener"
                                  className="mt-1.5 inline-block text-[11px] text-accent hover:underline"
                                >
                                  Generate a token →
                                </a>
                              </div>
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={probeGh}
                                  disabled={ghProbing || !ghSettings.repo || !ghSettings.token}
                                  className="rounded-pill border border-border-soft bg-canvas px-3 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink disabled:opacity-40"
                                >
                                  {ghProbing ? "Testing…" : "Test connection"}
                                </button>
                                {ghProbe && (
                                  <span className={`text-[11px] font-medium ${ghProbe.ok ? "text-success" : "text-danger"}`}>
                                    {ghProbe.msg}
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] leading-snug text-ink-muted">
                                Stored in this browser only. The token never reaches lgx.guru — your browser talks directly to api.github.com.
                              </p>
                            </div>
                          )}

                          {/* GitHub: live build progress */}
                          {coreBuildMethod === "github" && (building || buildProgress) && (
                            <div className="mt-3 rounded-card border border-accent bg-canvas p-3">
                              <p className="eyebrow text-accent">Build in progress</p>
                              <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
                                {!buildProgress && "Starting…"}
                                {buildProgress?.kind === "pushing" && `Pushing files (${buildProgress.fileIndex + 1}/${buildProgress.totalFiles}): ${buildProgress.path}`}
                                {buildProgress?.kind === "triggering" && "Triggering workflow…"}
                                {buildProgress?.kind === "queued" && "Queued — waiting for a runner…"}
                                {buildProgress?.kind === "running" && `Building on GitHub… (${buildProgress.elapsedSec}s)`}
                                {buildProgress?.kind === "downloading" && "Downloading artifact…"}
                                {buildProgress?.kind === "done" && "Done ✓ (download starting)"}
                                {buildProgress?.kind === "error" && (
                                  <span className="text-danger">
                                    Error: {buildProgress.message}
                                    {buildProgress.logsUrl && (
                                      <> — <a className="underline hover:text-ink" href={buildProgress.logsUrl} target="_blank" rel="noopener">view logs</a></>
                                    )}
                                  </span>
                                )}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              {/* Editor-state backup — separate section because it's not
                  installable, it's a portable JSON snapshot for moving the
                  project between browsers. */}
              <section className="mt-6">
                <p className="eyebrow">Editor backup</p>
                <div className="mt-3 flex items-center gap-3 rounded-card border border-dashed border-border-soft bg-surface-warm/40 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[13px] font-medium text-ink">Project file</span>
                      <span className="font-mono text-[11px] text-ink-muted">.lgx-design.json</span>
                    </div>
                    <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
                      Round-trippable JSON — every page, variable, trigger, asset, and backend spec. Re-import via <span className="font-medium text-ink">Open</span>. Auto-saved here; this is for moving the project elsewhere.
                    </p>
                  </div>
                  <button
                    onClick={handleDownloadDesign}
                    className="shrink-0 rounded-pill border border-border-soft bg-canvas px-3 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
                  >
                    Download
                  </button>
                </div>
              </section>
            </div>

            {/* Footer */}
            <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-6 py-4">
              <button
                onClick={() => setExportOpen(false)}
                className="rounded-pill border border-border-soft bg-canvas px-4 py-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={runExport}
                disabled={!exportUi && !(exportCore && hasCoreModule) && !deliveryNeedsRelay}
                className="rounded-pill bg-action px-5 py-1.5 text-[12px] font-medium text-action-on transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Export
              </button>
            </footer>
          </div>
        </div>
      )}

      <ModuleDetailModal
        info={moduleDetail}
        onClose={() => setModuleDetail(null)}
      />

      <NewVariableModal
        open={newVarOpen}
        existingNames={app.variables.map((v) => v.name)}
        onClose={() => setNewVarOpen(false)}
        onCreate={(cfg) => {
          addVariable(cfg);
          setNewVarOpen(false);
        }}
      />

      <GeneratedQmlModal
        open={qmlOpen}
        qml={qmlExport}
        onClose={() => setQmlOpen(false)}
      />

      <CoreModuleSourceModal
        open={coreSrcOpen}
        spec={app.coreModule ?? null}
        onClose={() => setCoreSrcOpen(false)}
      />

      <NewTriggerModal
        open={newTrigOpen}
        enabledModules={[
          ...app.modules
            .map((id) => findModuleSpec(id))
            .filter((m): m is ModuleSpec => m !== undefined),
          ...(app.coreModule
            ? [{
                id: app.coreModule.id,
                name: `${app.coreModule.name || app.coreModule.id} (this project)`,
                description: app.coreModule.description || "Your project's own backend module.",
                methods: app.coreModule.methods.map((m) => ({
                  name: m.name, args: m.args,
                  returns: m.returns, description: m.description,
                })),
                events: app.coreModule.events ?? [],
              }]
            : []),
        ]}
        onClose={() => setNewTrigOpen(false)}
        onCreate={(cfg) => {
          addTrigger(cfg);
          setNewTrigOpen(false);
        }}
      />

      <AskAIModal
        open={askAIOpen}
        onClose={() => setAskAIOpen(false)}
        app={app}
        dispatch={dispatch}
        history={aiHistory}
        onHistory={setAiHistory}
      />
    </div>
  );
}

// ── CanvasArea ──────────────────────────────────────────────────────────────

function CanvasArea({
  root,
  selectedIds,
  onSelect,
  onStartMove,
  onCanvasDrop,
  onCanvasDragOver,
  onMarqueeStart,
  draggingKind,
  gridSize,
  resizeOverlay,
  guideOverlay,
  marquee,
}: {
  root: FrameNode;
  selectedIds: Set<NodeId>;
  onSelect: (id: NodeId | null, additive: boolean) => void;
  onStartMove: (e: React.PointerEvent, id: NodeId) => void;
  onCanvasDrop: (e: React.DragEvent, frameId: NodeId) => void;
  onCanvasDragOver: (e: React.DragEvent) => void;
  onMarqueeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  draggingKind: NodeKind | null;
  gridSize: number;
  resizeOverlay: React.ReactNode;
  guideOverlay: React.ReactNode;
  marquee: { x: number; y: number; w: number; h: number } | null;
}) {
  return (
    // Transparent background — the Qt-WASM canvas iframe BEHIND this layer
    // draws the actual widget pixels. A solid bg here would just hide them.
    // The grid pattern is now painted by the parent canvas div (so it
    // extends across the entire workspace, not just the page rect),
    // hence no inline grid styling here. gridSize is still relevant for
    // snapping (handled in the move/resize handlers, not painting).
    <div
      className="relative inline-block"
      style={{ width: root.width, height: root.height }}
      onPointerDown={onMarqueeStart}
      onDragOver={onCanvasDragOver}
      onDrop={(e) => onCanvasDrop(e, root.id)}
    >
      {root.children.map((child) => (
        <NodeView
          key={child.id}
          node={child}
          selectedIds={selectedIds}
          onSelect={onSelect}
          onStartMove={onStartMove}
          onCanvasDrop={onCanvasDrop}
          onCanvasDragOver={onCanvasDragOver}
          draggingKind={draggingKind}
        />
      ))}
      {resizeOverlay}
      {guideOverlay}
      {marquee && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h,
            background: "rgba(59, 130, 246, 0.10)",
            border: "1px solid rgb(59, 130, 246)",
          }}
        />
      )}
    </div>
  );
}

// ── AlignToolbar (visible only on multi-select with shared parent) ─────────

function IconBtn({
  title, disabled, onClick, children,
}: {
  title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-canvas text-ink-muted hover:border-border-soft dark:border-border-soft hover:bg-surface-warm disabled:opacity-30 disabled:hover:bg-canvas"
    >
      {children}
    </button>
  );
}

// Each icon: a 16×16 svg of three little bars + a guide line indicating
// which edge they snap to.
const AlignIcon = ({ kind }: {
  kind: "left" | "centerX" | "right" | "top" | "centerY" | "bottom" | "distH" | "distV";
}) => {
  const stroke = "currentColor";
  if (kind === "left") return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <line x1="2" y1="2" x2="2" y2="14" stroke={stroke} strokeWidth="1.4" />
      <rect x="3.5" y="4" width="9" height="2.5" fill={stroke} />
      <rect x="3.5" y="9.5" width="6" height="2.5" fill={stroke} />
    </svg>
  );
  if (kind === "centerX") return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <line x1="8" y1="2" x2="8" y2="14" stroke={stroke} strokeWidth="1.4" strokeDasharray="2 1.5" />
      <rect x="2" y="4" width="12" height="2.5" fill={stroke} />
      <rect x="4.5" y="9.5" width="7" height="2.5" fill={stroke} />
    </svg>
  );
  if (kind === "right") return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <line x1="14" y1="2" x2="14" y2="14" stroke={stroke} strokeWidth="1.4" />
      <rect x="3.5" y="4" width="9" height="2.5" fill={stroke} />
      <rect x="6.5" y="9.5" width="6" height="2.5" fill={stroke} />
    </svg>
  );
  if (kind === "top") return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <line x1="2" y1="2" x2="14" y2="2" stroke={stroke} strokeWidth="1.4" />
      <rect x="4" y="3.5" width="2.5" height="9" fill={stroke} />
      <rect x="9.5" y="3.5" width="2.5" height="6" fill={stroke} />
    </svg>
  );
  if (kind === "centerY") return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <line x1="2" y1="8" x2="14" y2="8" stroke={stroke} strokeWidth="1.4" strokeDasharray="2 1.5" />
      <rect x="4" y="2" width="2.5" height="12" fill={stroke} />
      <rect x="9.5" y="4.5" width="2.5" height="7" fill={stroke} />
    </svg>
  );
  if (kind === "bottom") return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <line x1="2" y1="14" x2="14" y2="14" stroke={stroke} strokeWidth="1.4" />
      <rect x="4" y="3.5" width="2.5" height="9" fill={stroke} />
      <rect x="9.5" y="6.5" width="2.5" height="6" fill={stroke} />
    </svg>
  );
  if (kind === "distH") return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <rect x="1" y="4" width="2.5" height="8" fill={stroke} />
      <rect x="6.75" y="4" width="2.5" height="8" fill={stroke} />
      <rect x="12.5" y="4" width="2.5" height="8" fill={stroke} />
    </svg>
  );
  // distV
  return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <rect x="4" y="1" width="8" height="2.5" fill={stroke} />
      <rect x="4" y="6.75" width="8" height="2.5" fill={stroke} />
      <rect x="4" y="12.5" width="8" height="2.5" fill={stroke} />
    </svg>
  );
};

function AlignToolbar({
  canAlign, canDistribute, onAlign, onDistribute,
}: {
  canAlign: boolean;
  canDistribute: boolean;
  onAlign: (op: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => void;
  onDistribute: (axis: "horizontal" | "vertical") => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase text-ink-muted dark:text-ink-muted">Align</div>
      <div className="flex gap-1">
        <IconBtn title="Align left"     disabled={!canAlign} onClick={() => onAlign("left")}    ><AlignIcon kind="left" /></IconBtn>
        <IconBtn title="Align center X" disabled={!canAlign} onClick={() => onAlign("centerX")} ><AlignIcon kind="centerX" /></IconBtn>
        <IconBtn title="Align right"    disabled={!canAlign} onClick={() => onAlign("right")}   ><AlignIcon kind="right" /></IconBtn>
        <span className="mx-0.5 w-px self-stretch bg-surface-cool" />
        <IconBtn title="Align top"      disabled={!canAlign} onClick={() => onAlign("top")}     ><AlignIcon kind="top" /></IconBtn>
        <IconBtn title="Align center Y" disabled={!canAlign} onClick={() => onAlign("centerY")} ><AlignIcon kind="centerY" /></IconBtn>
        <IconBtn title="Align bottom"   disabled={!canAlign} onClick={() => onAlign("bottom")}  ><AlignIcon kind="bottom" /></IconBtn>
      </div>
      <div className="mt-2 mb-1 text-[10px] font-semibold uppercase text-ink-muted dark:text-ink-muted">Distribute</div>
      <div className="flex gap-1">
        <IconBtn title="Distribute horizontally" disabled={!canDistribute} onClick={() => onDistribute("horizontal")}><AlignIcon kind="distH" /></IconBtn>
        <IconBtn title="Distribute vertically"   disabled={!canDistribute} onClick={() => onDistribute("vertical")}  ><AlignIcon kind="distV" /></IconBtn>
      </div>
      {!canAlign && (
        <p className="mt-1 text-[10px] text-ink-muted">
          Align/distribute requires the selection to share one parent.
        </p>
      )}
    </div>
  );
}

// Tiny pink guide-line overlay drawn during drag. Positioned in absolute
// canvas coords (same coordinate space as ResizeOverlay).
function GuideOverlay({ lines }: { lines: GuideLine[] }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {lines.map((l, i) => l.kind === "v" ? (
        <div key={i} style={{
          position: "absolute",
          left: l.x - 0.5, top: l.y1, height: l.y2 - l.y1, width: 1,
          background: "rgb(236, 72, 153)",
        }} />
      ) : (
        <div key={i} style={{
          position: "absolute",
          left: l.x1, top: l.y - 0.5, width: l.x2 - l.x1, height: 1,
          background: "rgb(236, 72, 153)",
        }} />
      ))}
    </div>
  );
}

// Build the CSS-equivalent of the node's CommonStyle, plus its absolute
// positioning. `box-sizing: border-box` matches Qt's Rectangle (border draws
// inside the bounds, not outside).
// Geometry-only positioning. The Qt-WASM canvas iframe behind the React
// layer already draws the visible widget (background, border, text, button
// chrome, image, etc.) — keeping React's visual content too would either
// double-up or, worse, diverge from what Basecamp actually renders.
//
// React keeps just the bounding box + rotation here so selection outlines,
// resize handles, and pointer-event capture all line up with the Qt pixels
// underneath.
function commonStyleCss(node: Node): React.CSSProperties {
  const s = node.style;
  return {
    position: "absolute",
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    transform: s.rotation !== 0 ? `rotate(${s.rotation}deg)` : undefined,
    boxSizing: "border-box",
  };
}

function NodeView({
  node,
  selectedIds,
  onSelect,
  onStartMove,
  onCanvasDrop,
  onCanvasDragOver,
  draggingKind,
}: {
  node: Node;
  selectedIds: Set<NodeId>;
  onSelect: (id: NodeId | null, additive: boolean) => void;
  onStartMove: (e: React.PointerEvent, id: NodeId) => void;
  onCanvasDrop: (e: React.DragEvent, frameId: NodeId) => void;
  onCanvasDragOver: (e: React.DragEvent) => void;
  draggingKind: NodeKind | null;
}) {
  // Hidden nodes don't render in the canvas at all (they don't ship to QML
  // either — see qmlEmit.ts). Toggle in the layers panel to bring back.
  if (node.hidden) return null;

  const isSelected = selectedIds.has(node.id);
  const cssStyle = commonStyleCss(node);

  // Selection outline lives on a separate transparent overlay so it doesn't
  // get clipped by overflow:hidden on the styled wrapper.
  const selectionOutline = isSelected
    ? "outline outline-2 outline-offset-[-2px] outline-indigo-500"
    : "hover:outline hover:outline-1 hover:outline-offset-[-1px] hover:outline-indigo-300";

  // Locked nodes are still selectable (so the user can unlock them) but
  // can't be moved or resized. Either way we stop propagation here so the
  // marquee (canvas-level pointerdown) doesn't fire.
  const commonProps = {
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      if (!node.locked) onStartMove(e, node.id);
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(node.id, e.shiftKey || e.metaKey);
    },
  };

  // ── Transparent click-target rendering ─────────────────────────────────
  // The visible widget (text, button chrome, image, slider, …) is drawn by
  // the Qt-WASM canvas iframe behind us — that's the same rendering the
  // user gets in Basecamp, byte-for-byte. The React layer's job here is
  // ONLY to capture pointer events and host editor affordances (selection
  // outline, hover halo, drop highlighting on Frames). All visual content
  // is intentionally absent.
  //
  // Frame is the one exception: when a user has a transparent background
  // we add an editor-only dashed outline so the frame is grabbable in the
  // canvas. Once they assign a background color, Qt draws it and the
  // dashed chrome falls away.

  if (node.kind === "Frame") {
    const editorChrome = node.style.backgroundColor === "transparent"
      ? { border: "1px dashed rgba(0,0,0,0.15)" }
      : null;
    return (
      <div
        {...commonProps}
        className={`cursor-grab active:cursor-grabbing ${selectionOutline}`}
        style={{ ...cssStyle, ...editorChrome }}
        onDragOver={(e) => { onCanvasDragOver(e); }}
        onDrop={(e) => { e.stopPropagation(); onCanvasDrop(e, node.id); }}
      >
        {node.children.map((c) => (
          <NodeView
            key={c.id}
            node={c}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onStartMove={onStartMove}
            onCanvasDrop={onCanvasDrop}
            onCanvasDragOver={onCanvasDragOver}
            draggingKind={draggingKind}
          />
        ))}
      </div>
    );
  }

  // All other node kinds: bare wrapper, no inner content. The Qt iframe
  // shows the widget; the React layer just captures the click.
  return (
    <div
      {...commonProps}
      className={`cursor-grab active:cursor-grabbing ${selectionOutline}`}
      style={cssStyle}
    />
  );
}

// ── Resize overlay ──────────────────────────────────────────────────────────

const ANCHORS: Array<{
  anchor: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  cursor: string;
  // Position as a fraction of the bounding box (0=start, 0.5=mid, 1=end).
  fx: number; fy: number;
}> = [
  { anchor: "nw", cursor: "nwse-resize", fx: 0,   fy: 0   },
  { anchor: "n",  cursor: "ns-resize",   fx: 0.5, fy: 0   },
  { anchor: "ne", cursor: "nesw-resize", fx: 1,   fy: 0   },
  { anchor: "e",  cursor: "ew-resize",   fx: 1,   fy: 0.5 },
  { anchor: "se", cursor: "nwse-resize", fx: 1,   fy: 1   },
  { anchor: "s",  cursor: "ns-resize",   fx: 0.5, fy: 1   },
  { anchor: "sw", cursor: "nesw-resize", fx: 0,   fy: 1   },
  { anchor: "w",  cursor: "ew-resize",   fx: 0,   fy: 0.5 },
];

function ResizeOverlay({
  rect,
  onStart,
}: {
  rect: { x: number; y: number; w: number; h: number };
  onStart: (anchor: typeof ANCHORS[number]["anchor"], e: React.PointerEvent) => void;
}) {
  const HANDLE = 10;
  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      {ANCHORS.map((a) => (
        <div
          key={a.anchor}
          className="pointer-events-auto absolute rounded-sm border border-ink bg-canvas"
          style={{
            width: HANDLE,
            height: HANDLE,
            left: a.fx * rect.w - HANDLE / 2,
            top:  a.fy * rect.h - HANDLE / 2,
            cursor: a.cursor,
          }}
          onPointerDown={(e) => onStart(a.anchor, e)}
        />
      ))}
    </div>
  );
}

// ── Inspector ──────────────────────────────────────────────────────────────

const I_LABEL = "block text-[11px] font-medium text-ink-muted dark:text-ink-muted mb-0.5";
const I_INPUT =
  "w-full rounded border border-border-soft px-1.5 py-1 text-xs focus:border-ink focus:outline-none";
const I_SUMMARY =
  "cursor-pointer text-[11px] font-semibold uppercase text-ink-muted dark:text-ink-muted select-none mb-2";

// Sidebar-panel chrome: one shared `<details>` container that gives every
// left-aside panel a uniform header + collapse affordance. Children are the
// panel's body content (rendered inside a padded container only when open).
// Used so every panel reads as a peer in the sidebar's vertical rhythm
// instead of a series of one-off custom layouts.
function SidebarSection({
  title, defaultOpen = false, badge, headerRight, children,
}: {
  title: string;
  defaultOpen?: boolean;
  badge?: string | number;     // small count / status pill, e.g. "3" or "in use"
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="shrink-0 border-b border-border-subtle [&[open]>summary>span.chev]:rotate-90">
      <summary
        // Reset the native disclosure triangle (`list-none` / Webkit) so we
        // own the visual; the rotating ▸ glyph below is the open indicator.
        className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2.5 transition-colors hover:bg-surface-warm/60/40 list-none [&::-webkit-details-marker]:hidden"
      >
        <span className="chev inline-block text-[10px] text-ink-muted transition-transform">▸</span>
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{title}</span>
        {badge !== undefined && badge !== "" && (
          <span className="rounded-full bg-surface-cool px-1.5 py-0.5 text-[9px] font-medium leading-none text-ink-muted dark:bg-surface-warm dark:text-ink-muted">{badge}</span>
        )}
        {/* Right-side button area (e.g. "+") — stop propagation so clicking
            it doesn't toggle the section. */}
        {headerRight && (
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {headerRight}
          </span>
        )}
      </summary>
      <div className="px-3 pb-3">
        {children}
      </div>
    </details>
  );
}

function NumField({
  label, value, onChange, step = 1,
}: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <label className={I_LABEL}>{label}</label>
      <input
        type="number"
        step={step}
        className={I_INPUT}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
    </div>
  );
}

function TextField({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className={I_LABEL}>{label}</label>
      <input
        className={I_INPUT}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function SelectField<T extends string>({
  label, value, options, onChange,
}: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div>
      <label className={I_LABEL}>{label}</label>
      <select
        className={I_INPUT}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function CheckboxField({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-ink-muted dark:text-ink-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border-soft"
      />
      {label}
    </label>
  );
}

// Color input with native picker swatch + text field. The swatch only
// reflects #rrggbb values; named colors and "transparent" still type-edit
// fine in the text field.
function ColorField({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  const isTransparent = value === "transparent" || value === "";
  return (
    <div>
      <label className={I_LABEL}>{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={isHex ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border-soft p-0"
          title="Pick color"
        />
        <input
          className={I_INPUT}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#rrggbb / transparent"
        />
        <button
          type="button"
          onClick={() => onChange(isTransparent ? "#ffffff" : "transparent")}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
            isTransparent
              ? "border-accent dark:border-accent bg-surface-warm text-accent"
              : "border-border-soft text-ink-muted hover:bg-surface-warm"
          }`}
          title={isTransparent ? "Currently transparent — click to switch to a color" : "Make this transparent (no fill)"}
        >∅</button>
      </div>
    </div>
  );
}

// Two-way binding selector for input widgets. Filters the variable list
// by `acceptType` so users can't bind a TextField to a number variable.
function BindingSelect({
  value, variables, acceptType, onChange,
}: {
  value: string | undefined;
  variables: Variable[];
  acceptType: VariableType;
  onChange: (id: string | undefined) => void;
}) {
  const compatible = variables.filter((v) => v.type === acceptType);
  const stillBound = value && variables.find((v) => v.id === value);
  return (
    <div>
      <label className={I_LABEL}>bind to variable ({acceptType})</label>
      <select
        className={I_INPUT}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">(no binding — use literal)</option>
        {compatible.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </select>
      {value && !stillBound && (
        <p className="mt-1 text-[10px] text-warning">
          Bound variable was deleted — clear or pick a new one.
        </p>
      )}
      {compatible.length === 0 && !value && (
        <p className="mt-1 text-[10px] text-ink-muted">
          No {acceptType} variables defined yet — add one in the left sidebar.
        </p>
      )}
    </div>
  );
}

// Button onClick editor — picks an action kind, then shows kind-specific
// sub-fields. Disabled gracefully when prerequisites are missing
// (e.g. setVariable with no variables defined yet).
function ButtonOnClickEditor({
  action,
  pages,
  variables,
  enabledModuleIds,
  coreModule,
  onChange,
  onAddVariable,
}: {
  action: ButtonAction | undefined;
  pages: PageData[];
  variables: Variable[];
  enabledModuleIds: ModuleId[];
  coreModule: CoreModuleSpec | undefined;
  onChange: (a: ButtonAction) => void;
  // Inline variable creation — when present, the setVariable picker shows
  // a "+ new" button that calls this and immediately wires up the action
  // to the just-created variable id. Saves users a context switch to the
  // sidebar Variables panel.
  onAddVariable?: (preferName?: string) => string;
}) {
  // Catalog primitives + (optionally) the user's own module appear in the
  // same picker. The user's module is shaped into a ModuleSpec so the rest
  // of the editor doesn't need to special-case it.
  const enabledModules: ModuleSpec[] = [
    ...enabledModuleIds
      .map((id) => findModuleSpec(id))
      .filter((m): m is ModuleSpec => m !== undefined),
    ...(coreModule
      ? [{
          id: coreModule.id,
          name: `${coreModule.name || coreModule.id} (this project)`,
          description: coreModule.description || "Your project's own backend module.",
          methods: coreModule.methods.map((m) => ({
            name: m.name, args: m.args,
            returns: m.returns, description: m.description,
          })),
          events: coreModule.events ?? [],
        }]
      : []),
  ];
  const kind = action?.kind ?? "none";
  type ActionKind = "none" | "navigate" | "setVariable" | "openUrl" | "callModule" | "callModuleToVariable" | "sendMessage" | "appendToList" | "if";
  // Modules whose methods return a value — eligible for callModuleToVariable.
  const modulesWithReturningMethods = enabledModules.filter((m) =>
    m.methods.some((mm) => mm.returns !== "void")
  );
  const setKind = (next: ActionKind) => {
    if (next === "none") onChange({ kind: "none" });
    else if (next === "navigate") onChange({ kind: "navigate", pageId: pages[0]?.id ?? "" });
    else if (next === "setVariable") onChange({ kind: "setVariable", varId: variables[0]?.id ?? "", value: "" });
    else if (next === "appendToList") onChange({ kind: "appendToList", varId: variables[0]?.id ?? "", value: "payload", mode: "expression" });
    else if (next === "if") onChange({ kind: "if", condition: "", actions: [] });
    else if (next === "callModule") {
      const m = enabledModules[0];
      const method = m?.methods[0];
      onChange({
        kind: "callModule",
        moduleId: m?.id ?? "",
        method: method?.name ?? "",
        args: (method?.args ?? []).map(() => ({ value: "", mode: "literal" as SetVariableMode })),
      });
    }
    else if (next === "callModuleToVariable") {
      // Default to a module + method that actually returns something so the
      // action does something useful out of the gate.
      const m = modulesWithReturningMethods[0];
      const method = m?.methods.find((mm) => mm.returns !== "void");
      onChange({
        kind: "callModuleToVariable",
        varId: variables[0]?.id ?? "",
        moduleId: m?.id ?? "",
        method: method?.name ?? "",
        args: (method?.args ?? []).map(() => ({ value: "", mode: "literal" as SetVariableMode })),
      });
    }
    else if (next === "sendMessage") {
      onChange({ kind: "sendMessage", topic: "/myapp/1/messages/json", payload: "", payloadMode: "literal" });
    }
    else onChange({ kind: "openUrl", url: "" });
  };
  return (
    <div className="rounded border border-border-subtle p-2">
      <label className={I_LABEL}>on click</label>
      <select
        className={I_INPUT}
        value={kind}
        onChange={(e) => setKind(e.target.value as ActionKind)}
      >
        <option value="none">Do nothing</option>
        <option value="navigate" disabled={pages.length === 0}>Navigate to page</option>
        <option value="setVariable" disabled={variables.length === 0}>Set variable</option>
        <option value="appendToList" disabled={variables.length === 0}>Append to list</option>
        <option value="openUrl">Open URL</option>
        <option value="sendMessage">Send message (delivery)</option>
        <option value="if">If (condition) … then run actions</option>
        <option value="callModule" disabled={enabledModules.length === 0}>Call module method (advanced)</option>
        <option value="callModuleToVariable" disabled={modulesWithReturningMethods.length === 0 || variables.length === 0}>
          Call method and store result in variable
        </option>
      </select>
      {action?.kind === "navigate" && (
        <div className="mt-2">
          <label className={I_LABEL}>page</label>
          <select
            className={I_INPUT}
            value={action.pageId}
            onChange={(e) => onChange({ kind: "navigate", pageId: e.target.value })}
          >
            {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {action?.kind === "setVariable" && (() => {
        const target = variables.find((v) => v.id === action.varId);
        const mode = action.mode ?? "literal";
        const setAction = (patch: Partial<{ varId: string; value: string; mode: SetVariableMode }>) =>
          onChange({
            kind: "setVariable",
            varId: patch.varId ?? action.varId,
            value: patch.value ?? action.value,
            mode: patch.mode ?? mode,
          });
        return (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <div className="flex items-center justify-between">
                <label className={I_LABEL}>variable</label>
                {onAddVariable && (
                  <button
                    type="button"
                    onClick={() => {
                      const id = onAddVariable("var");
                      // Apply immediately so the action points at the new id
                      // without waiting for the parent's variables prop to
                      // re-flow back down.
                      setAction({ varId: id });
                    }}
                    className="text-[10px] text-accent hover:underline"
                  >+ new</button>
                )}
              </div>
              <select
                className={I_INPUT}
                value={action.varId}
                onChange={(e) => setAction({ varId: e.target.value })}
              >
                {variables.length === 0 && <option value="">(create one with + new)</option>}
                {variables.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.type})</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <label className={I_LABEL}>set to</label>
              <button
                onClick={() => setAction({ mode: mode === "literal" ? "expression" : "literal" })}
                className="text-[10px] text-ink-muted dark:text-ink-muted hover:underline"
                title="Switch between literal value and JS-style expression"
              >{mode === "literal" ? "use expression →" : "← use literal"}</button>
            </div>
            {mode === "expression" ? (
              <input
                className={I_INPUT}
                value={action.value}
                onChange={(e) => setAction({ value: e.target.value })}
                placeholder={
                  target?.type === "number" ? "app.var_count + 1" :
                  target?.type === "boolean" ? "!app.var_flag" :
                  '"Hello, " + app.var_name'
                }
              />
            ) : target?.type === "boolean" ? (
              <select
                className={I_INPUT}
                value={action.value === "true" ? "true" : "false"}
                onChange={(e) => setAction({ value: e.target.value })}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            ) : (
              <input
                type={target?.type === "number" ? "number" : "text"}
                className={I_INPUT}
                value={action.value}
                onChange={(e) => setAction({ value: e.target.value })}
                placeholder={target?.type === "number" ? "0" : "value"}
              />
            )}
            {mode === "expression" && (
              <p className="text-[10px] leading-tight text-ink-muted">
                Spliced into QML as-is. Reference state via{" "}
                <span className="font-mono">app.var_*</span>; quote string
                literals.
              </p>
            )}
          </div>
        );
      })()}
      {action?.kind === "openUrl" && (
        <div className="mt-2">
          <label className={I_LABEL}>url</label>
          <input
            type="url"
            className={I_INPUT}
            value={action.url}
            placeholder="https://example.com"
            onChange={(e) => onChange({ kind: "openUrl", url: e.target.value })}
          />
        </div>
      )}
      {action?.kind === "appendToList" && (() => {
        const mode = action.mode ?? "expression";
        const setAppend = (patch: Partial<{ varId: string; value: string; mode: SetVariableMode }>) =>
          onChange({
            kind: "appendToList",
            varId: patch.varId ?? action.varId,
            value: patch.value ?? action.value,
            mode: patch.mode ?? mode,
          });
        return (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <div className="flex items-center justify-between">
                <label className={I_LABEL}>list variable</label>
                {onAddVariable && (
                  <button
                    type="button"
                    onClick={() => {
                      // Auto-create with an array initial so the variable is
                      // immediately usable as a List source.
                      const id = onAddVariable("messages");
                      setAppend({ varId: id });
                    }}
                    className="text-[10px] text-accent hover:underline"
                  >+ new</button>
                )}
              </div>
              <select
                className={I_INPUT}
                value={action.varId}
                onChange={(e) => setAppend({ varId: e.target.value })}
              >
                {variables.length === 0 && <option value="">(create one with + new)</option>}
                {variables.filter((v) => v.type === "string").map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">
                A string variable whose value is a JSON array (e.g. set initial to{" "}
                <span className="font-mono">[]</span>). Bind a List node to the same variable to render every item.
              </p>
            </div>
            <div className="flex items-center justify-between">
              <label className={I_LABEL}>append</label>
              <button
                onClick={() => setAppend({ mode: mode === "literal" ? "expression" : "literal" })}
                className="text-[10px] text-ink-muted hover:underline"
                title="Switch between literal value and JS-style expression"
              >{mode === "literal" ? "use expression →" : "← use literal"}</button>
            </div>
            {mode === "expression" ? (
              <input
                className={I_INPUT}
                value={action.value}
                onChange={(e) => setAppend({ value: e.target.value })}
                placeholder='payload   (or app.var_x, etc.)'
              />
            ) : (
              <input
                type="text"
                className={I_INPUT}
                value={action.value}
                onChange={(e) => setAppend({ value: e.target.value })}
                placeholder="value to append"
              />
            )}
          </div>
        );
      })()}
      {action?.kind === "sendMessage" && (() => {
        const mode = action.payloadMode ?? "literal";
        const setSend = (patch: Partial<{ topic: string; payload: string; payloadMode: SetVariableMode }>) =>
          onChange({
            kind: "sendMessage",
            topic: patch.topic ?? action.topic,
            payload: patch.payload ?? action.payload,
            payloadMode: patch.payloadMode ?? mode,
          });
        return (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <label className={I_LABEL}>content topic</label>
              <input
                className={I_INPUT}
                value={action.topic}
                onChange={(e) => setSend({ topic: e.target.value })}
                placeholder="/myapp/1/messages/json"
              />
              <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">
                Format: <span className="font-mono">/&lt;app&gt;/&lt;version&gt;/&lt;subtopic&gt;/&lt;format&gt;</span>. Anyone subscribed to the same topic receives the message.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className={I_LABEL}>message</label>
                <button
                  onClick={() => setSend({ payloadMode: mode === "literal" ? "expression" : "literal" })}
                  className="text-[10px] text-ink-muted dark:text-ink-muted hover:underline"
                  title="Literal text vs. a QML expression (e.g. read from a variable)"
                >{mode === "literal" ? "use expression →" : "← use literal"}</button>
              </div>
              {mode === "expression" ? (
                <input
                  className={I_INPUT}
                  value={action.payload}
                  onChange={(e) => setSend({ payload: e.target.value })}
                  placeholder='app.var_input'
                />
              ) : (
                <textarea
                  className={I_INPUT}
                  rows={2}
                  value={action.payload}
                  onChange={(e) => setSend({ payload: e.target.value })}
                  placeholder="Hello, world!"
                />
              )}
              {mode === "expression" && (
                <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">
                  Splice in any QML expression — usually <span className="font-mono">app.var_*</span> to send the contents of a Text Field.
                </p>
              )}
            </div>
            <p className="text-[10px] leading-tight text-ink-muted dark:text-ink-muted">
              Delivery is set up automatically — no need to add the module separately.
            </p>
          </div>
        );
      })()}
      {action?.kind === "if" && (() => {
        const inner = action.actions;
        const setIf = (patch: Partial<{ condition: string; actions: ButtonAction[] }>) =>
          onChange({
            kind: "if",
            condition: patch.condition ?? action.condition,
            actions: patch.actions ?? inner,
          });
        const addInner = () => setIf({ actions: [...inner, { kind: "none" }] });
        const updateInner = (idx: number, a: ButtonAction) =>
          setIf({ actions: inner.map((x, i) => (i === idx ? a : x)) });
        const deleteInner = (idx: number) =>
          setIf({ actions: inner.filter((_, i) => i !== idx) });
        return (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <label className={I_LABEL}>condition (JS expression)</label>
              <input
                className={I_INPUT}
                value={action.condition}
                onChange={(e) => setIf({ condition: e.target.value })}
                placeholder='e.g. app.var_count > 5'
              />
              <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">
                Inner actions run only when this expression is truthy. Reference variables via <span className="font-mono">app.var_*</span>; use <span className="font-mono">payload</span> / <span className="font-mono">topic</span> inside on-message triggers.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className={I_LABEL}>then run</label>
                <button
                  type="button"
                  onClick={addInner}
                  className="text-[10px] text-accent hover:underline"
                >+ action</button>
              </div>
              <div className="mt-1 flex flex-col gap-1.5 rounded border border-border-subtle bg-surface-warm/50 dark:bg-surface-warm/40 p-1.5">
                {inner.length === 0 && (
                  <p className="text-[10px] leading-tight text-ink-muted">
                    No inner actions yet. Click <span className="font-mono">+ action</span> to add one.
                  </p>
                )}
                {inner.map((sub, idx) => (
                  <div key={idx} className="rounded border border-border-subtle bg-canvas p-1">
                    <div className="mb-0.5 flex items-center justify-between">
                      <span className="text-[10px] font-mono text-ink-muted">#{idx + 1}</span>
                      <button
                        onClick={() => deleteInner(idx)}
                        className="text-[10px] text-ink-muted hover:text-danger dark:hover:text-danger"
                      >×</button>
                    </div>
                    {/* Recursive editor — supports nested `if`s, etc. */}
                    <ButtonOnClickEditor
                      action={sub}
                      pages={pages}
                      variables={variables}
                      enabledModuleIds={enabledModuleIds}
                      coreModule={coreModule}
                      onChange={(a) => updateInner(idx, a)}
                      onAddVariable={onAddVariable}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
      {action?.kind === "callModule" && (() => {
        const mod = enabledModules.find((m) => m.id === action.moduleId);
        const method = mod?.methods.find((mm) => mm.name === action.method);
        const setMod = (id: string) => {
          const m = enabledModules.find((mm) => mm.id === id);
          const first = m?.methods[0];
          onChange({
            kind: "callModule",
            moduleId: id,
            method: first?.name ?? "",
            args: (first?.args ?? []).map(() => ({ value: "", mode: "literal" as SetVariableMode })),
          });
        };
        const setMethod = (name: string) => {
          const m = mod?.methods.find((mm) => mm.name === name);
          onChange({
            kind: "callModule",
            moduleId: action.moduleId,
            method: name,
            args: (m?.args ?? []).map(() => ({ value: "", mode: "literal" as SetVariableMode })),
          });
        };
        const setArg = (idx: number, patch: Partial<CallModuleArg>) => {
          const next = action.args.slice();
          next[idx] = { ...next[idx], ...patch };
          onChange({ ...action, args: next });
        };
        return (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <label className={I_LABEL}>module</label>
              <select
                className={I_INPUT}
                value={action.moduleId}
                onChange={(e) => setMod(e.target.value)}
              >
                {enabledModules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className={I_LABEL}>method</label>
              <select
                className={I_INPUT}
                value={action.method}
                onChange={(e) => setMethod(e.target.value)}
              >
                {(mod?.methods ?? []).map((mm) => (
                  <option key={mm.name} value={mm.name}>{mm.name}</option>
                ))}
              </select>
              {method?.description && (
                <p className="mt-1 text-[10px] leading-tight text-ink-muted dark:text-ink-muted">{method.description}</p>
              )}
            </div>
            {method && method.args.length > 0 && (
              <div className="flex flex-col gap-2 rounded border border-border-subtle bg-surface-warm p-2">
                <div className="text-[10px] font-semibold uppercase text-ink-muted dark:text-ink-muted">Arguments</div>
                {method.args.map((p, idx) => {
                  const arg = action.args[idx] ?? { value: "", mode: "literal" as SetVariableMode };
                  const mode = arg.mode ?? "literal";
                  return (
                    <div key={p.name}>
                      <div className="flex items-center justify-between">
                        <label className={I_LABEL}>
                          <span className="font-mono">{p.name}</span>{" "}
                          <span className="text-ink-muted">({p.type})</span>
                        </label>
                        <button
                          onClick={() => setArg(idx, { mode: mode === "literal" ? "expression" : "literal" })}
                          className="text-[10px] text-ink-muted dark:text-ink-muted hover:underline"
                        >{mode === "literal" ? "use expression →" : "← use literal"}</button>
                      </div>
                      {mode === "expression" ? (
                        <input
                          className={I_INPUT}
                          value={arg.value}
                          onChange={(e) => setArg(idx, { value: e.target.value })}
                          placeholder={p.type === "string" ? '"text" or app.var_x' : "expression"}
                        />
                      ) : p.type === "boolean" ? (
                        <select
                          className={I_INPUT}
                          value={arg.value === "true" ? "true" : "false"}
                          onChange={(e) => setArg(idx, { value: e.target.value })}
                        >
                          <option value="false">false</option>
                          <option value="true">true</option>
                        </select>
                      ) : (
                        <input
                          type={p.type === "number" ? "number" : "text"}
                          className={I_INPUT}
                          value={arg.value}
                          placeholder={p.type === "number" ? "0" : "value"}
                          onChange={(e) => setArg(idx, { value: e.target.value })}
                        />
                      )}
                      {p.description && (
                        <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">{p.description}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
      {action?.kind === "callModuleToVariable" && (() => {
        // Same shape as callModule but only methods that return non-void are
        // useful here. The chosen variable holds the return value at runtime.
        const mod = modulesWithReturningMethods.find((m) => m.id === action.moduleId);
        const returningMethods = mod?.methods.filter((mm) => mm.returns !== "void") ?? [];
        const method = returningMethods.find((mm) => mm.name === action.method);
        const setMod = (id: string) => {
          const m = modulesWithReturningMethods.find((mm) => mm.id === id);
          const first = m?.methods.find((mm) => mm.returns !== "void");
          onChange({
            kind: "callModuleToVariable",
            varId: action.varId,
            moduleId: id,
            method: first?.name ?? "",
            args: (first?.args ?? []).map(() => ({ value: "", mode: "literal" as SetVariableMode })),
          });
        };
        const setMethod = (name: string) => {
          const m = returningMethods.find((mm) => mm.name === name);
          onChange({
            kind: "callModuleToVariable",
            varId: action.varId,
            moduleId: action.moduleId,
            method: name,
            args: (m?.args ?? []).map(() => ({ value: "", mode: "literal" as SetVariableMode })),
          });
        };
        const setArg = (idx: number, patch: Partial<CallModuleArg>) => {
          const next = action.args.slice();
          next[idx] = { ...next[idx], ...patch };
          onChange({ ...action, args: next });
        };
        const setVarId = (varId: string) => onChange({ ...action, varId });
        return (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <label className={I_LABEL}>store result in</label>
              <div className="flex items-center gap-1">
                <select
                  className={I_INPUT}
                  value={action.varId}
                  onChange={(e) => setVarId(e.target.value)}
                >
                  {variables.map((v) => (
                    <option key={v.id} value={v.id}>{v.name} ({v.type})</option>
                  ))}
                </select>
                {onAddVariable && (
                  <button
                    onClick={() => {
                      const id = onAddVariable("result");
                      setVarId(id);
                    }}
                    className="shrink-0 rounded border border-border-soft px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-cool"
                    title="Create a new variable to hold the result"
                  >+ new</button>
                )}
              </div>
              {method && (
                <p className="mt-1 text-[10px] leading-tight text-ink-muted">
                  Returns <span className="font-mono">{method.returns}</span> — pick a string variable for text, a number variable for numbers, etc.
                </p>
              )}
            </div>
            <div>
              <label className={I_LABEL}>module</label>
              <select
                className={I_INPUT}
                value={action.moduleId}
                onChange={(e) => setMod(e.target.value)}
              >
                {modulesWithReturningMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className={I_LABEL}>method</label>
              <select
                className={I_INPUT}
                value={action.method}
                onChange={(e) => setMethod(e.target.value)}
              >
                {returningMethods.map((mm) => (
                  <option key={mm.name} value={mm.name}>{mm.name}</option>
                ))}
              </select>
              {method?.description && (
                <p className="mt-1 text-[10px] leading-tight text-ink-muted">{method.description}</p>
              )}
            </div>
            {method && method.args.length > 0 && (
              <div className="flex flex-col gap-2 rounded border border-border-subtle bg-surface-warm p-2">
                <div className="text-[10px] font-semibold uppercase text-ink-muted">Arguments</div>
                {method.args.map((p, idx) => {
                  const arg = action.args[idx] ?? { value: "", mode: "literal" as SetVariableMode };
                  const mode = arg.mode ?? "literal";
                  return (
                    <div key={p.name}>
                      <div className="flex items-center justify-between">
                        <label className={I_LABEL}>
                          <span className="font-mono">{p.name}</span>{" "}
                          <span className="text-ink-muted">({p.type})</span>
                        </label>
                        <button
                          onClick={() => setArg(idx, { mode: mode === "literal" ? "expression" : "literal" })}
                          className="text-[10px] text-ink-muted hover:underline"
                        >{mode === "literal" ? "use expression →" : "← use literal"}</button>
                      </div>
                      {mode === "expression" ? (
                        <input
                          className={I_INPUT}
                          value={arg.value}
                          onChange={(e) => setArg(idx, { value: e.target.value })}
                          placeholder={p.type === "string" ? '"text" or app.var_x' : "expression"}
                        />
                      ) : p.type === "boolean" ? (
                        <select
                          className={I_INPUT}
                          value={arg.value === "true" ? "true" : "false"}
                          onChange={(e) => setArg(idx, { value: e.target.value })}
                        >
                          <option value="false">false</option>
                          <option value="true">true</option>
                        </select>
                      ) : (
                        <input
                          type={p.type === "number" ? "number" : "text"}
                          className={I_INPUT}
                          value={arg.value}
                          placeholder={p.type === "number" ? "0" : "value"}
                          onChange={(e) => setArg(idx, { value: e.target.value })}
                        />
                      )}
                      {p.description && (
                        <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">{p.description}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[10px] leading-tight text-ink-muted">
              Note: this captures the method&apos;s synchronous return. If the module fetches over the network and emits the result via an event, use a trigger on the event instead.
            </p>
          </div>
        );
      })()}
    </div>
  );
}

// "Source" picker for Text components — replaces the bare "bind to variable"
// dropdown with three modes:
//   - Static text (default; node.text is the literal)
//   - Variable (existing manual binding; same dropdown as before)
//   - Live from a module (new wizard; creates the variable + triggers +
//     binding atomically via onWireLiveData)
//
// Inferred from current state: if node.binding points at a variable that
// already has triggers feeding it, we render the "wired" summary; otherwise
// we render the picker.
function TextSourcePicker({
  node, variables, enabledModuleIds, coreModule, onChange, onWireLiveData,
}: {
  node: TextNode;
  variables: Variable[];
  enabledModuleIds: ModuleId[];
  coreModule: CoreModuleSpec | undefined;
  onChange: (patch: Partial<TextNode>) => void;
  onWireLiveData?: (spec: LiveDataSpec) => void;
}) {
  type Mode = "static" | "variable" | "live";
  const inferredMode: Mode = node.binding ? "variable" : "static";
  const [mode, setMode] = useState<Mode>(inferredMode);

  // Build the merged enabled-modules list — same shape the rest of the
  // inspector uses, so methods and events from primitives + the user's
  // custom core module both surface here.
  const modulesForPicker: ModuleSpec[] = [
    ...enabledModuleIds
      .map((id) => findModuleSpec(id))
      .filter((m): m is ModuleSpec => m !== undefined),
    ...(coreModule
      ? [{
          id: coreModule.id,
          name: `${coreModule.name || coreModule.id} (this project)`,
          description: coreModule.description || "",
          methods: coreModule.methods.map((m) => ({
            name: m.name, args: m.args, returns: m.returns, description: m.description,
          })),
          events: coreModule.events ?? [],
        }]
      : []),
  ];

  // ── Static + variable modes — no wizard, just present existing UI ─────
  if (mode === "static") {
    return (
      <div className="rounded border border-border-subtle p-2">
        <SourceModeTabs mode={mode} setMode={setMode} hasVariables={variables.length > 0} />
        <p className="mt-2 text-[10px] leading-snug text-ink-muted">
          The Text shows whatever you type below.
        </p>
      </div>
    );
  }

  if (mode === "variable") {
    return (
      <div className="rounded border border-border-subtle p-2">
        <SourceModeTabs mode={mode} setMode={setMode} hasVariables={variables.length > 0} />
        <div className="mt-2">
          <label className={I_LABEL}>variable</label>
          <select
            className={I_INPUT}
            value={node.binding ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ binding: v ? v : undefined });
            }}
          >
            <option value="">(none — use the static text below)</option>
            {variables.map((v) => (
              <option key={v.id} value={v.id}>{v.name} ({v.type})</option>
            ))}
          </select>
          {node.binding && !variables.find((v) => v.id === node.binding) && (
            <p className="mt-1 text-[10px] text-warning">
              Bound variable was deleted — pick a new one or switch sources.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Live mode — the wizard ────────────────────────────────────────────
  return (
    <LiveSourceWizard
      modules={modulesForPicker}
      onChange={(patch) => onChange(patch)}
      onWireLiveData={onWireLiveData}
      onCancel={() => setMode(inferredMode)}
      textNodeId={node.id}
      tabs={<SourceModeTabs mode={mode} setMode={setMode} hasVariables={variables.length > 0} />}
    />
  );
}

function SourceModeTabs({
  mode, setMode, hasVariables,
}: {
  mode: "static" | "variable" | "live";
  setMode: (m: "static" | "variable" | "live") => void;
  hasVariables: boolean;
}) {
  const Tab = ({ id, label, disabled, title }: {
    id: "static" | "variable" | "live"; label: string; disabled?: boolean; title?: string;
  }) => (
    <button
      onClick={() => !disabled && setMode(id)}
      disabled={disabled}
      title={title}
      className={`flex-1 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
        mode === id
          ? "bg-action text-white"
          : disabled
          ? "text-ink-muted dark:text-ink-muted cursor-not-allowed"
          : "text-ink-muted hover:bg-surface-cool"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-0.5 rounded bg-surface-warm p-0.5">
      <Tab id="static"   label="Static" />
      <Tab id="variable" label="Variable" disabled={!hasVariables}
        title={hasVariables ? undefined : "No variables yet — create one in the Logic tab, or use Live mode."} />
      <Tab id="live"     label="✦ Live" />
    </div>
  );
}

// The actual wiring wizard. Combines methods + events into one "Source"
// dropdown, exposes the field picker for events, and surfaces the auto-
// detected kickoff method as an opt-out checkbox.
function LiveSourceWizard({
  modules, onWireLiveData, onCancel, textNodeId, tabs,
}: {
  modules: ModuleSpec[];
  onChange: (patch: Partial<TextNode>) => void;
  onWireLiveData?: (spec: LiveDataSpec) => void;
  onCancel: () => void;
  textNodeId: NodeId;
  tabs: React.ReactNode;
}) {
  const [moduleId, setModuleId] = useState<string>(modules[0]?.id ?? "");
  const mod = modules.find((m) => m.id === moduleId);

  // Methods (string/number/boolean returns, no args — the picker only wires
  // the trivial cases; methods that take args still show but auto-wire
  // assumes empty args, which the user can edit later) + events get
  // collapsed into one "Source" list, prefixed for clarity.
  type SourceOption =
    | { id: string; kind: "method"; methodName: string; returns: VariableType; label: string }
    | { id: string; kind: "event";  eventName: string; argCount: number; label: string };

  const sourceOptions: SourceOption[] = [];
  for (const m of mod?.methods ?? []) {
    if (m.returns === "void") continue;
    if (m.args.length > 0) continue; // keep wizard's surface tight
    sourceOptions.push({
      id: `m:${m.name}`,
      kind: "method",
      methodName: m.name,
      returns: m.returns as VariableType,
      label: `Method: ${m.name} → ${m.returns}`,
    });
  }
  for (const ev of mod?.events ?? []) {
    sourceOptions.push({
      id: `e:${ev.name}`,
      kind: "event",
      eventName: ev.name,
      argCount: ev.data.length,
      label: `Event: ${ev.name}${ev.data.length ? ` (${ev.data.length} field${ev.data.length === 1 ? "" : "s"})` : ""}`,
    });
  }

  const [sourceId, setSourceId] = useState<string>(sourceOptions[0]?.id ?? "");
  const source = sourceOptions.find((s) => s.id === sourceId);

  // Field picker (only for events with multiple payload fields).
  const eventDef = source?.kind === "event"
    ? mod?.events?.find((e) => e.name === source.eventName)
    : undefined;
  const [fieldIdx, setFieldIdx] = useState<number>(0);
  // Reset field index when the source changes so we don't index off the end.
  useEffect(() => { setFieldIdx(0); }, [sourceId, moduleId]);

  // Auto-detected kickoff method for events (heuristic match).
  const methodCandidates = (mod?.methods ?? []).map((m) => ({ name: m.name, argCount: m.args.length }));
  const kickoffSuggestion = source?.kind === "event"
    ? suggestKickoffMethod(source.eventName, methodCandidates)
    : undefined;
  const [includeKickoff, setIncludeKickoff] = useState<boolean>(true);
  // Default to "on" whenever a kickoff suggestion is available and the
  // user changes the source — without this, navigating between events
  // would leave a stale checkbox state.
  useEffect(() => { setIncludeKickoff(true); }, [sourceId, moduleId]);

  // Suggested variable name — derive from event name or method name.
  const varNameHint = source
    ? source.kind === "method"
      ? source.methodName
      : eventDef?.data[fieldIdx]?.name ?? source.eventName
    : "value";

  const canWire = !!source && !!moduleId && !!onWireLiveData;

  const handleWire = () => {
    if (!canWire || !source || !mod) return;
    if (source.kind === "method") {
      onWireLiveData!({
        textNodeId,
        moduleId,
        source: { kind: "method", methodName: source.methodName, returns: source.returns },
        varNameHint,
      });
    } else {
      const field = eventDef?.data[fieldIdx];
      if (!field) return;
      onWireLiveData!({
        textNodeId,
        moduleId,
        source: {
          kind: "event",
          eventName: source.eventName,
          fieldIndex: fieldIdx,
          fieldType: field.type as VariableType,
          kickoffMethod: includeKickoff ? kickoffSuggestion : undefined,
        },
        varNameHint,
      });
    }
  };

  return (
    <div className="rounded border border-border-subtle p-2">
      {tabs}
      {modules.length === 0 ? (
        <p className="mt-3 text-[10px] leading-snug text-ink-muted">
          Enable a module in the Modules tab first, then come back here.
        </p>
      ) : sourceOptions.length === 0 && mod ? (
        <p className="mt-3 text-[10px] leading-snug text-ink-muted">
          <span className="font-mono">{mod.name}</span> doesn&apos;t expose any methods (with no args) or events that we can auto-wire.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <label className={I_LABEL}>module</label>
            <select className={I_INPUT} value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label className={I_LABEL}>show</label>
            <select className={I_INPUT} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sourceOptions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          {eventDef && eventDef.data.length > 1 && (
            <div>
              <label className={I_LABEL}>field</label>
              <select className={I_INPUT} value={fieldIdx} onChange={(e) => setFieldIdx(parseInt(e.target.value, 10) || 0)}>
                {eventDef.data.map((d, i) => (
                  <option key={d.name} value={i}>{d.name} ({d.type})</option>
                ))}
              </select>
            </div>
          )}
          {source?.kind === "event" && kickoffSuggestion && (
            <label className="flex items-start gap-2 text-[10px] leading-snug text-ink-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeKickoff}
                onChange={(e) => setIncludeKickoff(e.target.checked)}
              />
              <span>
                Call <span className="font-mono">{kickoffSuggestion}()</span> on app load to start the fetch.{" "}
                <span className="text-ink-muted">Without this, the event never fires.</span>
              </span>
            </label>
          )}
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={handleWire}
              disabled={!canWire}
              className="flex-1 rounded bg-action px-3 py-1.5 text-[11px] font-medium text-white hover:bg-surface-warm0 disabled:opacity-40"
            >
              ✦ Wire it up
            </button>
            <button
              onClick={onCancel}
              className="rounded border border-border-soft px-2 py-1 text-[10px] text-ink-muted hover:bg-surface-cool"
            >
              Cancel
            </button>
          </div>
          <p className="text-[10px] leading-snug text-ink-muted">
            Wiring creates a variable + the triggers needed to keep it updated, then binds this Text to it. You can edit the result in the Logic tab.
          </p>
        </div>
      )}
    </div>
  );
}

function Inspector({
  node,
  isRoot,
  onChange,
  pages,
  variables,
  enabledModuleIds,
  coreModule,
  onAddVariable,
  onWireLiveData,
}: {
  node: Node;
  isRoot: boolean;
  onChange: (patch: Partial<Node>) => void;
  pages: PageData[];
  variables: Variable[];
  enabledModuleIds: ModuleId[];
  coreModule: CoreModuleSpec | undefined;
  onAddVariable?: (preferName?: string) => string;
  // One-shot "Show live data" wiring — creates the variable + triggers +
  // binding atomically. Inspector calls this from the Text Source picker.
  onWireLiveData?: (spec: LiveDataSpec) => void;
}) {
  // Style is nested — patch helper builds {style: {...node.style, ...patch}}
  const updateStyle = (patch: Partial<typeof node.style>) =>
    onChange({ style: { ...node.style, ...patch } } as Partial<Node>);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[11px] text-ink-muted dark:text-ink-muted">
        kind: <span className="font-mono">{node.kind}</span>
      </div>

      {/* Position + size */}
      <details open>
        <summary className={I_SUMMARY}>Position</summary>
        {isRoot ? (
          <div className="text-[11px] text-ink-muted dark:text-ink-muted">
            <div className="mb-1">
              size <span className="font-mono">{node.width}×{node.height}px</span>
            </div>
            <div className="text-ink-muted">auto-sized to the live preview</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <NumField label="x"      value={node.x}      onChange={(v) => onChange({ x: v } as Partial<Node>)} />
            <NumField label="y"      value={node.y}      onChange={(v) => onChange({ y: v } as Partial<Node>)} />
            <NumField label="width"  value={node.width}  onChange={(v) => onChange({ width:  Math.max(1, v) } as Partial<Node>)} />
            <NumField label="height" value={node.height} onChange={(v) => onChange({ height: Math.max(1, v) } as Partial<Node>)} />
          </div>
        )}
      </details>

      {/* Style — universal */}
      <details open>
        <summary className={I_SUMMARY}>Fill & border</summary>
        <div className="flex flex-col gap-2.5">
          <ColorField
            label="background"
            value={node.style.backgroundColor}
            onChange={(v) => updateStyle({ backgroundColor: v })}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumField label="border w" value={node.style.borderWidth} onChange={(v) => updateStyle({ borderWidth: Math.max(0, v) })} />
            <NumField label="radius"   value={node.style.borderRadius} onChange={(v) => updateStyle({ borderRadius: Math.max(0, v) })} />
          </div>
          <ColorField
            label="border color"
            value={node.style.borderColor}
            onChange={(v) => updateStyle({ borderColor: v })}
          />
        </div>
      </details>

      {/* Advanced — opacity / rotation / conditional visibility. Closed by
          default so the inspector isn't a wall of fields the moment a node
          is selected; users who need them open it explicitly. */}
      <details>
        <summary className={I_SUMMARY}>Advanced</summary>
        <div className="flex flex-col gap-2.5">
          <NumField
            label="opacity (0–1)"
            step={0.05}
            value={node.style.opacity}
            onChange={(v) => updateStyle({ opacity: Math.max(0, Math.min(1, v)) })}
          />
          <NumField
            label="rotation (°)"
            value={node.style.rotation}
            onChange={(v) => updateStyle({ rotation: v })}
          />
          <div>
            <label className={I_LABEL}>visible when (QML expression)</label>
            <input
              className={I_INPUT}
              value={node.visibleWhen ?? ""}
              placeholder="(always visible)"
              onChange={(e) => onChange({ visibleWhen: e.target.value || undefined } as Partial<Node>)}
            />
            <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">
              Empty = always shown. Examples:{" "}
              <span className="font-mono">app.var_active</span> · {" "}
              <span className="font-mono">app.var_count &gt; 0</span>
            </p>
          </div>
        </div>
      </details>

      {/* Type-specific */}
      {node.kind === "Text" && (
        <details open>
          <summary className={I_SUMMARY}>Text</summary>
          <div className="flex flex-col gap-2.5">
            <TextSourcePicker
              node={node as TextNode}
              variables={variables}
              enabledModuleIds={enabledModuleIds}
              coreModule={coreModule}
              onChange={(patch) => onChange(patch as Partial<Node>)}
              onWireLiveData={onWireLiveData}
            />
            <TextField
              label={node.binding ? "fallback content" : "content"}
              value={node.text}
              onChange={(v) => onChange({ text: v } as Partial<LeafNode>)}
            />
            <div className="grid grid-cols-2 gap-2">
              <NumField label="pixelSize" value={node.pixelSize}
                onChange={(v) => onChange({ pixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
              <ColorField label="color" value={node.color}
                onChange={(v) => onChange({ color: v } as Partial<LeafNode>)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SelectField<"normal" | "bold">
                label="weight"
                value={node.fontWeight}
                options={["normal", "bold"] as const}
                onChange={(v) => onChange({ fontWeight: v } as Partial<LeafNode>)}
              />
              <SelectField<"left" | "center" | "right">
                label="align"
                value={node.textAlign}
                options={["left", "center", "right"] as const}
                onChange={(v) => onChange({ textAlign: v } as Partial<LeafNode>)}
              />
            </div>
            <CheckboxField
              label="italic"
              checked={node.italic}
              onChange={(v) => onChange({ italic: v } as Partial<LeafNode>)}
            />
            <TextField
              label="font family"
              placeholder="(default)"
              value={node.fontFamily}
              onChange={(v) => onChange({ fontFamily: v } as Partial<LeafNode>)}
            />
            <div className="grid grid-cols-2 gap-2">
              <NumField label="letter sp" step={0.1} value={node.letterSpacing}
                onChange={(v) => onChange({ letterSpacing: v } as Partial<LeafNode>)} />
              <NumField label="line height" step={0.1} value={node.lineHeight}
                onChange={(v) => onChange({ lineHeight: Math.max(0.1, v) } as Partial<LeafNode>)} />
            </div>
          </div>
        </details>
      )}

      {node.kind === "Button" && (
        <details open>
          <summary className={I_SUMMARY}>Button</summary>
          <div className="flex flex-col gap-2.5">
            <TextField label="label" value={node.text} onChange={(v) => onChange({ text: v } as Partial<LeafNode>)} />
            <ColorField label="text color" value={node.textColor}
              onChange={(v) => onChange({ textColor: v } as Partial<LeafNode>)} />
            <SelectField<"normal" | "bold">
              label="weight"
              value={node.fontWeight}
              options={["normal", "bold"] as const}
              onChange={(v) => onChange({ fontWeight: v } as Partial<LeafNode>)}
            />
            <ButtonOnClickEditor
              action={node.onClick}
              pages={pages}
              variables={variables}
              enabledModuleIds={enabledModuleIds}
              coreModule={coreModule}
              onChange={(action) => onChange({ onClick: action } as Partial<ButtonNode>)}
              onAddVariable={onAddVariable}
            />
          </div>
        </details>
      )}

      {node.kind === "Image" && (
        <ImageSection node={node} onChange={onChange} />
      )}

      {node.kind === "TextField" && (
        <details open>
          <summary className={I_SUMMARY}>TextField</summary>
          <div className="flex flex-col gap-2.5">
            <BindingSelect
              value={node.binding}
              variables={variables}
              acceptType="string"
              onChange={(id) => onChange({ binding: id } as Partial<LeafNode>)}
            />
            <TextField
              label={node.binding ? "fallback value" : "value"}
              value={node.text}
              onChange={(v) => onChange({ text: v } as Partial<LeafNode>)}
            />
            <TextField label="placeholder" value={node.placeholder}
              onChange={(v) => onChange({ placeholder: v } as Partial<LeafNode>)} />
            <NumField label="pixelSize" value={node.pixelSize}
              onChange={(v) => onChange({ pixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
            <CheckboxField label="readOnly" checked={node.readOnly}
              onChange={(v) => onChange({ readOnly: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {(node.kind === "CheckBox" || node.kind === "Switch") && (
        <details open>
          <summary className={I_SUMMARY}>{node.kind}</summary>
          <div className="flex flex-col gap-2.5">
            <BindingSelect
              value={node.binding}
              variables={variables}
              acceptType="boolean"
              onChange={(id) => onChange({ binding: id } as Partial<LeafNode>)}
            />
            <TextField label="label" value={node.text}
              onChange={(v) => onChange({ text: v } as Partial<LeafNode>)} />
            <NumField label="pixelSize" value={node.pixelSize}
              onChange={(v) => onChange({ pixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
            <CheckboxField label={node.binding ? "fallback checked" : "checked"} checked={node.checked}
              onChange={(v) => onChange({ checked: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "Slider" && (
        <details open>
          <summary className={I_SUMMARY}>Slider</summary>
          <div className="flex flex-col gap-2.5">
            <BindingSelect
              value={node.binding}
              variables={variables}
              acceptType="number"
              onChange={(id) => onChange({ binding: id } as Partial<LeafNode>)}
            />
            <div className="grid grid-cols-2 gap-2">
              <NumField label="from" value={node.from}
                onChange={(v) => onChange({ from: v } as Partial<LeafNode>)} />
              <NumField label="to" value={node.to}
                onChange={(v) => onChange({ to: v } as Partial<LeafNode>)} />
            </div>
            <NumField label={node.binding ? "fallback value" : "value"} value={node.value}
              onChange={(v) => onChange({ value: v } as Partial<LeafNode>)} />
            <NumField label="step" step={0.01} value={node.stepSize}
              onChange={(v) => onChange({ stepSize: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "ProgressBar" && (
        <details open>
          <summary className={I_SUMMARY}>Progress</summary>
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-2 gap-2">
              <NumField label="from" value={node.from}
                onChange={(v) => onChange({ from: v } as Partial<LeafNode>)} />
              <NumField label="to" value={node.to}
                onChange={(v) => onChange({ to: v } as Partial<LeafNode>)} />
            </div>
            <NumField label="value" value={node.value}
              onChange={(v) => onChange({ value: v } as Partial<LeafNode>)} />
            <CheckboxField label="indeterminate" checked={node.indeterminate}
              onChange={(v) => onChange({ indeterminate: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "TextArea" && (
        <details open>
          <summary className={I_SUMMARY}>TextArea</summary>
          <div className="flex flex-col gap-2.5">
            <BindingSelect
              value={node.binding}
              variables={variables}
              acceptType="string"
              onChange={(id) => onChange({ binding: id } as Partial<LeafNode>)}
            />
            <TextField label={node.binding ? "fallback value" : "value"} value={node.text}
              onChange={(v) => onChange({ text: v } as Partial<LeafNode>)} />
            <TextField label="placeholder" value={node.placeholder}
              onChange={(v) => onChange({ placeholder: v } as Partial<LeafNode>)} />
            <NumField label="pixelSize" value={node.pixelSize}
              onChange={(v) => onChange({ pixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
            <SelectField<"none" | "word">
              label="wrap"
              value={node.wrapMode}
              options={["none", "word"] as const}
              onChange={(v) => onChange({ wrapMode: v } as Partial<LeafNode>)}
            />
            <CheckboxField label="readOnly" checked={node.readOnly}
              onChange={(v) => onChange({ readOnly: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "RadioButton" && (
        <details open>
          <summary className={I_SUMMARY}>RadioButton</summary>
          <div className="flex flex-col gap-2.5">
            <TextField label="label" value={node.text}
              onChange={(v) => onChange({ text: v } as Partial<LeafNode>)} />
            <NumField label="pixelSize" value={node.pixelSize}
              onChange={(v) => onChange({ pixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
            <CheckboxField label="checked" checked={node.checked}
              onChange={(v) => onChange({ checked: v } as Partial<LeafNode>)} />
            <p className="text-[11px] leading-tight text-ink-muted dark:text-ink-muted">
              Wire multiple radios to a shared ButtonGroup post-export for
              mutual exclusion.
            </p>
          </div>
        </details>
      )}

      {node.kind === "ComboBox" && (
        <details open>
          <summary className={I_SUMMARY}>ComboBox</summary>
          <div className="flex flex-col gap-2.5">
            <ModelListField
              value={node.model}
              onChange={(v) =>
                onChange({
                  model: v,
                  currentIndex: Math.min(node.currentIndex, Math.max(0, v.length - 1)),
                } as Partial<LeafNode>)
              }
            />
            <NumField label="currentIndex" value={node.currentIndex}
              onChange={(v) =>
                onChange({
                  currentIndex: Math.max(0, Math.min(v, Math.max(0, node.model.length - 1))),
                } as Partial<LeafNode>)
              } />
            <NumField label="pixelSize" value={node.pixelSize}
              onChange={(v) => onChange({ pixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "SpinBox" && (
        <details open>
          <summary className={I_SUMMARY}>SpinBox</summary>
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-2 gap-2">
              <NumField label="from" value={node.from}
                onChange={(v) => onChange({ from: v } as Partial<LeafNode>)} />
              <NumField label="to" value={node.to}
                onChange={(v) => onChange({ to: v } as Partial<LeafNode>)} />
            </div>
            <NumField label="value" value={node.value}
              onChange={(v) => onChange({ value: v } as Partial<LeafNode>)} />
            <NumField label="step" value={node.stepSize}
              onChange={(v) => onChange({ stepSize: v } as Partial<LeafNode>)} />
            <CheckboxField label="editable" checked={node.editable}
              onChange={(v) => onChange({ editable: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "BusyIndicator" && (
        <details open>
          <summary className={I_SUMMARY}>BusyIndicator</summary>
          <div className="flex flex-col gap-2.5">
            <CheckboxField label="running" checked={node.running}
              onChange={(v) => onChange({ running: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "AnimatedImage" && (
        <details open>
          <summary className={I_SUMMARY}>AnimatedImage</summary>
          <div className="flex flex-col gap-2.5">
            <TextField label="src" value={node.src}
              onChange={(v) => onChange({ src: v } as Partial<LeafNode>)} />
            <SelectField<ImageFit>
              label="fit"
              value={node.fit}
              options={["fill", "contain", "cover", "none", "scale-down"] as const}
              onChange={(v) => onChange({ fit: v } as Partial<LeafNode>)}
            />
            <CheckboxField label="playing" checked={node.playing}
              onChange={(v) => onChange({ playing: v } as Partial<LeafNode>)} />
            <p className="text-[11px] leading-tight text-ink-muted dark:text-ink-muted">
              For local files, paste a data: URL or use the Image upload as
              a starting point. GIF / animated WebP recommended.
            </p>
          </div>
        </details>
      )}

      {node.kind === "List" && (
        <details open>
          <summary className={I_SUMMARY}>List</summary>
          <div className="flex flex-col gap-2.5">
            <div>
              <label className={I_LABEL}>data variable (JSON array)</label>
              <select
                className={I_INPUT}
                value={node.dataVar ?? ""}
                onChange={(e) => onChange({ dataVar: e.target.value || undefined } as Partial<LeafNode>)}
              >
                <option value="">(none)</option>
                {variables.filter((v) => v.type === "string").map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <p className="mt-0.5 text-[10px] leading-tight text-ink-muted">
                String variable whose value is a JSON array — e.g. set its initial to{" "}
                <span className="font-mono">[&quot;hello&quot;,&quot;world&quot;]</span> for a 2-row preview, then update it at runtime via <span className="font-mono">setVariable</span> or by polling a relay method.
              </p>
            </div>
            <SelectField<ListDirection>
              label="direction"
              value={node.direction}
              options={["vertical", "horizontal"] as const}
              onChange={(v) => onChange({ direction: v } as Partial<LeafNode>)}
            />
            <div className="grid grid-cols-2 gap-2">
              <NumField label="gap (px)" value={node.gap}
                onChange={(v) => onChange({ gap: Math.max(0, v) } as Partial<LeafNode>)} />
              <NumField label="item size" value={node.itemPixelSize}
                onChange={(v) => onChange({ itemPixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
            </div>
            <ColorField label="item color" value={node.itemColor}
              onChange={(v) => onChange({ itemColor: v } as Partial<LeafNode>)} />
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-ink-muted select-none">
                Item bubble (chat-style)
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <ColorField label="bubble bg" value={node.itemBackgroundColor}
                  onChange={(v) => onChange({ itemBackgroundColor: v } as Partial<LeafNode>)} />
                <div className="grid grid-cols-2 gap-2">
                  <NumField label="bubble radius" value={node.itemBorderRadius}
                    onChange={(v) => onChange({ itemBorderRadius: Math.max(0, v) } as Partial<LeafNode>)} />
                  <NumField label="bubble padding" value={node.itemPadding}
                    onChange={(v) => onChange({ itemPadding: Math.max(0, v) } as Partial<LeafNode>)} />
                </div>
                <p className="text-[10px] leading-tight text-ink-muted">
                  Set a bg colour, radius, and padding to render each item as a chat bubble. Leave bg transparent and radius/padding 0 for plain text.
                </p>
              </div>
            </details>
          </div>
        </details>
      )}
    </div>
  );
}

// Editor for ComboBox.model — a list of strings the user can add to / remove
// from / reorder. Plain inputs; reordering is up/down chevrons (no drag).
function ModelListField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const update = (i: number, v: string) => {
    const next = [...value]; next[i] = v; onChange(next);
  };
  const add = () => onChange([...value, `Option ${value.length + 1}`]);
  const remove = (i: number) =>
    onChange(value.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value]; [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-ink-muted dark:text-ink-muted">model</label>
      {value.map((v, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            value={v}
            onChange={(e) => update(i, e.target.value)}
            className="w-full rounded border border-border-soft px-1.5 py-1 text-xs focus:border-ink focus:outline-none"
          />
          <button
            onClick={() => move(i, -1)}
            disabled={i === 0}
            className="rounded px-1 text-ink-muted dark:text-ink-muted hover:bg-surface-cool disabled:opacity-30"
            title="move up"
          >▲</button>
          <button
            onClick={() => move(i, 1)}
            disabled={i === value.length - 1}
            className="rounded px-1 text-ink-muted dark:text-ink-muted hover:bg-surface-cool disabled:opacity-30"
            title="move down"
          >▼</button>
          <button
            onClick={() => remove(i)}
            className="rounded px-1 text-danger hover:bg-danger-bg"
            title="delete"
          >×</button>
        </div>
      ))}
      <button
        onClick={add}
        className="self-start rounded border border-dashed border-border-soft px-2 py-1 text-[11px] text-ink-muted dark:text-ink-muted hover:border-border-soft"
      >+ add option</button>
    </div>
  );
}

// Separate component so it can manage its own hidden file input.
function ImageSection({
  node,
  onChange,
}: {
  node: ImageNode;
  onChange: (patch: Partial<Node>) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const onPick = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const r = new FileReader();
    r.onload = () => onChange({ src: r.result as string } as Partial<ImageNode>);
    r.readAsDataURL(file);
  };
  return (
    <details open>
      <summary className={I_SUMMARY}>Image</summary>
      <div className="flex flex-col gap-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={node.src}
          alt=""
          className="h-20 w-full rounded border border-border-subtle bg-surface-warm object-contain"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = "";
          }}
        />
        <button
          className="w-full rounded border border-border-soft bg-canvas px-1.5 py-1 text-xs hover:border-border-soft dark:border-border-soft"
          onClick={() => fileRef.current?.click()}
        >
          Replace image…
        </button>
        <SelectField<ImageFit>
          label="fit"
          value={node.fit}
          options={["fill", "contain", "cover", "none", "scale-down"] as const}
          onChange={(v) => onChange({ fit: v } as Partial<ImageNode>)}
        />
      </div>
    </details>
  );
}

// ── ModulePanel (unchanged) ────────────────────────────────────────────────

function ModulePanel({
  meta,
  onChange,
  iconPreviewUrl,
  iconFilename,
  iconError,
  onIconUpload,
  onGenerateIcon,
  iconGenerating,
  sanitizedName,
}: {
  meta: ModuleMeta;
  onChange: (m: ModuleMeta) => void;
  iconPreviewUrl: string | null;
  iconFilename: string;
  iconError: string | null;
  onIconUpload: (f: File) => void;
  onGenerateIcon: () => void;
  iconGenerating: boolean;
  sanitizedName: string;
}) {
  const labelClass = "block text-[11px] font-medium text-ink-muted dark:text-ink-muted mb-0.5";
  const inputClass =
    "w-full rounded border border-border-soft px-1.5 py-1 text-xs focus:border-ink focus:outline-none";
  const fileInputRef = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<ModuleMeta>) => onChange({ ...meta, ...patch });

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase text-ink-muted dark:text-ink-muted">
        Module
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start gap-2">
          {iconPreviewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={iconPreviewUrl}
              alt="icon"
              className="h-12 w-12 shrink-0 rounded border border-border-subtle bg-surface-warm object-contain"
            />
          )}
          <div className="flex-1 min-w-0">
            <label className={labelClass}>icon (PNG)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onIconUpload(f);
                e.target.value = "";
              }}
            />
            <div className="flex gap-1">
              <button
                className="flex-1 truncate rounded border border-border-soft bg-canvas px-1.5 py-1 text-left text-xs hover:border-border-soft dark:border-border-soft"
                onClick={() => fileInputRef.current?.click()}
                title={iconFilename}
              >
                {iconFilename}
              </button>
              <button
                onClick={onGenerateIcon}
                disabled={iconGenerating}
                className="shrink-0 rounded gradient-accent px-1.5 py-1 text-[10px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                title="Generate icon with AI based on module name and description"
              >
                {iconGenerating ? "..." : "AI"}
              </button>
            </div>
            {iconError && <p className="mt-1 text-[11px] text-danger">{iconError}</p>}
          </div>
        </div>

        <div>
          <label className={labelClass}>name</label>
          <input
            className={inputClass}
            value={meta.name}
            onChange={(e) => update({ name: e.target.value })}
          />
          {sanitizedName !== meta.name.toLowerCase() && (
            <p className="mt-0.5 text-[11px] text-ink-muted dark:text-ink-muted">
              ships as <span className="font-mono">{sanitizedName}</span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>version</label>
            <input
              className={inputClass}
              value={meta.version}
              onChange={(e) => update({ version: e.target.value })}
              placeholder="0.1.0"
            />
          </div>
          <div>
            <label className={labelClass}>category</label>
            <input
              className={inputClass}
              value={meta.category}
              onChange={(e) => update({ category: e.target.value })}
              placeholder="example"
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>author</label>
          <input
            className={inputClass}
            value={meta.author}
            onChange={(e) => update({ author: e.target.value })}
            placeholder="(optional)"
          />
        </div>

        <div>
          <label className={labelClass}>description</label>
          <textarea
            className={`${inputClass} resize-none`}
            rows={2}
            value={meta.description}
            onChange={(e) => update({ description: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

// ── LayersPanel ────────────────────────────────────────────────────────────
//
// Tree view of the canvas: indent by depth, click-to-select, eye/lock
// toggles per row, chevron to expand/collapse Frames, drag a row onto
// another to reorder/reparent.
//
// Drop target zones (per hovered row):
//   • upper half        → insert as a sibling BEFORE the row
//   • lower half        → insert as a sibling AFTER the row
//   • middle of a Frame → append as the LAST child of that Frame

const IconEye = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    {off ? (
      <>
        <path d="M2.5 8 C 4.5 5.5 8 4.5 11 5.5 M 13.5 8 C 12.5 9.5 11 10.5 9.5 11"
              fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <path d="M2.5 13 L 13.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </>
    ) : (
      <>
        <path d="M1.5 8 C 3.5 4.5 6 4 8 4 C 10 4 12.5 4.5 14.5 8 C 12.5 11.5 10 12 8 12 C 6 12 3.5 11.5 1.5 8 Z"
              fill="none" stroke="currentColor" strokeWidth="1.2"/>
        <circle cx="8" cy="8" r="1.7" fill="currentColor"/>
      </>
    )}
  </svg>
);

const IconLock = ({ locked }: { locked: boolean }) => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1"
          fill={locked ? "currentColor" : "none"}
          stroke="currentColor" strokeWidth="1.2"/>
    <path d="M5.5 7 V 5 a 2.5 2.5 0 0 1 5 0 V 7"
          fill="none" stroke="currentColor" strokeWidth="1.2"/>
  </svg>
);

// Per-kind 14×14 SVG glyphs, single-color so they inherit currentColor.
// Used in both the components palette (top-left) and the Layers tree so the
// user can scan node kinds at a glance.
function NodeIcon({ kind, className = "" }: { kind: NodeKind; className?: string }) {
  const common = {
    width: 14, height: 14, viewBox: "0 0 14 14",
    fill: "none", stroke: "currentColor", strokeWidth: 1.5,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    className: `inline-block shrink-0 ${className}`,
    "aria-hidden": true,
  };
  switch (kind) {
    case "Frame":
      return <svg {...common}><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" strokeDasharray="2 1.5" /></svg>;
    case "Rectangle":
      return <svg {...common}><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" opacity="0.85" /></svg>;
    case "Text":
      return <svg {...common}><path d="M3 3h8M7 3v8M5 11h4" /></svg>;
    case "Button":
      return <svg {...common}><rect x="1.5" y="3.5" width="11" height="7" rx="2" fill="currentColor" stroke="none" opacity="0.85" /></svg>;
    case "Image":
      return <svg {...common}><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" /><circle cx="5" cy="5" r="1" fill="currentColor" stroke="none" /><path d="M2 10l3-3 3 3 2-2 2 2" /></svg>;
    case "AnimatedImage":
      return <svg {...common}><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" /><path d="M5 4.5v5l4-2.5z" fill="currentColor" stroke="none" /></svg>;
    case "TextField":
      return <svg {...common}><rect x="1.5" y="4" width="11" height="6" rx="1.5" /><path d="M4 5.5v3" /></svg>;
    case "TextArea":
      return <svg {...common}><rect x="1.5" y="2" width="11" height="10" rx="1.5" /><path d="M3.5 5h7M3.5 7h7M3.5 9h4" /></svg>;
    case "ComboBox":
      return <svg {...common}><rect x="1.5" y="3.5" width="11" height="7" rx="1.5" /><path d="M9 6l1.5 1.5L12 6" /></svg>;
    case "CheckBox":
      return <svg {...common}><rect x="2.5" y="2.5" width="9" height="9" rx="1.5" /><path d="M5 7l1.5 1.5L9.5 5.5" /></svg>;
    case "RadioButton":
      return <svg {...common}><circle cx="7" cy="7" r="4.5" /><circle cx="7" cy="7" r="2" fill="currentColor" stroke="none" /></svg>;
    case "Switch":
      return <svg {...common}><rect x="1.5" y="4" width="11" height="6" rx="3" /><circle cx="9.5" cy="7" r="1.75" fill="currentColor" stroke="none" /></svg>;
    case "Slider":
      return <svg {...common}><path d="M2 7h10" /><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" /></svg>;
    case "SpinBox":
      return <svg {...common}><rect x="1.5" y="3.5" width="11" height="7" rx="1.5" /><path d="M9 5.5l1 1 1-1M9 8.5l1-1 1 1" /></svg>;
    case "ProgressBar":
      return <svg {...common}><rect x="1.5" y="5.5" width="11" height="3" rx="1.5" /><rect x="1.5" y="5.5" width="6" height="3" rx="1.5" fill="currentColor" stroke="none" /></svg>;
    case "BusyIndicator":
      return <svg {...common}><circle cx="7" cy="7" r="4.5" strokeDasharray="6 3" /></svg>;
    case "List":
      return <svg {...common}><circle cx="3" cy="4" r="0.75" fill="currentColor" stroke="none" /><path d="M5.5 4h6" /><circle cx="3" cy="7" r="0.75" fill="currentColor" stroke="none" /><path d="M5.5 7h6" /><circle cx="3" cy="10" r="0.75" fill="currentColor" stroke="none" /><path d="M5.5 10h6" /></svg>;
  }
}

const trim = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;
const kindLabel = (n: Node): string => {
  if (n.kind === "Text"        && n.text) return `Text · "${trim(n.text, 18)}"`;
  if (n.kind === "Button"      && n.text) return `Button · "${trim(n.text, 18)}"`;
  if (n.kind === "TextField"   && n.placeholder) return `TextField · "${trim(n.placeholder, 16)}"`;
  if (n.kind === "TextArea"    && n.placeholder) return `TextArea · "${trim(n.placeholder, 16)}"`;
  if (n.kind === "ComboBox")              return `ComboBox · ${n.model[n.currentIndex] ?? "(empty)"}`;
  if (n.kind === "CheckBox"    && n.text) return `CheckBox · ${trim(n.text, 16)}`;
  if (n.kind === "RadioButton" && n.text) return `Radio · ${trim(n.text, 16)}`;
  if (n.kind === "Switch"      && n.text) return `Switch · ${trim(n.text, 16)}`;
  if (n.kind === "Slider")                return `Slider · ${n.value}/${n.to}`;
  if (n.kind === "SpinBox")               return `SpinBox · ${n.value}`;
  if (n.kind === "ProgressBar")           return `Progress · ${n.value}/${n.to}`;
  if (n.kind === "BusyIndicator")         return `Busy · ${n.running ? "running" : "stopped"}`;
  return n.kind;
};

// ── PagesPanel ─────────────────────────────────────────────────────────────

function PagesPanel({
  pages,
  currentPageId,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
}: {
  pages: PageData[];
  currentPageId: PageId;
  onSwitch: (id: PageId) => void;
  onAdd: () => void;
  onRename: (id: PageId, name: string) => void;
  onDelete: (id: PageId) => void;
}) {
  const promptRename = (p: PageData) => {
    const next = window.prompt("Rename page", p.name);
    if (next != null && next.trim()) onRename(p.id, next.trim());
  };
  return (
    <SidebarSection
      title="Pages"
      defaultOpen
      badge={pages.length}
      headerRight={
        <button
          onClick={onAdd}
          className="flex h-5 w-5 items-center justify-center rounded border border-border-soft text-xs leading-none text-ink-muted hover:bg-surface-cool"
          title="Add a new page"
        >+</button>
      }
    >
      <div className="flex flex-col gap-0.5">
        {pages.map((p) => {
          const active = p.id === currentPageId;
          return (
            <div
              key={p.id}
              onClick={() => onSwitch(p.id)}
              onDoubleClick={() => promptRename(p)}
              className={`group flex items-center gap-1 rounded px-2 py-1 text-xs cursor-pointer ${
                active ? "bg-surface-warm text-accent dark:text-accent" : "text-ink-muted hover:bg-surface-warm"
              }`}
            >
              <span className="flex-1 truncate" title={p.name}>{p.name}</span>
              {active && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); promptRename(p); }}
                    className="text-[10px] text-ink-muted opacity-0 group-hover:opacity-100 hover:text-ink"
                    title="Rename"
                  >edit</button>
                  {pages.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
                      className="rounded-pill p-1 text-ink-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-danger-bg hover:text-danger"
                      aria-label="Delete page"
                      title="Delete page"
                    >
                      <Trash size={12} weight="duotone" />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] leading-tight text-ink-muted">
        Double-click to rename.
      </p>
    </SidebarSection>
  );
}

// ── VariablesPanel ─────────────────────────────────────────────────────────

// ── TriggersPanel ──────────────────────────────────────────────────────────
//
// Lists every event-driven action handler for the project. Each trigger
// fires when something happens (widget loads / module emits an event) and
// runs an ordered list of actions.

function TriggersPanel({
  triggers,
  pages,
  variables,
  enabledModuleIds,
  coreModule,
  onAdd,
  onUpdate,
  onDelete,
  onAddAction,
  onUpdateAction,
  onDeleteAction,
  onAddVariable,
}: {
  triggers: Trigger[];
  pages: PageData[];
  variables: Variable[];
  enabledModuleIds: ModuleId[];
  coreModule: CoreModuleSpec | undefined;
  onAdd: () => void;
  onUpdate: (id: TriggerId, patch: Partial<Trigger>) => void;
  onDelete: (id: TriggerId) => void;
  onAddAction: (id: TriggerId) => void;
  onUpdateAction: (id: TriggerId, idx: number, action: ButtonAction) => void;
  onDeleteAction: (id: TriggerId, idx: number) => void;
  onAddVariable?: (preferName?: string) => string;
}) {
  const enabledModules: ModuleSpec[] = [
    ...enabledModuleIds
      .map((id) => findModuleSpec(id))
      .filter((m): m is ModuleSpec => m !== undefined),
    ...(coreModule
      ? [{
          id: coreModule.id,
          name: `${coreModule.name || coreModule.id} (this project)`,
          description: coreModule.description || "Your project's own backend module.",
          methods: coreModule.methods.map((m) => ({
            name: m.name, args: m.args,
            returns: m.returns, description: m.description,
          })),
          events: coreModule.events ?? [],
        }]
      : []),
  ];
  return (
    <SidebarSection
      title="Triggers"
      defaultOpen={triggers.length > 0}
      badge={triggers.length > 0 ? triggers.length : undefined}
      headerRight={
        <button
          onClick={onAdd}
          className="flex h-5 w-5 items-center justify-center rounded border border-border-soft text-xs leading-none text-ink-muted hover:bg-surface-cool"
          title="Add a new trigger"
        >+</button>
      }
    >
      <div className="flex flex-col gap-2">
        {triggers.length === 0 && (
          <p className="text-[10px] leading-tight text-ink-muted">
            No triggers yet. React to widget load, intervals, incoming messages, or module events — click + to add one.
          </p>
        )}
        {triggers.map((t) => (
          <TriggerEditor
            key={t.id}
            trigger={t}
            enabledModules={enabledModules}
            pages={pages}
            variables={variables}
            coreModule={coreModule}
            enabledModuleIds={enabledModuleIds}
            onChange={(patch) => onUpdate(t.id, patch)}
            onDelete={() => onDelete(t.id)}
            onAddAction={() => onAddAction(t.id)}
            onUpdateAction={(idx, action) => onUpdateAction(t.id, idx, action)}
            onDeleteAction={(idx) => onDeleteAction(t.id, idx)}
            onAddVariable={onAddVariable}
          />
        ))}
      </div>
    </SidebarSection>
  );
}

function TriggerEditor({
  trigger,
  enabledModules,
  pages,
  variables,
  coreModule,
  enabledModuleIds,
  onChange,
  onDelete,
  onAddAction,
  onUpdateAction,
  onDeleteAction,
  onAddVariable,
}: {
  trigger: Trigger;
  enabledModules: ModuleSpec[];
  pages: PageData[];
  variables: Variable[];
  coreModule: CoreModuleSpec | undefined;
  enabledModuleIds: ModuleId[];
  onChange: (patch: Partial<Trigger>) => void;
  onDelete: () => void;
  onAddAction: () => void;
  onUpdateAction: (idx: number, action: ButtonAction) => void;
  onDeleteAction: (idx: number) => void;
  onAddVariable?: (preferName?: string) => string;
}) {
  const mod = trigger.moduleId
    ? enabledModules.find((m) => m.id === trigger.moduleId)
    : undefined;
  return (
    <div className="rounded border border-border-subtle bg-canvas p-1.5">
      <div className="mb-1 flex items-center gap-1">
        <span className="font-mono text-[10px] uppercase text-ink-muted">
          {trigger.kind === "appStart" ? "on load"
            : trigger.kind === "onMessageReceived" ? "on message"
            : trigger.kind === "interval" ? "every"
            : "on event"}
        </span>
        <span className="flex-1" />
        <button
          onClick={onDelete}
          className="rounded-pill p-1 text-ink-muted transition-colors hover:bg-danger-bg hover:text-danger"
          aria-label="Delete trigger"
          title="Delete trigger"
        >
          <Trash size={12} weight="duotone" />
        </button>
      </div>
      {trigger.kind === "interval" && (
        <div className="mb-1.5 flex items-center gap-1">
          <label className="text-[10px] font-medium text-ink-muted">every</label>
          <input
            type="number"
            min={1}
            step={1}
            className="w-20 rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
            value={trigger.intervalMs ?? 1000}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({ intervalMs: Number.isFinite(n) && n > 0 ? n : 1 });
            }}
          />
          <span className="text-[10px] text-ink-muted">ms — runs the actions below repeatedly while the widget is open. Use 100 for stopwatch-style ticks; 1000+ for polling.</span>
        </div>
      )}
      {trigger.kind === "onMessageReceived" && (
        <div className="mb-1.5 flex flex-col gap-1">
          <label className="text-[10px] font-medium text-ink-muted">topic to listen on</label>
          <input
            className="rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
            value={trigger.topic ?? ""}
            placeholder="/myapp/1/messages/json"
            onChange={(e) => onChange({ topic: e.target.value })}
          />
          {/* Inline cheat-sheet for the two magic identifiers that are in
              scope inside actions on this trigger. New users won't know
              these exist without it. */}
          <div className="mt-1 rounded border border-border-subtle bg-surface-warm/40 px-1.5 py-1 text-[10px] leading-tight text-ink-muted">
            <div className="font-semibold text-ink-muted">In actions below, you can use:</div>
            <div><span className="font-mono text-ink">payload</span> &nbsp;— the incoming message text</div>
            <div><span className="font-mono text-ink">topic</span> &nbsp;— the content topic it came on</div>
            <div className="mt-0.5 text-[9px] text-ink-muted">Use them via the &quot;use expression →&quot; toggle on Set variable / Send message.</div>
          </div>
        </div>
      )}
      {trigger.kind === "moduleEvent" && (
        <div className="mb-1.5 flex items-center gap-1">
          <select
            className="flex-1 rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
            value={trigger.moduleId ?? ""}
            onChange={(e) => {
              const newMod = enabledModules.find((m) => m.id === e.target.value);
              onChange({
                moduleId: e.target.value,
                eventName: newMod?.events?.[0]?.name,
              });
            }}
          >
            {enabledModules.filter((m) => (m.events?.length ?? 0) > 0).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <span className="text-[10px] text-ink-muted">·</span>
          <select
            className="flex-1 rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
            value={trigger.eventName ?? ""}
            onChange={(e) => onChange({ eventName: e.target.value })}
          >
            {(mod?.events ?? []).map((ev) => (
              <option key={ev.name} value={ev.name}>{ev.name}</option>
            ))}
          </select>
        </div>
      )}
      {trigger.kind === "moduleEvent" && mod && trigger.eventName && (() => {
        const ev = mod.events?.find((e) => e.name === trigger.eventName);
        if (!ev) return null;
        return (
          <div className="mb-1.5 rounded bg-surface-warm p-1.5 text-[10px] leading-tight text-ink-muted dark:text-ink-muted">
            {ev.description && <div className="mb-0.5">{ev.description}</div>}
            <div>
              data: <span className="font-mono">[{ev.data.map((d) => `${d.name}: ${d.type}`).join(", ")}]</span>
            </div>
            <div className="text-ink-muted">
              Use <span className="font-mono">data[0]</span>, <span className="font-mono">data[1]</span>, … in expression-mode actions.
            </div>
          </div>
        );
      })()}
      <div className="flex flex-col gap-1.5">
        {trigger.actions.length === 0 && (
          <p className="text-[10px] leading-tight text-ink-muted">No actions. Add one below.</p>
        )}
        {trigger.actions.map((a, idx) => (
          <div key={idx} className="rounded border border-border-subtle bg-surface-warm p-1">
            <div className="mb-0.5 flex items-center justify-between">
              <span className="text-[10px] font-mono text-ink-muted">#{idx + 1}</span>
              <button
                onClick={() => onDeleteAction(idx)}
                className="text-[10px] text-ink-muted dark:text-ink-muted hover:text-danger"
              >×</button>
            </div>
            <ButtonOnClickEditor
              action={a}
              pages={pages}
              variables={variables}
              enabledModuleIds={enabledModuleIds}
              coreModule={coreModule}
              onChange={(action) => onUpdateAction(idx, action)}
              onAddVariable={onAddVariable}
            />
          </div>
        ))}
        <button
          onClick={onAddAction}
          className="self-start rounded border border-border-soft bg-canvas px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-cool"
        >+ action</button>
      </div>
    </div>
  );
}

// ── ModulesPanel ───────────────────────────────────────────────────────────
//
// Two sections: enable Logos primitives (delivery, storage, blockchain,
// wallet — only delivery ships today; the rest render as disabled
// "coming soon" rows for forward visibility), and a "Custom backend
// module" section that surfaces app.coreModule and the AI Build flow.
//
// Toggling a primitive on/off is the single switch that controls whether
// that module's methods appear in every "Call module" inspector dropdown.

interface PrimitiveModuleDef {
  id: ModuleId;
  label: string;
  description: string;
  available: boolean;
}

const PRIMITIVE_MODULES: PrimitiveModuleDef[] = [
  { id: "delivery_module",   label: "Delivery",   description: "Pub/sub messaging over the Logos network.",     available: true  },
  { id: "storage_module",    label: "Storage",    description: "Persistent key-value storage on the device.",   available: false },
  { id: "blockchain_module", label: "Blockchain", description: "On-chain state and transactions.",              available: false },
  { id: "wallet_module",     label: "Wallet",     description: "Account, signing, and balance.",                available: false },
];

function ModulesPanel({
  app,
  onToggle,
  onOpenBuildModule,
  onShowDetails,
}: {
  app: AppState;
  onToggle: (id: ModuleId) => void;
  onOpenBuildModule: () => void;
  onShowDetails: (m: PrimitiveModuleDef) => void;
}) {
  const enabled = (id: ModuleId) => app.modules.includes(id);
  const core = app.coreModule;

  return (
    <>
      <SidebarSection title="Logos modules" defaultOpen badge={app.modules.length || undefined}>
        <div className="space-y-1.5">
          {PRIMITIVE_MODULES.map((m) => {
            const isOn = enabled(m.id);
            const interactive = m.available;
            const baseRow = `flex items-start gap-2 rounded border px-2 py-1.5 ${
              interactive
                ? isOn
                  ? "border-accent bg-surface-warm dark:border-accent dark:bg-surface-warm"
                  : "border-border-subtle"
                : "border-border-subtle bg-surface-warm opacity-60"
            }`;
            return (
              <div key={m.id} className={baseRow}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={interactive ? isOn : false}
                  disabled={!interactive}
                  onChange={() => interactive && onToggle(m.id)}
                  aria-label={`Enable ${m.label}`}
                />
                <button
                  type="button"
                  onClick={() => onShowDetails(m)}
                  className="flex-1 min-w-0 text-left rounded hover:bg-surface-warm/40"
                  title={`Show what ${m.label} can do`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-ink">
                      {m.label}
                    </span>
                    {!m.available && (
                      <span className="rounded bg-surface-cool px-1 py-0.5 text-[9px] font-medium text-ink-muted">
                        coming soon
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-ink-muted">view ›</span>
                  </div>
                  <div className="text-[10px] leading-tight text-ink-muted">
                    {m.description}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] leading-tight text-ink-muted">
          Click a module to see what it can do. Enabled modules&apos; methods appear in any button&apos;s <span className="font-mono">Call module</span> action and in trigger pickers.
        </p>
      </SidebarSection>

      <SidebarSection title="Custom backend module" defaultOpen badge={core ? 1 : undefined}>
        {core ? (
          <div className="rounded border border-accent/30 bg-accent/10 px-2 py-1.5 dark:border-accent/20 dark:bg-accent/5">
            <button
              type="button"
              onClick={() => onShowDetails({
                id: core.id,
                label: core.name || core.id,
                description: core.description || "Custom backend module built by AI for this project.",
                available: true,
              })}
              className="block w-full text-left rounded hover:bg-accent/10 dark:hover:bg-accent/10"
              title="Show what this module can do"
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-ink">
                  {core.name || core.id}
                </span>
                <span className="ml-auto text-[10px] text-ink-muted">view ›</span>
              </div>
              {core.description && (
                <div className="text-[10px] leading-tight text-ink-muted">
                  {core.description}
                </div>
              )}
              <div className="mt-1 text-[10px] text-ink-muted">
                {core.methods.length} method{core.methods.length === 1 ? "" : "s"}
                {core.dependencies.length > 0 && ` · uses ${core.dependencies.join(", ")}`}
              </div>
            </button>
            <button
              onClick={onOpenBuildModule}
              className="mt-2 w-full rounded bg-action px-2 py-1 text-[10px] font-medium text-action-on hover:opacity-90"
            >
              Modify or extend with AI
            </button>
          </div>
        ) : (
          <div className="rounded border border-dashed border-border-soft bg-surface-warm px-2 py-2 text-[10px] leading-tight text-ink-muted dark:text-ink-muted">
            Need backend logic the visual editor can&apos;t express? Describe it in plain English — AI writes the C++.
            <div className="mt-1 text-ink-muted">
              Examples: a relay that drops old messages, a fetcher that pulls from a public API, a stateful aggregator across topics.
            </div>
          </div>
        )}
        {!core && (
          <button
            onClick={onOpenBuildModule}
            className="mt-2 w-full rounded bg-action px-2 py-1.5 text-[11px] font-medium text-action-on hover:opacity-90"
          >
            Build a module
          </button>
        )}
      </SidebarSection>
    </>
  );
}

// ── CoreModulePanel ────────────────────────────────────────────────────────
//
// Author the project's own backend module: id, version, methods table.
// Empty by default; "Add module" stamps a starter spec the user fills in.

function CoreModulePanel({
  spec,
  onEnable,
  onDisable,
  onUpdate,
  onAddMethod,
  onUpdateMethod,
  onDeleteMethod,
  onToggleDep,
  onAddStateField,
  onUpdateStateField,
  onDeleteStateField,
}: {
  spec: CoreModuleSpec | undefined;
  onEnable: () => void;
  onDisable: () => void;
  onUpdate: (patch: Partial<CoreModuleSpec>) => void;
  onAddMethod: () => void;
  onUpdateMethod: (idx: number, patch: Partial<CoreMethod>) => void;
  onDeleteMethod: (idx: number) => void;
  onToggleDep: (depId: string) => void;
  onAddStateField: () => void;
  onUpdateStateField: (idx: number, patch: Partial<CoreStateField>) => void;
  onDeleteStateField: (idx: number) => void;
}) {
  if (!spec) {
    return (
      <SidebarSection
        title="Build a module"
        defaultOpen={false}
        headerRight={
          <button
            onClick={onEnable}
            className="rounded border border-border-soft px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-cool"
            title="Author a custom backend module for this project"
          >+ Add</button>
        }
      >
        <p className="text-[10px] leading-tight text-ink-muted">
          Author your own backend module in C++ (optional). Pick this when you need custom server-side logic that wraps the modules above — e.g. a polling module that uses <span className="font-mono">delivery_module</span>. <span className="text-ink-muted">Skip for UI-only widgets.</span>
        </p>
      </SidebarSection>
    );
  }
  return (
    <SidebarSection
      title="Build a module"
      defaultOpen
      badge={`${spec.methods.length} method${spec.methods.length === 1 ? "" : "s"}`}
      headerRight={
        <button
          onClick={onDisable}
          className="text-[10px] text-danger hover:underline"
        >remove</button>
      }
    >
      <p className="mb-2 text-[10px] leading-tight text-ink-muted">
        Authoring a custom backend (compiled to <span className="font-mono">.lgx</span>). Export produces a buildable C++ project.
      </p>

      <div className="flex flex-col gap-2">
        <div>
          <label className="block text-[10px] text-ink-muted dark:text-ink-muted">id (used in callModule + dependencies)</label>
          <input
            className="w-full rounded border border-border-soft px-1.5 py-1 text-[11px] font-mono"
            value={spec.id}
            onChange={(e) => onUpdate({ id: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-1">
          <div>
            <label className="block text-[10px] text-ink-muted dark:text-ink-muted">version</label>
            <input
              className="w-full rounded border border-border-soft px-1.5 py-1 text-[11px]"
              value={spec.version}
              onChange={(e) => onUpdate({ version: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-[10px] text-ink-muted dark:text-ink-muted">category</label>
            <input
              className="w-full rounded border border-border-soft px-1.5 py-1 text-[11px]"
              value={spec.category}
              onChange={(e) => onUpdate({ category: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-ink-muted dark:text-ink-muted">description</label>
          <input
            className="w-full rounded border border-border-soft px-1.5 py-1 text-[11px]"
            value={spec.description}
            onChange={(e) => onUpdate({ description: e.target.value })}
          />
        </div>

        {/* Dependencies — pick from the catalog of primitives. */}
        <div>
          <label className="block text-[10px] text-ink-muted dark:text-ink-muted">depends on (Logos primitives)</label>
          <div className="flex flex-col gap-0.5">
            {MODULE_CATALOG.map((m) => (
              <label key={m.id} className="flex items-center gap-1 text-[11px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={spec.dependencies.includes(m.id)}
                  onChange={() => onToggleDep(m.id)}
                  className="h-3.5 w-3.5"
                />
                <span className="font-mono">{m.id}</span>
                <span className="text-[10px] text-ink-muted">— {m.name}</span>
              </label>
            ))}
          </div>
        </div>

        {/* State fields */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[10px] text-ink-muted dark:text-ink-muted">state fields (private members)</label>
            <button
              onClick={onAddStateField}
              className="rounded border border-border-soft px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-cool"
            >+ field</button>
          </div>
          {spec.state.length === 0 && (
            <p className="text-[10px] leading-tight text-ink-muted">
              Add typed C++ members like <span className="font-mono">QHash&lt;QString, MyData&gt;</span> — they&apos;re declared as <span className="font-mono">m_&lt;name&gt;</span> in the generated header.
            </p>
          )}
          <div className="flex flex-col gap-1">
            {spec.state.map((s, idx) => (
              <div key={idx} className="flex items-center gap-1">
                <input
                  className="w-20 rounded border border-border-soft bg-canvas px-1 py-0.5 font-mono text-[10px]"
                  value={s.name}
                  onChange={(e) => onUpdateStateField(idx, { name: e.target.value })}
                  placeholder="name"
                />
                <input
                  className="flex-1 rounded border border-border-soft bg-canvas px-1 py-0.5 font-mono text-[10px]"
                  value={s.cppType}
                  onChange={(e) => onUpdateStateField(idx, { cppType: e.target.value })}
                  placeholder="QString"
                />
                <input
                  className="w-16 rounded border border-border-soft bg-canvas px-1 py-0.5 font-mono text-[10px]"
                  value={s.initial ?? ""}
                  onChange={(e) => onUpdateStateField(idx, { initial: e.target.value })}
                  placeholder="init"
                  title="Optional initializer (e.g. 0, &quot;&quot;)"
                />
                <button
                  onClick={() => onDeleteStateField(idx)}
                  className="text-[10px] text-ink-muted dark:text-ink-muted hover:text-danger"
                >×</button>
              </div>
            ))}
          </div>
        </div>

        {/* Methods table */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[10px] text-ink-muted dark:text-ink-muted">methods</label>
            <button
              onClick={onAddMethod}
              className="rounded border border-border-soft px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-cool"
            >+ method</button>
          </div>
          {spec.methods.length === 0 && (
            <p className="text-[10px] leading-tight text-ink-muted">
              No methods yet. Each method becomes a Q_INVOKABLE in the generated C++ and shows up in Button → callModule.
            </p>
          )}
          <div className="flex flex-col gap-2">
            {spec.methods.map((m, idx) => (
              <CoreMethodEditor
                key={idx}
                method={m}
                onChange={(patch) => onUpdateMethod(idx, patch)}
                onDelete={() => onDeleteMethod(idx)}
              />
            ))}
          </div>
        </div>
      </div>
    </SidebarSection>
  );
}

function CoreMethodEditor({
  method, onChange, onDelete,
}: {
  method: CoreMethod;
  onChange: (patch: Partial<CoreMethod>) => void;
  onDelete: () => void;
}) {
  const addArg = () =>
    onChange({ args: [...method.args, { name: `arg${method.args.length + 1}`, type: "string" }] });
  const updateArg = (i: number, patch: Partial<ModuleParam>) => {
    const args = method.args.map((a, idx) => (idx === i ? { ...a, ...patch } : a));
    onChange({ args });
  };
  const deleteArg = (i: number) => {
    onChange({ args: method.args.filter((_, idx) => idx !== i) });
  };
  return (
    <div className="rounded border border-border-subtle bg-surface-warm p-1.5">
      <div className="mb-1 flex items-center gap-1">
        <input
          className="flex-1 rounded border border-border-soft bg-canvas px-1.5 py-0.5 font-mono text-[11px]"
          value={method.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="methodName"
        />
        <select
          className="rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
          value={method.returns}
          onChange={(e) => onChange({ returns: e.target.value as ParamType | "void" })}
        >
          <option value="void">void</option>
          <option value="boolean">bool</option>
          <option value="number">number</option>
          <option value="string">string</option>
        </select>
        <button
          onClick={onDelete}
          className="rounded-pill p-1 text-ink-muted transition-colors hover:bg-danger-bg hover:text-danger"
          aria-label="Delete method"
          title="Delete method"
        >
          <Trash size={12} weight="duotone" />
        </button>
      </div>
      {method.args.length > 0 && (
        <div className="mb-1 flex flex-col gap-0.5">
          {method.args.map((a, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                className="flex-1 rounded border border-border-soft bg-canvas px-1 py-0.5 font-mono text-[10px]"
                value={a.name}
                onChange={(e) => updateArg(i, { name: e.target.value })}
                placeholder="argName"
              />
              <select
                className="rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
                value={a.type}
                onChange={(e) => updateArg(i, { type: e.target.value as ParamType })}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
              </select>
              <button
                onClick={() => deleteArg(i)}
                className="text-[10px] text-ink-muted dark:text-ink-muted hover:text-danger"
              >×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          onClick={addArg}
          className="rounded border border-border-soft bg-canvas px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-cool"
        >+ arg</button>
        <input
          className="flex-1 rounded border border-border-soft bg-canvas px-1.5 py-0.5 text-[10px]"
          value={method.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="(optional description)"
        />
      </div>
      {/* No C++ body editor here — this is a no-code tool. Method bodies
          will be generated from the upcoming no-code logic composer (same
          trigger / action shape as the front-end). For now method bodies
          are TODO stubs in the generated .cpp. */}
    </div>
  );
}

function VariablesPanel({
  variables,
  onAdd,
  onUpdate,
  onDelete,
}: {
  variables: Variable[];
  onAdd: () => void;
  onUpdate: (id: VariableId, patch: Partial<Variable>) => void;
  onDelete: (id: VariableId) => void;
}) {
  return (
    <SidebarSection
      title="Variables"
      defaultOpen={variables.length > 0}
      badge={variables.length > 0 ? variables.length : undefined}
      headerRight={
        <button
          onClick={() => onAdd()}
          className="flex h-5 w-5 items-center justify-center rounded border border-border-soft text-xs leading-none text-ink-muted hover:bg-surface-cool"
          title="Add a new variable"
        >+</button>
      }
    >
      {variables.length === 0 ? (
        <p className="text-[10px] leading-tight text-ink-muted">
          App-level state. Reference from Text bindings or Button → set-variable
          actions. Auto-emits as Qt properties.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {variables.map((v) => (
            <div key={v.id} className="rounded border border-border-subtle p-1.5">
              <div className="mb-1 flex items-center gap-1">
                <input
                  className="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] font-mono hover:border-border-soft focus:border-ink focus:bg-canvas focus:outline-none"
                  value={v.name}
                  onChange={(e) => onUpdate(v.id, { name: e.target.value })}
                />
                <button
                  onClick={() => onDelete(v.id)}
                  className="rounded-pill p-1 text-ink-muted transition-colors hover:bg-danger-bg hover:text-danger"
                  aria-label="Delete variable"
                  title="Delete variable"
                >
                  <Trash size={12} weight="duotone" />
                </button>
              </div>
              <div className="flex items-center gap-1">
                <select
                  className="rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
                  value={v.type}
                  onChange={(e) => onUpdate(v.id, { type: e.target.value as VariableType })}
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
                {v.type === "boolean" ? (
                  <select
                    className="flex-1 rounded border border-border-soft bg-canvas px-1 py-0.5 text-[10px]"
                    value={v.initial === "true" ? "true" : "false"}
                    onChange={(e) => onUpdate(v.id, { initial: e.target.value })}
                  >
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                ) : (
                  <input
                    type={v.type === "number" ? "number" : "text"}
                    className="flex-1 rounded border border-border-soft px-1 py-0.5 text-[10px]"
                    value={v.initial}
                    placeholder={v.type === "number" ? "0" : "initial value"}
                    onChange={(e) => onUpdate(v.id, { initial: e.target.value })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </SidebarSection>
  );
}

type DropWhere = "before" | "after" | "inside";

function LayersPanel({
  root,
  selectedIds,
  onSelect,
  collapsedIds,
  onToggleCollapsed,
  onToggleHidden,
  onToggleLocked,
  onMove,
}: {
  root: FrameNode;
  selectedIds: Set<NodeId>;
  onSelect: (id: NodeId | null, additive: boolean) => void;
  collapsedIds: Set<NodeId>;
  onToggleCollapsed: (id: NodeId) => void;
  onToggleHidden: (id: NodeId) => void;
  onToggleLocked: (id: NodeId) => void;
  onMove: (sourceId: NodeId, newParentId: NodeId, newIndex: number) => void;
}) {
  const [draggingId, setDraggingId] = useState<NodeId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: NodeId; where: DropWhere } | null>(null);

  const handleDragStart = (e: React.DragEvent, id: NodeId) => {
    if (id === root.id) { e.preventDefault(); return; }
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    // Some browsers won't fire drag events without setData.
    e.dataTransfer.setData("text/plain", id);
  };
  const handleDragOver = (e: React.DragEvent, targetId: NodeId, isFrame: boolean) => {
    if (!draggingId || draggingId === targetId) return;
    if (isSelfOrDescendant(root, draggingId, targetId)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    let where: DropWhere;
    if (isFrame && y > h * 0.25 && y < h * 0.75) where = "inside";
    else if (y < h / 2) where = "before";
    else where = "after";
    if (!dropTarget || dropTarget.id !== targetId || dropTarget.where !== where) {
      setDropTarget({ id: targetId, where });
    }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingId || !dropTarget) { reset(); return; }
    const target = findNode(root, dropTarget.id);
    if (!target.node) { reset(); return; }
    if (dropTarget.where === "inside" && isContainer(target.node)) {
      onMove(draggingId, target.node.id, target.node.children.length);
    } else if (target.parent) {
      const idx = dropTarget.where === "before" ? target.index : target.index + 1;
      onMove(draggingId, target.parent.id, idx);
    }
    reset();
  };
  const reset = () => { setDraggingId(null); setDropTarget(null); };

  // Flatten the visible tree into rows.
  const rows: React.ReactNode[] = [];
  const renderRow = (node: Node, depth: number) => {
    const isFrame = isContainer(node);
    const isCollapsed = collapsedIds.has(node.id);
    const isSelected = selectedIds.has(node.id);
    const isRoot = node.id === root.id;
    const dropMark = dropTarget && dropTarget.id === node.id ? dropTarget.where : null;

    rows.push(
      <div
        key={node.id}
        draggable={!isRoot}
        onDragStart={(e) => handleDragStart(e, node.id)}
        onDragOver={(e) => handleDragOver(e, node.id, isFrame)}
        onDrop={handleDrop}
        onDragEnd={reset}
        onClick={(e) => { e.stopPropagation(); onSelect(node.id, e.shiftKey || e.metaKey); }}
        style={{ paddingLeft: 4 + depth * 12 }}
        className={[
          "relative flex items-center gap-1 py-1 pr-2 text-[11px] cursor-pointer select-none",
          isSelected ? "bg-surface-warm text-accent dark:text-accent" : "text-ink-muted hover:bg-surface-warm",
          node.hidden ? "opacity-50" : "",
        ].join(" ")}
      >
        {dropMark === "before" && (
          <div className="pointer-events-none absolute inset-x-0 -top-px h-0.5 bg-surface-warm0" />
        )}
        {dropMark === "after" && (
          <div className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 bg-surface-warm0" />
        )}
        {dropMark === "inside" && (
          <div className="pointer-events-none absolute inset-0 ring-1 ring-indigo-500" />
        )}

        {/* Chevron — only for Frames with children */}
        {isFrame && node.children.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapsed(node.id); }}
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[8px] text-ink-muted dark:text-ink-muted hover:text-ink"
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        <NodeIcon kind={node.kind} className="text-ink-muted" />
        <span className="flex-1 truncate">{kindLabel(node)}</span>

        {!isRoot && (
          <>
            <button
              title={node.locked ? "Unlock" : "Lock"}
              onClick={(e) => { e.stopPropagation(); onToggleLocked(node.id); }}
              className={`shrink-0 ${node.locked ? "text-warning" : "text-ink-muted hover:text-ink-muted"}`}
            >
              <IconLock locked={node.locked} />
            </button>
            <button
              title={node.hidden ? "Show" : "Hide"}
              onClick={(e) => { e.stopPropagation(); onToggleHidden(node.id); }}
              className={`shrink-0 ${node.hidden ? "text-ink-muted" : "text-ink-muted dark:text-ink-muted hover:text-ink-muted"}`}
            >
              <IconEye off={node.hidden} />
            </button>
          </>
        )}
      </div>,
    );
    if (isFrame && !isCollapsed) {
      for (const c of node.children) renderRow(c, depth + 1);
    }
  };
  renderRow(root, 0);

  return <div className="text-xs">{rows}</div>;
}

// ── New Variable modal ─────────────────────────────────────────────────────
//
// Replaces the previous inline "+" → blank row → user retypes flow. Lets
// the user pick name + type + initial value up front so the freshly
// created variable already reflects their intent and doesn't need
// inline-editing afterward. Submits via onCreate({ name, type, initial }).

function NewVariableModal({
  open,
  existingNames,
  onClose,
  onCreate,
}: {
  open: boolean;
  existingNames: string[];
  onClose: () => void;
  onCreate: (cfg: { name: string; type: VariableType; initial: string }) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<VariableType>("string");
  const [initial, setInitial] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset on each open so the modal feels fresh; auto-focus the name input
  // for keyboard-first creation.
  useEffect(() => {
    if (!open) return;
    setName("");
    setType("string");
    setInitial("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Escape closes (no backdrop-click for forms — too easy to lose work).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = name.trim();
  const collides = trimmed.length > 0 && existingNames.includes(trimmed);
  const valid = !collides; // Empty name is fine — addVariable picks a default.

  const submit = () => {
    if (!valid) return;
    // Coerce booleans to a literal so the value is unambiguous downstream.
    const init = type === "boolean"
      ? (initial === "true" ? "true" : "false")
      : initial;
    onCreate({ name: trimmed, type, initial: init });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="flex w-full max-w-[420px] flex-col overflow-hidden rounded-card-lg border border-border-subtle bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New variable"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
          <h2 className="font-display text-[18px] font-medium leading-[1.15] tracking-tight text-ink">
            New variable
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 -mr-1 rounded-pill px-2 py-1 text-[14px] leading-none text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
          >×</button>
        </header>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label htmlFor="newvar-name" className="eyebrow">Name</label>
            <input
              id="newvar-name"
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="counter, lastMessage, isReady"
              className="mt-1.5 w-full rounded-control border border-border-soft bg-canvas px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none"
            />
            {collides && (
              <p className="mt-1 text-[11px] text-danger">
                A variable named <span className="font-mono">{trimmed}</span> already exists.
              </p>
            )}
          </div>

          <div>
            <p className="eyebrow">Type</p>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {(["string", "number", "boolean"] as VariableType[]).map((t) => (
                <label
                  key={t}
                  className={`flex cursor-pointer items-center justify-center rounded-control border px-2 py-1.5 text-[12px] font-medium transition-colors ${
                    type === t
                      ? "border-accent bg-canvas text-ink"
                      : "border-border-subtle bg-canvas text-ink-muted hover:border-border-soft hover:text-ink"
                  }`}
                >
                  <input
                    type="radio"
                    name="newvar-type"
                    value={t}
                    checked={type === t}
                    onChange={() => setType(t)}
                    className="sr-only"
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="newvar-initial" className="eyebrow">Initial value</label>
            {type === "boolean" ? (
              <select
                id="newvar-initial"
                value={initial === "true" ? "true" : "false"}
                onChange={(e) => setInitial(e.target.value)}
                className="mt-1.5 w-full rounded-control border border-border-soft bg-canvas px-3 py-2 text-[12px] text-ink focus:border-accent focus:outline-none"
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            ) : (
              <input
                id="newvar-initial"
                type={type === "number" ? "number" : "text"}
                value={initial}
                onChange={(e) => setInitial(e.target.value)}
                placeholder={type === "number" ? "0" : "(empty)"}
                className="mt-1.5 w-full rounded-control border border-border-soft bg-canvas px-3 py-2 text-[12px] text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none"
              />
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-pill border border-border-soft bg-canvas px-4 py-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
          >Cancel</button>
          <button
            type="submit"
            disabled={!valid}
            className="rounded-pill bg-action px-5 py-1.5 text-[12px] font-medium text-action-on transition-opacity hover:opacity-90 disabled:opacity-40"
          >Create</button>
        </footer>
      </form>
    </div>
  );
}

// ── New Trigger modal ──────────────────────────────────────────────────────
//
// Replaces the previous inline 4-button row (+ load / + tick / + message /
// + event) with a single dedicated modal that picks the kind via radio
// cards and surfaces the kind-specific config (interval ms, topic, module
// + event) up front. Submits via onCreate({ kind, ...kindFields }).

const TRIGGER_KIND_OPTIONS: { kind: TriggerKind; label: string; description: string }[] = [
  { kind: "appStart",          label: "When the widget loads",   description: "Run once at startup. Use for initial fetches or setup." },
  { kind: "interval",          label: "Every N milliseconds",    description: "Polling, stopwatch ticks, periodic UI refreshes." },
  { kind: "onMessageReceived", label: "When a message arrives",  description: "React to incoming delivery_module messages on a topic." },
  { kind: "moduleEvent",       label: "When a module emits an event", description: "Advanced — react to a module's raw event stream." },
];

function NewTriggerModal({
  open,
  enabledModules,
  onClose,
  onCreate,
}: {
  open: boolean;
  enabledModules: ModuleSpec[];
  onClose: () => void;
  onCreate: (cfg: {
    kind: TriggerKind;
    intervalMs?: number;
    topic?: string;
    moduleId?: string;
    eventName?: string;
  }) => void;
}) {
  const [kind, setKind] = useState<TriggerKind>("appStart");
  const [intervalMs, setIntervalMs] = useState(1000);
  const [topic, setTopic] = useState("/myapp/1/messages/json");
  const [moduleId, setModuleId] = useState("");
  const [eventName, setEventName] = useState("");

  const modulesWithEvents = enabledModules.filter((m) => (m.events?.length ?? 0) > 0);

  useEffect(() => {
    if (!open) return;
    setKind("appStart");
    setIntervalMs(1000);
    setTopic("/myapp/1/messages/json");
    // Pre-pick the first module/event so the moduleEvent kind isn't blank.
    const firstMod = modulesWithEvents[0];
    setModuleId(firstMod?.id ?? "");
    setEventName(firstMod?.events?.[0]?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const moduleEventBlocked = kind === "moduleEvent" && modulesWithEvents.length === 0;
  const intervalInvalid = kind === "interval" && (!Number.isFinite(intervalMs) || intervalMs <= 0);
  const valid = !moduleEventBlocked && !intervalInvalid;

  const submit = () => {
    if (!valid) return;
    if (kind === "interval") onCreate({ kind, intervalMs });
    else if (kind === "onMessageReceived") onCreate({ kind, topic: topic.trim() });
    else if (kind === "moduleEvent") onCreate({ kind, moduleId, eventName });
    else onCreate({ kind });
  };

  // Fetch event list for the currently-selected module so the event picker
  // populates correctly.
  const selectedModule = modulesWithEvents.find((m) => m.id === moduleId);
  const events = selectedModule?.events ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-hidden rounded-card-lg border border-border-subtle bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New trigger"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
          <h2 className="font-display text-[18px] font-medium leading-[1.15] tracking-tight text-ink">
            New trigger
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 -mr-1 rounded-pill px-2 py-1 text-[14px] leading-none text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
          >×</button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div>
            <p className="eyebrow">When should it fire?</p>
            <div className="mt-2 space-y-2">
              {TRIGGER_KIND_OPTIONS.map((opt) => {
                const blocked = opt.kind === "moduleEvent" && modulesWithEvents.length === 0;
                return (
                  <label
                    key={opt.kind}
                    className={`flex cursor-pointer items-start gap-3 rounded-card border p-3 transition-colors ${
                      kind === opt.kind
                        ? "border-accent bg-canvas"
                        : "border-border-subtle bg-canvas hover:border-border-soft"
                    } ${blocked ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                    <input
                      type="radio"
                      name="newtrig-kind"
                      value={opt.kind}
                      checked={kind === opt.kind}
                      onChange={() => setKind(opt.kind)}
                      disabled={blocked}
                      className="mt-0.5 h-3.5 w-3.5 accent-ink"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-ink">{opt.label}</div>
                      <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{opt.description}</p>
                      {blocked && (
                        <p className="mt-1 text-[10px] text-warning">
                          No installed module exposes events. Add a module from the Modules tab first.
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Kind-specific fields */}
          {kind === "interval" && (
            <div>
              <label htmlFor="newtrig-interval" className="eyebrow">Interval (milliseconds)</label>
              <input
                id="newtrig-interval"
                type="number"
                min={1}
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value))}
                className="mt-1.5 w-full rounded-control border border-border-soft bg-canvas px-3 py-2 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
              />
              <p className="mt-1 text-[11px] leading-snug text-ink-muted">
                1000 = once a second. 100 ms is fine for stopwatch-style ticks; faster than that wastes CPU.
              </p>
            </div>
          )}

          {kind === "onMessageReceived" && (
            <div>
              <label htmlFor="newtrig-topic" className="eyebrow">Topic</label>
              <input
                id="newtrig-topic"
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="/myapp/1/messages/json"
                className="mt-1.5 w-full rounded-control border border-border-soft bg-canvas px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none"
              />
              <p className="mt-1 text-[11px] leading-snug text-ink-muted">
                A <span className="font-mono">lastMessage</span> variable + a default capture action will be created automatically.
              </p>
            </div>
          )}

          {kind === "moduleEvent" && modulesWithEvents.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="newtrig-module" className="eyebrow">Module</label>
                <select
                  id="newtrig-module"
                  value={moduleId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setModuleId(next);
                    const m = modulesWithEvents.find((mm) => mm.id === next);
                    setEventName(m?.events?.[0]?.name ?? "");
                  }}
                  className="mt-1.5 w-full rounded-control border border-border-soft bg-canvas px-2 py-2 text-[12px] text-ink focus:border-accent focus:outline-none"
                >
                  {modulesWithEvents.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="newtrig-event" className="eyebrow">Event</label>
                <select
                  id="newtrig-event"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  className="mt-1.5 w-full rounded-control border border-border-soft bg-canvas px-2 py-2 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
                >
                  {events.map((ev) => (
                    <option key={ev.name} value={ev.name}>{ev.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-pill border border-border-soft bg-canvas px-4 py-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
          >Cancel</button>
          <button
            type="submit"
            disabled={!valid}
            className="rounded-pill bg-action px-5 py-1.5 text-[12px] font-medium text-action-on transition-opacity hover:opacity-90 disabled:opacity-40"
          >Create</button>
        </footer>
      </form>
    </div>
  );
}

// ── Generated QML modal ────────────────────────────────────────────────────
//
// Read-only viewer for the QML emitted from the current AppState. Pulled
// out of the inspector's inline <details> so the QML has room to breathe
// (~820px wide, mono font, generous line-height) and the inspector stays
// focused on editing the selected node. Includes Copy-to-clipboard since
// copying the QML for debugging or pasting in a question is the #1 reason
// to look at it.

function GeneratedQmlModal({
  open,
  qml,
  onClose,
}: {
  open: boolean;
  qml: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(qml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be blocked in sandboxed contexts; silent no-op.
    }
  };

  const lineCount = qml.split("\n").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[820px] flex-col overflow-hidden rounded-card-lg border border-border-subtle bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Generated QML"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-[18px] font-medium leading-[1.15] tracking-tight text-ink">
                Generated QML
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">{lineCount} lines</span>
            </div>
            <p className="mt-1 text-[12px] leading-snug text-ink-muted">
              Read-only preview of the QML emitted from this project — same source the renderer iframe runs.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-pill border border-border-soft bg-canvas px-3 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mt-1 -mr-1 rounded-pill px-2 py-1 text-[14px] leading-none text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
            >×</button>
          </div>
        </header>

        <div className="flex-1 overflow-hidden p-4">
          {/* The generated QML embeds page-id-derived nav keys; ids come
              from Date.now() so server and client diverge.
              suppressHydrationWarning lets React keep the client value
              silently instead of throwing a mismatch on first paint. */}
          <pre
            suppressHydrationWarning
            className="h-full overflow-auto rounded-card bg-surface-warm p-4 font-mono text-[11px] leading-relaxed text-ink"
          >
            {qml}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ── Core module source modal ───────────────────────────────────────────────
//
// Read-only viewer for the full source bundle generateCoreModuleFiles emits
// for the user's custom backend — impl.h / impl.cpp, flake.nix, CMakeLists,
// tests, README, etc. Two-pane: file picker on the left, source viewer on
// the right. Same design language as GeneratedQmlModal; wider (920px) and
// taller because the bundle has multiple files and code lines run long.
// Files are generated lazily inside useMemo so we only pay the codegen
// cost when the modal opens with a new spec.

function CoreModuleSourceModal({
  open,
  spec,
  onClose,
}: {
  open: boolean;
  spec: CoreModuleSpec | null;
  onClose: () => void;
}) {
  const files = useMemo(
    () => (spec ? generateCoreModuleFiles(spec) : []),
    [spec],
  );
  const [activePath, setActivePath] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // Pick a sensible default file when the modal opens — prefer the impl.cpp
  // (where the user's logic actually lives), fall back to the first file.
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    if (files.length === 0) return;
    const impl = files.find((f) => f.path.endsWith("_impl.cpp"));
    setActivePath((prev) => (prev && files.some((f) => f.path === prev)) ? prev : (impl?.path ?? files[0].path));
  }, [open, files]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !spec) return null;

  const decoder = new TextDecoder();
  const active = files.find((f) => f.path === activePath) ?? files[0];
  const activeText = active ? decoder.decode(active.data) : "";
  const lineCount = activeText ? activeText.split("\n").length : 0;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked in sandboxed contexts; silent no-op.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] w-full max-w-[920px] flex-col overflow-hidden rounded-card-lg border border-border-subtle bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Module C++ source"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-[18px] font-medium leading-[1.15] tracking-tight text-ink">
                Module source
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">{spec.id}</span>
              <span className="rounded-pill bg-surface-cool px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                {files.length} file{files.length === 1 ? "" : "s"}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-snug text-ink-muted">
              Read-only preview of every file the codegen emits for this backend — same bundle the export and GitHub-build paths ship.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopy}
              disabled={!active}
              className="rounded-pill border border-border-soft bg-canvas px-3 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink disabled:opacity-40"
              title={active ? `Copy ${active.path} to clipboard` : "No file selected"}
            >
              {copied ? "Copied ✓" : "Copy file"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mt-1 -mr-1 rounded-pill px-2 py-1 text-[14px] leading-none text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
            >×</button>
          </div>
        </header>

        <div className="flex flex-1 min-h-0">
          {/* File picker — sidebar style. Mono path so it reads as a tree;
              active row gets the warm surface treatment so the selection
              is visible at a glance. */}
          <nav
            aria-label="Source files"
            className="w-56 shrink-0 overflow-y-auto border-r border-border-subtle bg-canvas py-2"
          >
            <ul className="flex flex-col gap-0.5 px-2">
              {files.map((f) => {
                const isActive = f.path === activePath;
                const sizeKb = (f.data.byteLength / 1024).toFixed(1);
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => setActivePath(f.path)}
                      className={`block w-full rounded-control px-2 py-1.5 text-left transition-colors ${
                        isActive
                          ? "bg-surface-warm text-ink"
                          : "text-ink-muted hover:bg-surface-warm hover:text-ink"
                      }`}
                    >
                      <div className="font-mono text-[11px] leading-tight break-all">
                        {f.path}
                      </div>
                      <div className="mt-0.5 text-[10px] text-ink-muted">
                        {sizeKb} KB
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Source viewer — flex-1 fills the remaining space. */}
          <div className="flex-1 min-w-0 overflow-hidden p-4">
            <pre
              suppressHydrationWarning
              className="h-full overflow-auto rounded-card bg-surface-warm p-4 font-mono text-[11px] leading-relaxed text-ink"
            >
              {activeText}
            </pre>
            {active && (
              <p className="mt-2 text-right font-mono text-[10px] text-ink-muted">
                {lineCount} lines
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
