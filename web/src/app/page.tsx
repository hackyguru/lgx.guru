"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { exportLgx, placeholderIcon } from "./lgxExport";
import { readLgx } from "./lgxImport";
import { TEMPLATES, Template } from "./templates";
import { generateCoreModuleFiles } from "./codegen/coreModule";
import { packTarGz } from "./codegen/sourceBundle";

// Renderer iframe URL — served by renderer/serve.py on port 8765.
// Run `python3 renderer/serve.py 8765` from the lgx-builder root.
const RENDERER_URL = "http://127.0.0.1:8765/index.html";

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

const SAVE_KEY = "lgx.guru/v1/save";

// v2 = multi-page format. v1 = legacy single-root; loadFromStorage migrates
// it to v2 on read by wrapping the root in a single "Home" page.
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

const loadFromStorage = (): SaveState | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return migrateSave(JSON.parse(raw));
  } catch {
    return null;
  }
};

const saveToStorage = (s: SaveState) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    // QuotaExceeded etc. — surface to console but don't break the editor.
    console.warn("lgx.guru: failed to persist to localStorage");
  }
};

// ── Page ────────────────────────────────────────────────────────────────────

export default function Page() {
  // First render must produce identical HTML on the server and the client
  // for hydration to succeed. We initialise from defaults and apply any
  // localStorage-restored snapshot in a post-mount effect below.
  const [hist, dispatch] = useReducer(reducer, undefined, () => ({
    app: newApp(),
    past: [],
    future: [],
  }));
  const app = hist.app;
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
  const canvasRef = useRef<HTMLDivElement>(null);
  const designFileInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  // Track the latest root + app in refs so async observers can read them
  // without re-binding their callbacks on every state change.
  const rootRef = useRef(root);
  const appRef = useRef(app);
  useEffect(() => { rootRef.current = root; }, [root]);
  useEffect(() => { appRef.current = app; }, [app]);

  // Auto-save the editor state to localStorage. Debounced so a flurry of
  // changes (drag, keystrokes) only writes once the dust settles.
  // Skipped on the very first render — restore already populated state.
  const firstSaveSkip = useRef(true);

  // Post-mount: hydrate from localStorage. Runs only on the client, so
  // first paint matches SSR (defaults), then we swap in the saved state.
  // The autosave effect below sees this dispatch as the "first change"
  // and skips its own write so we don't immediately rewrite what we read.
  useEffect(() => {
    const saved = loadFromStorage();
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
      const cur = rootRef.current;
      if (cur.width === w && cur.height === h) return;
      // Update every page's root size so switching pages doesn't desync.
      dispatch({
        type: "set",
        app: {
          ...appRef.current,
          pages: appRef.current.pages.map((p) => ({
            ...p, root: { ...p.root, width: w, height: h },
          })),
        },
      });
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

  useEffect(() => {
    const id = setTimeout(() => {
      const msg = { type: "loadQml", source: qmlPreview };
      canvasIframeRef.current?.contentWindow?.postMessage(msg, "*");
    }, 100);
    return () => clearTimeout(id);
  }, [qmlPreview]);

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

  // Debounced autosave — fires once 400ms after the latest change.
  useEffect(() => {
    if (firstSaveSkip.current) { firstSaveSkip.current = false; return; }
    const handle = setTimeout(() => {
      saveToStorage(buildSaveState());
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, moduleMeta, iconPng, iconFilename, collapsedIds]);

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

  const handleSaveDesign = () => {
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
  const addVariable = (preferName?: string): VariableId => {
    const used = new Set(app.variables.map((v) => v.name));
    let name = preferName?.trim() || "var";
    if (used.has(name)) {
      let n = 1;
      while (used.has(`${name}${n}`)) n++;
      name = `${name}${n}`;
    }
    const v = newVariable(name);
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

  const addTrigger = (kind: TriggerKind) => {
    const t = newTrigger(kind);
    let extraVars: Variable[] = [];
    if (kind === "moduleEvent") {
      // Default to the first enabled module + its first event so the
      // dropdowns aren't blank.
      const mod = app.modules.map(findModuleSpec).find((m) => m && (m.events?.length ?? 0) > 0);
      if (mod) {
        t.moduleId = mod.id;
        t.eventName = mod.events?.[0]?.name;
      }
    } else if (kind === "onMessageReceived") {
      // Sensible default topic so the editor renders something readable;
      // the user is expected to overwrite this with their app's topic.
      t.topic = "/myapp/1/messages/json";
      // Pre-populate a working setup so "+ message" results in something
      // that already works instead of a hollow trigger that the user then
      // has to wire up. Auto-create a `lastMessage` variable + a default
      // action that captures the incoming payload into it. The user can
      // bind a Text widget to var_lastMessage and immediately see receives;
      // they're free to delete / rename / customize from there.
      const v: Variable = { id: newId(), name: "lastMessage", type: "string", initial: "(none yet)" };
      extraVars = [v];
      t.actions = [
        { kind: "setVariable", varId: v.id, value: "payload", mode: "expression" } as ButtonAction,
      ];
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

  const handleNew = () => {
    if (!window.confirm("Clear the canvas and start over? This wipes the current design.")) return;
    if (typeof window !== "undefined") window.localStorage.removeItem(SAVE_KEY);
    dispatch({ type: "set", app: newApp() });
    setModuleMeta({
      name: "my_widget",
      version: "0.1.0",
      description: "A widget built with lgx.guru",
      category: "example",
      author: "",
    });
    setIconPng(placeholderIcon());
    setIconFilename("icon.png");
    setCollapsedIds(new Set());
    setSelectedIds(new Set());
  };

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

  const handleCanvasDragOver = (e: React.DragEvent) => {
    if (draggingKind || dragHasFiles(e)) e.preventDefault();
  };

  const handleCanvasDrop = (e: React.DragEvent, targetFrameId: NodeId) => {
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
      // Ignore when typing into form inputs.
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;

      const meta = e.metaKey || e.ctrlKey;
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
  }, [selectedIds, root, clipboard]);

  // ── Export ────────────────────────────────────────────────────────────────

  // True when the user has at least drafted a core module (id + ≥1 method).
  const hasCoreModule = !!app.coreModule && app.coreModule.id.trim().length > 0;

  // ── Export: UI plugin (.lgx) ─────────────────────────────────────────────
  const handleExportUi = async () => {
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

    // UI dependencies — primitives the user picked + the user's core
    // (if any) + the shared delivery_relay (auto-included when any send/
    // receive action exists). Without declaring delivery_relay here,
    // Basecamp would silently skip the UI install on dep-resolution.
    const uiDeps = [
      ...app.modules,
      ...(hasCoreModule ? [app.coreModule!.id] : []),
      ...(usesDelivery(app) ? ["delivery_relay"] : []),
    ];

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
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Export: custom core source bundle ────────────────────────────────────
  // Source archive of the user's *own* backend module — separate from the
  // shared delivery_relay. This is for users who want custom C++ logic
  // beyond pub/sub. The archive needs to be `nix build`-ed before install.
  const handleExportCore = () => {
    if (!app.coreModule) return;
    const files = generateCoreModuleFiles(app.coreModule);
    const id = app.coreModule.id || "my_module";
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
  const [exportUi, setExportUi] = useState(true);
  const [exportCore, setExportCore] = useState(false);
  const [exportRelay, setExportRelay] = useState(false);
  const deliveryNeedsRelay = usesDelivery(app);
  // Default checkboxes when opening: relay on if delivery is used; custom
  // core on if the user has authored one.
  useEffect(() => {
    if (exportOpen) {
      setExportRelay(deliveryNeedsRelay);
      setExportCore(hasCoreModule);
    }
  }, [exportOpen, hasCoreModule, deliveryNeedsRelay]);
  const runExport = async () => {
    if (exportUi) await handleExportUi();
    if (exportRelay || deliveryNeedsRelay) await handleExportRelay();
    if (hasCoreModule && exportCore) handleExportCore();
    setExportOpen(false);
  };

  // The Inspector + ResizeOverlay are single-selection only. `primaryId` is
  // the lone selected id; null when zero or many are selected.
  const primaryId: NodeId | null = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const primaryNode = primaryId ? findNode(root, primaryId).node : null;
  const primaryAbs = primaryId ? absoluteRect(root, primaryId) : null;
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  return (
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
      <header className="flex h-12 items-center justify-between border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4">
        <h1 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/lgx-logo.svg"
            alt="lgx.guru"
            width={28}
            height={28}
            // The logo's main strokes are near-black so they vanish on dark
            // backgrounds; invert in dark mode for legibility.
            className="h-7 w-7 dark:invert"
          />
          <span className="sr-only">lgx.guru</span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
            onClick={handleNew}
            title="Clear and start a new design"
          >New</button>
          <div className="relative">
            <button
              className={`rounded border px-2 py-1 text-xs ${
                templatesOpen
                  ? "border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                  : "border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
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
                  className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="border-b border-zinc-200 dark:border-zinc-700 px-3 py-2 text-[10px] font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
                    Pick a template
                  </div>
                  <div className="max-h-80 overflow-y-auto py-1">
                    {TEMPLATES.map((t) => (
                      <button
                        key={t.id}
                        className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-800"
                        onClick={() => applyTemplate(t)}
                      >
                        <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-200">{t.name}</div>
                        <div className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">{t.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
            onClick={() => designFileInputRef.current?.click()}
            title="Open a .lgx-design.json or a .lgx exported from this editor"
          >Open</button>
          <button
            className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
            onClick={handleSaveDesign}
            title="Download a .lgx-design.json snapshot"
          >Save</button>
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
          <span className="mx-1 h-5 w-px bg-zinc-200" />
          <button
            className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200 disabled:opacity-30"
            disabled={!canUndo}
            onClick={() => dispatch({ type: "undo" })}
            title="Undo (Cmd+Z)"
          >Undo</button>
          <button
            className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200 disabled:opacity-30"
            disabled={!canRedo}
            onClick={() => dispatch({ type: "redo" })}
            title="Redo (Cmd+Shift+Z)"
          >Redo</button>
          <button
            className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={cycleTheme}
            title={`Theme: ${themePref} (click to cycle light → dark → system)`}
            aria-label="Cycle theme"
          >
            {themePref === "light" ? "☀" : themePref === "dark" ? "☾" : "◐"}
          </button>
          <button
            className="ml-2 rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:hover:bg-zinc-200 dark:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-300 dark:hover:bg-zinc-700"
            onClick={() => setExportOpen(true)}
          >Export…</button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left column. Two scroll regions, anchored to the column:
            - top: panels (Pages, Variables, Triggers, Networking, Build a
              module, Components). Scrolls so any combination of panels fits.
            - bottom: Layers, capped to 40% of the column height with its own
              scroll so deeply-nested designs stay manageable. */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 min-h-0">
          <div className="flex-1 overflow-y-auto min-h-0">
            <PagesPanel
              pages={app.pages}
              currentPageId={app.currentPageId}
              onSwitch={switchPage}
              onAdd={addPage}
              onRename={renamePage}
              onDelete={deletePage}
            />
            <VariablesPanel
              variables={app.variables}
              onAdd={addVariable}
              onUpdate={updateVariable}
              onDelete={deleteVariable}
            />
            <TriggersPanel
              triggers={app.triggers}
              pages={app.pages}
              variables={app.variables}
              enabledModuleIds={app.modules}
              coreModule={app.coreModule}
              onAdd={addTrigger}
              onUpdate={updateTrigger}
              onDelete={deleteTrigger}
              onAddAction={addTriggerAction}
              onUpdateAction={updateTriggerAction}
              onDeleteAction={deleteTriggerAction}
              onAddVariable={addVariable}
            />
            <ModulesPanel app={app} />
            <CoreModulePanel
              spec={app.coreModule}
              onEnable={enableCoreModule}
              onDisable={disableCoreModule}
              onUpdate={updateCoreModule}
              onAddMethod={addCoreMethod}
              onUpdateMethod={updateCoreMethod}
              onDeleteMethod={deleteCoreMethod}
              onToggleDep={toggleCoreDep}
              onAddStateField={addCoreStateField}
              onUpdateStateField={updateCoreStateField}
              onDeleteStateField={deleteCoreStateField}
            />
            <SidebarSection
              title="Components"
              defaultOpen
              headerRight={
                <button
                  type="button"
                  className="rounded border border-zinc-300 dark:border-zinc-600 px-1.5 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
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
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      {cat.name}
                    </div>
                    {/* Two-column grid — packs ~2x denser than the previous
                        single-column stack, eliminating most palette overflow. */}
                    <div className="grid grid-cols-2 gap-1">
                      {cat.items.map((p) => (
                        <button
                          key={p.kind}
                          draggable
                          onDragStart={() => setDraggingKind(p.kind)}
                          onDragEnd={() => setDraggingKind(null)}
                          onClick={p.kind === "Image" ? () => imageFileInputRef.current?.click() : undefined}
                          className="flex cursor-grab items-center gap-1.5 truncate rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1.5 py-1 text-left text-[11px] hover:border-zinc-400 dark:hover:border-zinc-500 active:cursor-grabbing"
                          title={p.kind === "Image" ? "Click to upload, or drag for a placeholder" : p.label}
                        >
                          <NodeIcon kind={p.kind} className="text-zinc-500 dark:text-zinc-400" />
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
              <p className="mt-2 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
                Drag onto the canvas, or drop image files from your OS.
              </p>
            </SidebarSection>
          </div>

          {/* Layers — anchored at the bottom, capped to 40vh so it shares
              column height fairly with the panels above. Internal scroll for
              deep trees. */}
          <div className="shrink-0 flex flex-col border-t border-zinc-200 dark:border-zinc-700 max-h-[40vh] min-h-[120px]">
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5">
              <span className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">Layers</span>
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">drag to reorder</span>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
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
        </aside>

        {/* Single-pane canvas. The Qt-WASM iframe IS the canvas — it
            renders the QML the same way Basecamp will. The React overlay
            on top captures pointer events for selection / drag / resize.
            A Run-mode toggle lifts that overlay's pointer-events-auto so
            clicks fall through to Qt and the user can interact with their
            widget (test buttons, type into fields, send messages). */}
        <main className="flex flex-1 flex-col min-w-0">
          <section className="flex flex-1 flex-col bg-zinc-100 dark:bg-zinc-800 min-h-0">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
                  {runMode ? "Run" : "Canvas"}
                </span>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  Qt-WASM @ {RENDERER_URL}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${
                    runMode
                      ? "border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                      : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  }`}
                  onClick={() => setRunMode((v) => !v)}
                  title="Toggle Edit ↔ Run. Edit lets you select & drag widgets; Run forwards clicks to Qt so you can test the live widget."
                >
                  {runMode ? "▶ Run" : "✎ Edit"}
                </button>
                <button
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${
                    gridSize > 0
                      ? "border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                      : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  }`}
                  onClick={() => setGridSize((g) => (g === 0 ? 8 : g === 8 ? 16 : g === 16 ? 24 : 0))}
                  title="Toggle snap-to-grid (cycles off / 8 / 16 / 24 px)"
                  disabled={runMode}
                >
                  grid {gridSize === 0 ? "off" : `${gridSize}px`}
                </button>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
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
              <iframe
                ref={canvasIframeRef}
                src={RENDERER_URL}
                className="absolute inset-0 h-full w-full bg-zinc-50 dark:bg-zinc-800"
                style={{ pointerEvents: runMode ? "auto" : "none" }}
                title="canvas-renderer"
              />
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
        </main>

        {/* Inspector */}
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3">
          <ModulePanel
            meta={moduleMeta}
            onChange={setModuleMeta}
            iconPreviewUrl={iconPreviewUrl}
            iconFilename={iconFilename}
            iconError={iconError}
            onIconUpload={handleIconUpload}
            sanitizedName={sanitizeName(moduleMeta.name) || "my_widget"}
          />

          <div className="my-4 border-t border-zinc-200 dark:border-zinc-700" />

          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
              Inspector
            </span>
            {(selectedIds.size > 0 && (selectedIds.size > 1 || (primaryNode && primaryId !== root.id))) && (
              <div className="flex items-center gap-2">
                <button
                  className="text-[11px] text-zinc-600 dark:text-zinc-400 dark:text-zinc-500 hover:underline"
                  onClick={duplicateSelected}
                >duplicate</button>
                <button
                  className="text-[11px] text-red-600 dark:text-red-400 hover:underline"
                  onClick={deleteSelected}
                >delete</button>
              </div>
            )}
          </div>

          {selectedIds.size > 0 && (selectedIds.size > 1 || (primaryNode && primaryId !== root.id)) && (
            <div className="mb-3 flex items-center gap-1">
              <IconBtn title="Send to back (Cmd+Shift+[)"  onClick={() => zOrderSelected("back")}     ><AlignIcon kind="left" /></IconBtn>
              <IconBtn title="Send backward (Cmd+[)"        onClick={() => zOrderSelected("backward")} ><AlignIcon kind="centerX" /></IconBtn>
              <IconBtn title="Bring forward (Cmd+])"        onClick={() => zOrderSelected("forward")}  ><AlignIcon kind="right" /></IconBtn>
              <IconBtn title="Bring to front (Cmd+Shift+])" onClick={() => zOrderSelected("front")}    ><AlignIcon kind="distH" /></IconBtn>
              <span className="ml-1 text-[10px] text-zinc-400 dark:text-zinc-500">z-order</span>
            </div>
          )}
          {selectedIds.size === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
              Click a node in the canvas to edit. Shift-click to add to selection.
              Click empty space to deselect.
            </p>
          ) : selectedIds.size > 1 ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-zinc-600 dark:text-zinc-400 dark:text-zinc-500">
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
            />
          ) : null}
          <details className="mt-6">
            <summary className="cursor-pointer text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
              Generated QML
            </summary>
            {/*
              The generated QML embeds page-id-derived nav keys; ids are
              made with Date.now() so server and client diverge. Marking the
              <pre> as hydration-safe lets React swap to the client value
              silently instead of throwing a mismatch.
            */}
            <pre
              suppressHydrationWarning
              className="mt-2 max-h-64 overflow-auto rounded bg-zinc-50 dark:bg-zinc-800 p-2 text-[10px] leading-tight text-zinc-700 dark:text-zinc-300"
            >
              {qmlExport}
            </pre>
          </details>
        </aside>
      </div>

      {exportOpen && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/30"
          onClick={() => setExportOpen(false)}
        >
          <div
            className="w-[440px] rounded-lg bg-white dark:bg-zinc-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3">
              <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Export project</div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
                Pick what to download. Each artifact ships as a separate <span className="font-mono">.lgx</span>; install whichever ones aren&apos;t already in your Basecamp.
              </div>
              {deliveryNeedsRelay && (
                <div className="mt-2 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-2 text-[11px] leading-tight text-amber-900 dark:text-amber-200">
                  <span className="font-semibold">Delivery is enabled.</span> Install both the UI and the bundled <span className="font-mono">delivery_relay.lgx</span> on every Basecamp instance. The relay is the same file for every project — install once, reuse forever.
                </div>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <label className="flex items-start gap-2 rounded border border-zinc-200 dark:border-zinc-700 p-2 cursor-pointer hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-800">
                <input
                  type="checkbox"
                  checked={exportUi}
                  onChange={(e) => setExportUi(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <div>
                  <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    UI plugin (<span className="font-mono">.lgx</span>, portable)
                  </div>
                  <div className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
                    The QML widget — the thing the user sees. Always available; UI-only widgets are complete with just this. Built and packaged in the canonical portable shape, ready to drop into Basecamp.
                  </div>
                </div>
              </label>

              <label
                className={`flex items-start gap-2 rounded border p-2 ${
                  deliveryNeedsRelay
                    ? "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 cursor-pointer hover:bg-amber-50 dark:bg-amber-950"
                    : "border-zinc-200 dark:border-zinc-700 cursor-pointer hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-800"
                }`}
              >
                <input
                  type="checkbox"
                  checked={exportRelay || deliveryNeedsRelay}
                  disabled={deliveryNeedsRelay}
                  onChange={(e) => setExportRelay(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <div>
                  <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    <span className="font-mono">delivery_relay.lgx</span> (pre-built, ready to install){" "}
                    {deliveryNeedsRelay && (
                      <span className="ml-1 rounded bg-amber-100 dark:bg-amber-900 px-1 py-0.5 text-[9px] font-mono text-amber-900 dark:text-amber-200">required</span>
                    )}
                  </div>
                  <div className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
                    Bundled C++ relay that owns <span className="font-mono">delivery_module</span>&apos;s lifecycle and exposes <span className="font-mono">sendMessage</span> / <span className="font-mono">subscribeToTopic</span> / <span className="font-mono">takeRecentMessages</span> to widgets. Same file for every project — install once per Basecamp; reuse across all your delivery widgets.
                  </div>
                </div>
              </label>

              <label
                className={`flex items-start gap-2 rounded border p-2 ${
                  hasCoreModule
                    ? "border-zinc-200 dark:border-zinc-700 cursor-pointer hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-800"
                    : "border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 opacity-60"
                }`}
              >
                <input
                  type="checkbox"
                  checked={exportCore && hasCoreModule}
                  disabled={!hasCoreModule}
                  onChange={(e) => setExportCore(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <div>
                  <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    Custom backend source (<span className="font-mono">.lgx</span>, buildable)
                  </div>
                  <div className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
                    {hasCoreModule ? (
                      <>
                        Source archive for your authored backend <span className="font-mono">{app.coreModule!.id}</span>. <span className="font-mono">tar -xzf</span>, then <span className="font-mono">nix build &apos;.#lgx-portable&apos;</span> produces the installable <span className="font-mono">.lgx</span> in <span className="font-mono">result/</span>. Only needed if you&apos;ve added custom C++ logic beyond pub/sub.
                      </>
                    ) : (
                      <>
                        Only available when you&apos;ve added a module under <span className="font-semibold">Build a module</span> in the sidebar. Most apps don&apos;t need this.
                      </>
                    )}
                  </div>
                </div>
              </label>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setExportOpen(false)}
                className="rounded border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-800"
              >Cancel</button>
              <button
                onClick={runExport}
                disabled={!exportUi && !(exportCore && hasCoreModule) && !(exportRelay || deliveryNeedsRelay)}
                className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:hover:bg-zinc-200 disabled:opacity-40"
              >Export</button>
            </div>
          </div>
        </div>
      )}
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
  const gridStyle: React.CSSProperties = gridSize > 0
    ? {
        backgroundImage:
          "linear-gradient(rgba(0,0,0,0.06) 1px, transparent 1px)," +
          "linear-gradient(90deg, rgba(0,0,0,0.06) 1px, transparent 1px)",
        backgroundSize: `${gridSize}px ${gridSize}px`,
      }
    : {};
  return (
    // Transparent background — the Qt-WASM canvas iframe BEHIND this layer
    // draws the actual widget pixels. A solid bg here would just hide them.
    // The grid overlay (when enabled) is composited on top of the iframe.
    <div
      className="relative inline-block"
      style={{ width: root.width, height: root.height, ...gridStyle }}
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
      className="flex h-7 w-7 items-center justify-center rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:border-zinc-400 dark:border-zinc-500 hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-white dark:bg-zinc-900"
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
      <div className="mb-1 text-[10px] font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">Align</div>
      <div className="flex gap-1">
        <IconBtn title="Align left"     disabled={!canAlign} onClick={() => onAlign("left")}    ><AlignIcon kind="left" /></IconBtn>
        <IconBtn title="Align center X" disabled={!canAlign} onClick={() => onAlign("centerX")} ><AlignIcon kind="centerX" /></IconBtn>
        <IconBtn title="Align right"    disabled={!canAlign} onClick={() => onAlign("right")}   ><AlignIcon kind="right" /></IconBtn>
        <span className="mx-0.5 w-px self-stretch bg-zinc-200" />
        <IconBtn title="Align top"      disabled={!canAlign} onClick={() => onAlign("top")}     ><AlignIcon kind="top" /></IconBtn>
        <IconBtn title="Align center Y" disabled={!canAlign} onClick={() => onAlign("centerY")} ><AlignIcon kind="centerY" /></IconBtn>
        <IconBtn title="Align bottom"   disabled={!canAlign} onClick={() => onAlign("bottom")}  ><AlignIcon kind="bottom" /></IconBtn>
      </div>
      <div className="mt-2 mb-1 text-[10px] font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">Distribute</div>
      <div className="flex gap-1">
        <IconBtn title="Distribute horizontally" disabled={!canDistribute} onClick={() => onDistribute("horizontal")}><AlignIcon kind="distH" /></IconBtn>
        <IconBtn title="Distribute vertically"   disabled={!canDistribute} onClick={() => onDistribute("vertical")}  ><AlignIcon kind="distV" /></IconBtn>
      </div>
      {!canAlign && (
        <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
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
    ? "outline outline-2 outline-offset-[-2px] outline-blue-500"
    : "hover:outline hover:outline-1 hover:outline-offset-[-1px] hover:outline-blue-300";

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
          className="pointer-events-auto absolute rounded-sm border border-blue-500 bg-white dark:bg-zinc-900"
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

const I_LABEL = "block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 dark:text-zinc-500 mb-0.5";
const I_INPUT =
  "w-full rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none";
const I_SUMMARY =
  "cursor-pointer text-[11px] font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 select-none mb-2";

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
    <details open={defaultOpen} className="shrink-0 border-b border-zinc-200 dark:border-zinc-700 [&[open]>summary>span.chev]:rotate-90">
      <summary
        // Reset the native disclosure triangle (`list-none` / Webkit) so we
        // own the visual; the rotating ▸ glyph below is the open indicator.
        className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 list-none [&::-webkit-details-marker]:hidden"
      >
        <span className="chev inline-block text-[10px] text-zinc-400 dark:text-zinc-500 transition-transform">▸</span>
        <span className="flex-1 text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">{title}</span>
        {badge !== undefined && badge !== "" && (
          <span className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 text-[9px] font-medium text-zinc-500 dark:text-zinc-400 leading-none">{badge}</span>
        )}
        {/* Right-side button area (e.g. "+") — stop propagation so clicking
            it doesn't toggle the section. */}
        {headerRight && (
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {headerRight}
          </span>
        )}
      </summary>
      <div className="px-2.5 pb-2.5">
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
    <label className="flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-400 dark:text-zinc-500">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
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
          className="h-7 w-7 shrink-0 cursor-pointer rounded border border-zinc-300 dark:border-zinc-600 p-0"
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
              ? "border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
              : "border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
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
        <p className="mt-1 text-[10px] text-amber-600">
          Bound variable was deleted — clear or pick a new one.
        </p>
      )}
      {compatible.length === 0 && !value && (
        <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
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
        }]
      : []),
  ];
  const kind = action?.kind ?? "none";
  type ActionKind = "none" | "navigate" | "setVariable" | "openUrl" | "callModule" | "sendMessage" | "appendToList";
  const setKind = (next: ActionKind) => {
    if (next === "none") onChange({ kind: "none" });
    else if (next === "navigate") onChange({ kind: "navigate", pageId: pages[0]?.id ?? "" });
    else if (next === "setVariable") onChange({ kind: "setVariable", varId: variables[0]?.id ?? "", value: "" });
    else if (next === "appendToList") onChange({ kind: "appendToList", varId: variables[0]?.id ?? "", value: "payload", mode: "expression" });
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
    else if (next === "sendMessage") {
      onChange({ kind: "sendMessage", topic: "/myapp/1/messages/json", payload: "", payloadMode: "literal" });
    }
    else onChange({ kind: "openUrl", url: "" });
  };
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
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
        <option value="callModule" disabled={enabledModules.length === 0}>Call module method (advanced)</option>
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
                    className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
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
                className="text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:underline"
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
              <p className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
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
                    className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
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
              <p className="mt-0.5 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
                A string variable whose value is a JSON array (e.g. set initial to{" "}
                <span className="font-mono">[]</span>). Bind a List node to the same variable to render every item.
              </p>
            </div>
            <div className="flex items-center justify-between">
              <label className={I_LABEL}>append</label>
              <button
                onClick={() => setAppend({ mode: mode === "literal" ? "expression" : "literal" })}
                className="text-[10px] text-zinc-500 dark:text-zinc-400 hover:underline"
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
              <p className="mt-0.5 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
                Format: <span className="font-mono">/&lt;app&gt;/&lt;version&gt;/&lt;subtopic&gt;/&lt;format&gt;</span>. Anyone subscribed to the same topic receives the message.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className={I_LABEL}>message</label>
                <button
                  onClick={() => setSend({ payloadMode: mode === "literal" ? "expression" : "literal" })}
                  className="text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:underline"
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
                <p className="mt-0.5 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
                  Splice in any QML expression — usually <span className="font-mono">app.var_*</span> to send the contents of a Text Field.
                </p>
              )}
            </div>
            <p className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
              Delivery is set up automatically — no need to add the module separately.
            </p>
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
                <p className="mt-1 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">{method.description}</p>
              )}
            </div>
            {method && method.args.length > 0 && (
              <div className="flex flex-col gap-2 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 p-2">
                <div className="text-[10px] font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">Arguments</div>
                {method.args.map((p, idx) => {
                  const arg = action.args[idx] ?? { value: "", mode: "literal" as SetVariableMode };
                  const mode = arg.mode ?? "literal";
                  return (
                    <div key={p.name}>
                      <div className="flex items-center justify-between">
                        <label className={I_LABEL}>
                          <span className="font-mono">{p.name}</span>{" "}
                          <span className="text-zinc-400 dark:text-zinc-500">({p.type})</span>
                        </label>
                        <button
                          onClick={() => setArg(idx, { mode: mode === "literal" ? "expression" : "literal" })}
                          className="text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:underline"
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
                        <p className="mt-0.5 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">{p.description}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
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
}: {
  node: Node;
  isRoot: boolean;
  onChange: (patch: Partial<Node>) => void;
  pages: PageData[];
  variables: Variable[];
  enabledModuleIds: ModuleId[];
  coreModule: CoreModuleSpec | undefined;
  onAddVariable?: (preferName?: string) => string;
}) {
  // Style is nested — patch helper builds {style: {...node.style, ...patch}}
  const updateStyle = (patch: Partial<typeof node.style>) =>
    onChange({ style: { ...node.style, ...patch } } as Partial<Node>);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
        kind: <span className="font-mono">{node.kind}</span>
      </div>

      {/* Position + size */}
      <details open>
        <summary className={I_SUMMARY}>Position</summary>
        {isRoot ? (
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
            <div className="mb-1">
              size <span className="font-mono">{node.width}×{node.height}px</span>
            </div>
            <div className="text-zinc-400 dark:text-zinc-500">auto-sized to the live preview</div>
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
            <p className="mt-0.5 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
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
            <div>
              <label className={I_LABEL}>bind to variable</label>
              <select
                className={I_INPUT}
                value={node.binding ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({ binding: v ? v : undefined } as Partial<TextNode>);
                }}
              >
                <option value="">(no binding — use literal text)</option>
                {variables.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.type})
                  </option>
                ))}
              </select>
              {node.binding && !variables.find((v) => v.id === node.binding) && (
                <p className="mt-1 text-[10px] text-amber-600">
                  Bound variable was deleted — pick a new one or clear the binding.
                </p>
              )}
            </div>
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
            <p className="text-[11px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
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
            <p className="text-[11px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
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
              <p className="mt-0.5 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
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
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 select-none">
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
                <p className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
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
      <label className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400 dark:text-zinc-500">model</label>
      {value.map((v, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            value={v}
            onChange={(e) => update(i, e.target.value)}
            className="w-full rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={() => move(i, -1)}
            disabled={i === 0}
            className="rounded px-1 text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200 disabled:opacity-30"
            title="move up"
          >▲</button>
          <button
            onClick={() => move(i, 1)}
            disabled={i === value.length - 1}
            className="rounded px-1 text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200 disabled:opacity-30"
            title="move down"
          >▼</button>
          <button
            onClick={() => remove(i)}
            className="rounded px-1 text-red-500 hover:bg-red-50"
            title="delete"
          >×</button>
        </div>
      ))}
      <button
        onClick={add}
        className="self-start rounded border border-dashed border-zinc-300 dark:border-zinc-600 px-2 py-1 text-[11px] text-zinc-600 dark:text-zinc-400 dark:text-zinc-500 hover:border-zinc-500"
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
          className="h-20 w-full rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 object-contain"
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
          className="w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1.5 py-1 text-xs hover:border-zinc-400 dark:border-zinc-500"
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
  sanitizedName,
}: {
  meta: ModuleMeta;
  onChange: (m: ModuleMeta) => void;
  iconPreviewUrl: string | null;
  iconFilename: string;
  iconError: string | null;
  onIconUpload: (f: File) => void;
  sanitizedName: string;
}) {
  const labelClass = "block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 dark:text-zinc-500 mb-0.5";
  const inputClass =
    "w-full rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none";
  const fileInputRef = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<ModuleMeta>) => onChange({ ...meta, ...patch });

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
        Module
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start gap-2">
          {iconPreviewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={iconPreviewUrl}
              alt="icon"
              className="h-12 w-12 shrink-0 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 object-contain"
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
            <button
              className="w-full truncate rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1.5 py-1 text-left text-xs hover:border-zinc-400 dark:border-zinc-500"
              onClick={() => fileInputRef.current?.click()}
              title={iconFilename}
            >
              {iconFilename}
            </button>
            {iconError && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{iconError}</p>}
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
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
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
          className="flex h-5 w-5 items-center justify-center rounded border border-zinc-300 dark:border-zinc-600 text-xs leading-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
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
                active ? "bg-blue-100 dark:bg-blue-900 text-blue-900 dark:text-blue-100" : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              }`}
            >
              <span className="flex-1 truncate" title={p.name}>{p.name}</span>
              {active && (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); promptRename(p); }}
                    className="text-[10px] text-zinc-500 dark:text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-zinc-800 dark:hover:text-zinc-200"
                    title="Rename"
                  >edit</button>
                  {pages.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
                      className="text-[10px] text-red-600 dark:text-red-400 opacity-0 group-hover:opacity-100 hover:underline"
                      title="Delete"
                    >del</button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
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
  onAdd: (kind: TriggerKind) => void;
  onUpdate: (id: TriggerId, patch: Partial<Trigger>) => void;
  onDelete: (id: TriggerId) => void;
  onAddAction: (id: TriggerId) => void;
  onUpdateAction: (id: TriggerId, idx: number, action: ButtonAction) => void;
  onDeleteAction: (id: TriggerId, idx: number) => void;
  onAddVariable?: (preferName?: string) => string;
}) {
  const enabledModules = enabledModuleIds
    .map((id) => findModuleSpec(id))
    .filter((m): m is ModuleSpec => m !== undefined);
  return (
    <SidebarSection
      title="Triggers"
      defaultOpen={triggers.length > 0}
      badge={triggers.length > 0 ? triggers.length : undefined}
    >
      {/* Action buttons live below the title on their own row so they always
          fit the column width and stay aligned even when labels grow. */}
      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => onAdd("appStart")}
          className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 px-1 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Run actions when the widget loads"
        >+ load</button>
        <button
          onClick={() => onAdd("onMessageReceived")}
          className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 px-1 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Run actions when a message arrives on a content topic"
        >+ message</button>
        <button
          onClick={() => onAdd("moduleEvent")}
          disabled={enabledModules.every((m) => (m.events?.length ?? 0) === 0)}
          className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 px-1 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
          title="Advanced: run actions when a module emits a raw event"
        >+ event</button>
      </div>
      <p className="mb-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
        React to widget load, incoming messages, or raw module events.
      </p>
      <div className="flex flex-col gap-2">
        {triggers.length === 0 && (
          <p className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
            No triggers yet. Add &quot;on load&quot; for setup, or &quot;on message&quot; to react to incoming messages.
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
    <div className="rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-1.5">
      <div className="mb-1 flex items-center gap-1">
        <span className="font-mono text-[10px] uppercase text-zinc-400 dark:text-zinc-500">
          {trigger.kind === "appStart" ? "on load"
            : trigger.kind === "onMessageReceived" ? "on message"
            : "on event"}
        </span>
        <span className="flex-1" />
        <button
          onClick={onDelete}
          className="text-[10px] text-red-600 dark:text-red-400 hover:underline"
        >del</button>
      </div>
      {trigger.kind === "onMessageReceived" && (
        <div className="mb-1.5 flex flex-col gap-1">
          <label className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">topic to listen on</label>
          <input
            className="rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px]"
            value={trigger.topic ?? ""}
            placeholder="/myapp/1/messages/json"
            onChange={(e) => onChange({ topic: e.target.value })}
          />
          {/* Inline cheat-sheet for the two magic identifiers that are in
              scope inside actions on this trigger. New users won't know
              these exist without it. */}
          <div className="mt-1 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 px-1.5 py-1 text-[10px] leading-tight text-zinc-600 dark:text-zinc-400">
            <div className="font-semibold text-zinc-700 dark:text-zinc-300">In actions below, you can use:</div>
            <div><span className="font-mono text-zinc-800 dark:text-zinc-200">payload</span> &nbsp;— the incoming message text</div>
            <div><span className="font-mono text-zinc-800 dark:text-zinc-200">topic</span> &nbsp;— the content topic it came on</div>
            <div className="mt-0.5 text-[9px] text-zinc-500 dark:text-zinc-500">Use them via the &quot;use expression →&quot; toggle on Set variable / Send message.</div>
          </div>
        </div>
      )}
      {trigger.kind === "moduleEvent" && (
        <div className="mb-1.5 flex items-center gap-1">
          <select
            className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px]"
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
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">·</span>
          <select
            className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px]"
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
          <div className="mb-1.5 rounded bg-zinc-50 dark:bg-zinc-800 p-1.5 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
            {ev.description && <div className="mb-0.5">{ev.description}</div>}
            <div>
              data: <span className="font-mono">[{ev.data.map((d) => `${d.name}: ${d.type}`).join(", ")}]</span>
            </div>
            <div className="text-zinc-400 dark:text-zinc-500">
              Use <span className="font-mono">data[0]</span>, <span className="font-mono">data[1]</span>, … in expression-mode actions.
            </div>
          </div>
        );
      })()}
      <div className="flex flex-col gap-1.5">
        {trigger.actions.length === 0 && (
          <p className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">No actions. Add one below.</p>
        )}
        {trigger.actions.map((a, idx) => (
          <div key={idx} className="rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 p-1">
            <div className="mb-0.5 flex items-center justify-between">
              <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500">#{idx + 1}</span>
              <button
                onClick={() => onDeleteAction(idx)}
                className="text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:text-red-400"
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
          className="self-start rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
        >+ action</button>
      </div>
    </div>
  );
}

// ── ModulesPanel ───────────────────────────────────────────────────────────

function ModulesPanel({
  app,
}: {
  app: AppState;
}) {
  const deliveryAuto = usesDelivery(app);
  return (
    <SidebarSection
      title="Networking"
      defaultOpen={deliveryAuto}
      badge={deliveryAuto ? "in use" : "idle"}
    >
      <div
        className={`flex items-start gap-2 rounded border p-1.5 ${
          deliveryAuto ? "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950" : "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">Delivery (pub/sub)</div>
          <div className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
            Send and receive messages over the Logos network. Pick <span className="font-mono">Send message</span> on a button or add an <span className="font-mono">on message</span> trigger.
          </div>
          {deliveryAuto && (
            <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">
              Active · UI calls the bundled <span className="font-mono">delivery_relay</span> module.
              <div className="mt-0.5 text-amber-700 dark:text-amber-300">
                Export will give you both <span className="font-mono">&lt;name&gt;.lgx</span> and <span className="font-mono">delivery_relay.lgx</span>. Install both on every Basecamp (the relay is the same file across all your projects — install once).
              </div>
            </div>
          )}
        </div>
      </div>
    </SidebarSection>
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
            className="rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="Author a custom backend module for this project"
          >+ Add</button>
        }
      >
        <p className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
          Author your own backend module in C++ (optional). Pick this when you need custom server-side logic that wraps the modules above — e.g. a polling module that uses <span className="font-mono">delivery_module</span>. <span className="text-zinc-400 dark:text-zinc-500">Skip for UI-only widgets.</span>
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
          className="text-[10px] text-red-600 dark:text-red-400 hover:underline"
        >remove</button>
      }
    >
      <p className="mb-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
        Authoring a custom backend (compiled to <span className="font-mono">.lgx</span>). Export produces a buildable C++ project.
      </p>

      <div className="flex flex-col gap-2">
        <div>
          <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">id (used in callModule + dependencies)</label>
          <input
            className="w-full rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-1 text-[11px] font-mono"
            value={spec.id}
            onChange={(e) => onUpdate({ id: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-1">
          <div>
            <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">version</label>
            <input
              className="w-full rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-1 text-[11px]"
              value={spec.version}
              onChange={(e) => onUpdate({ version: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">category</label>
            <input
              className="w-full rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-1 text-[11px]"
              value={spec.category}
              onChange={(e) => onUpdate({ category: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">description</label>
          <input
            className="w-full rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-1 text-[11px]"
            value={spec.description}
            onChange={(e) => onUpdate({ description: e.target.value })}
          />
        </div>

        {/* Dependencies — pick from the catalog of primitives. */}
        <div>
          <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">depends on (Logos primitives)</label>
          <div className="flex flex-col gap-0.5">
            {MODULE_CATALOG.map((m) => (
              <label key={m.id} className="flex items-center gap-1 text-[11px] text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={spec.dependencies.includes(m.id)}
                  onChange={() => onToggleDep(m.id)}
                  className="h-3.5 w-3.5"
                />
                <span className="font-mono">{m.id}</span>
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">— {m.name}</span>
              </label>
            ))}
          </div>
        </div>

        {/* State fields */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">state fields (private members)</label>
            <button
              onClick={onAddStateField}
              className="rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
            >+ field</button>
          </div>
          {spec.state.length === 0 && (
            <p className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
              Add typed C++ members like <span className="font-mono">QHash&lt;QString, MyData&gt;</span> — they&apos;re declared as <span className="font-mono">m_&lt;name&gt;</span> in the generated header.
            </p>
          )}
          <div className="flex flex-col gap-1">
            {spec.state.map((s, idx) => (
              <div key={idx} className="flex items-center gap-1">
                <input
                  className="w-20 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 font-mono text-[10px]"
                  value={s.name}
                  onChange={(e) => onUpdateStateField(idx, { name: e.target.value })}
                  placeholder="name"
                />
                <input
                  className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 font-mono text-[10px]"
                  value={s.cppType}
                  onChange={(e) => onUpdateStateField(idx, { cppType: e.target.value })}
                  placeholder="QString"
                />
                <input
                  className="w-16 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 font-mono text-[10px]"
                  value={s.initial ?? ""}
                  onChange={(e) => onUpdateStateField(idx, { initial: e.target.value })}
                  placeholder="init"
                  title="Optional initializer (e.g. 0, &quot;&quot;)"
                />
                <button
                  onClick={() => onDeleteStateField(idx)}
                  className="text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:text-red-400"
                >×</button>
              </div>
            ))}
          </div>
        </div>

        {/* Methods table */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">methods</label>
            <button
              onClick={onAddMethod}
              className="rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
            >+ method</button>
          </div>
          {spec.methods.length === 0 && (
            <p className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
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
    <div className="rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 p-1.5">
      <div className="mb-1 flex items-center gap-1">
        <input
          className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px]"
          value={method.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="methodName"
        />
        <select
          className="rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px]"
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
          className="text-[10px] text-red-600 dark:text-red-400 hover:underline"
        >del</button>
      </div>
      {method.args.length > 0 && (
        <div className="mb-1 flex flex-col gap-0.5">
          {method.args.map((a, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 font-mono text-[10px]"
                value={a.name}
                onChange={(e) => updateArg(i, { name: e.target.value })}
                placeholder="argName"
              />
              <select
                className="rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px]"
                value={a.type}
                onChange={(e) => updateArg(i, { type: e.target.value as ParamType })}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
              </select>
              <button
                onClick={() => deleteArg(i)}
                className="text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:text-red-600 dark:text-red-400"
              >×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          onClick={addArg}
          className="rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:hover:bg-zinc-200"
        >+ arg</button>
        <input
          className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1.5 py-0.5 text-[10px]"
          value={method.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="(optional description)"
        />
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer select-none text-[10px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:text-zinc-800 dark:text-zinc-200">
          C++ body {method.body && method.body.trim() ? "✓" : "(TODO stub)"}
        </summary>
        <textarea
          className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1.5 py-1 font-mono text-[10px] leading-tight"
          rows={6}
          value={method.body ?? ""}
          onChange={(e) => onChange({ body: e.target.value })}
          placeholder={
            "// Spliced verbatim into the generated .cpp.\n" +
            "// Reference state via m_<field>;\n" +
            "// call deps via m_<dep>Client->invokeRemoteMethod(\"<dep>\", \"method\", arg1, arg2);"
          }
          spellCheck={false}
        />
      </details>
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
          onClick={onAdd}
          className="flex h-5 w-5 items-center justify-center rounded border border-zinc-300 dark:border-zinc-600 text-xs leading-none text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Add a new variable"
        >+</button>
      }
    >
      {variables.length === 0 ? (
        <p className="text-[10px] leading-tight text-zinc-400 dark:text-zinc-500">
          App-level state. Reference from Text bindings or Button → set-variable
          actions. Auto-emits as Qt properties.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {variables.map((v) => (
            <div key={v.id} className="rounded border border-zinc-200 dark:border-zinc-700 p-1.5">
              <div className="mb-1 flex items-center gap-1">
                <input
                  className="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] font-mono hover:border-zinc-300 dark:border-zinc-600 focus:border-blue-500 focus:bg-white dark:bg-zinc-900 focus:outline-none"
                  value={v.name}
                  onChange={(e) => onUpdate(v.id, { name: e.target.value })}
                />
                <button
                  onClick={() => onDelete(v.id)}
                  className="text-[10px] text-red-600 dark:text-red-400 hover:underline"
                  title="Delete variable"
                >del</button>
              </div>
              <div className="flex items-center gap-1">
                <select
                  className="rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px]"
                  value={v.type}
                  onChange={(e) => onUpdate(v.id, { type: e.target.value as VariableType })}
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
                {v.type === "boolean" ? (
                  <select
                    className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-1 py-0.5 text-[10px]"
                    value={v.initial === "true" ? "true" : "false"}
                    onChange={(e) => onUpdate(v.id, { initial: e.target.value })}
                  >
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                ) : (
                  <input
                    type={v.type === "number" ? "number" : "text"}
                    className="flex-1 rounded border border-zinc-300 dark:border-zinc-600 px-1 py-0.5 text-[10px]"
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
          isSelected ? "bg-blue-100 dark:bg-blue-900 text-blue-900 dark:text-blue-100" : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-800",
          node.hidden ? "opacity-50" : "",
        ].join(" ")}
      >
        {dropMark === "before" && (
          <div className="pointer-events-none absolute inset-x-0 -top-px h-0.5 bg-blue-500" />
        )}
        {dropMark === "after" && (
          <div className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 bg-blue-500" />
        )}
        {dropMark === "inside" && (
          <div className="pointer-events-none absolute inset-0 ring-1 ring-blue-500" />
        )}

        {/* Chevron — only for Frames with children */}
        {isFrame && node.children.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapsed(node.id); }}
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[8px] text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:text-zinc-800 dark:text-zinc-200"
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        <NodeIcon kind={node.kind} className="text-zinc-500 dark:text-zinc-400" />
        <span className="flex-1 truncate">{kindLabel(node)}</span>

        {!isRoot && (
          <>
            <button
              title={node.locked ? "Unlock" : "Lock"}
              onClick={(e) => { e.stopPropagation(); onToggleLocked(node.id); }}
              className={`shrink-0 ${node.locked ? "text-amber-600" : "text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:text-zinc-300"}`}
            >
              <IconLock locked={node.locked} />
            </button>
            <button
              title={node.hidden ? "Show" : "Hide"}
              onClick={(e) => { e.stopPropagation(); onToggleHidden(node.id); }}
              className={`shrink-0 ${node.hidden ? "text-zinc-400 dark:text-zinc-500" : "text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:text-zinc-300"}`}
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
