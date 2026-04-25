"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  FrameNode, ImageFit, ImageNode, LeafNode, Node, NodeId, NodeKind,
  defaultNode, defaultStyle, isContainer, newId, newRoot,
} from "./types";
import { emitMainQml } from "./qmlEmit";
import { exportLgx, placeholderIcon } from "./lgxExport";

// Renderer iframe URL — served by renderer/serve.py on port 8765.
// Run `python3 renderer/serve.py 8765` from the lgx-builder root.
const RENDERER_URL = "http://127.0.0.1:8765/index.html";

const PALETTE: { kind: NodeKind; label: string }[] = [
  { kind: "Text",          label: "Text" },
  { kind: "Button",        label: "Button" },
  { kind: "Rectangle",     label: "Rectangle" },
  { kind: "Frame",         label: "Frame" },
  { kind: "Image",         label: "Image" },
  { kind: "AnimatedImage", label: "Animated image" },
  { kind: "TextField",     label: "Text field" },
  { kind: "TextArea",      label: "Text area" },
  { kind: "ComboBox",      label: "ComboBox" },
  { kind: "CheckBox",      label: "Checkbox" },
  { kind: "RadioButton",   label: "Radio button" },
  { kind: "Switch",        label: "Switch" },
  { kind: "Slider",        label: "Slider" },
  { kind: "SpinBox",       label: "SpinBox" },
  { kind: "ProgressBar",   label: "Progress bar" },
  { kind: "BusyIndicator", label: "Busy indicator" },
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

// ── History reducer ─────────────────────────────────────────────────────────

interface HistoryState {
  root: FrameNode;
  past: FrameNode[];
  future: FrameNode[];
}

type Action =
  | { type: "snapshot" }                      // push current root to past, clear future
  | { type: "set"; root: FrameNode }          // replace root with no history change
  | { type: "commit"; root: FrameNode }       // snapshot + set in one shot
  | { type: "undo" }
  | { type: "redo" };

function reducer(state: HistoryState, action: Action): HistoryState {
  switch (action.type) {
    case "snapshot":
      return {
        ...state,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.root],
        future: [],
      };
    case "set":
      return { ...state, root: action.root };
    case "commit":
      return {
        root: action.root,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.root],
        future: [],
      };
    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        root: prev,
        future: [...state.future, state.root],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        past: [...state.past, state.root],
        root: next,
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

interface SaveState {
  version: 1;
  root: FrameNode;
  moduleMeta: ModuleMeta;
  iconBase64: string;
  iconFilename: string;
  collapsedIds: NodeId[];
}

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

const loadFromStorage = (): SaveState | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SaveState;
    if (parsed?.version !== 1 || !parsed.root) return null;
    return parsed;
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
    root: newRoot(),
    past: [],
    future: [],
  }));
  const root = hist.root;

  const [selectedId, setSelectedId] = useState<NodeId | null>(null);
  const [draggingKind, setDraggingKind] = useState<NodeKind | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const designFileInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  // Track the latest root in a ref so async observers can read it without
  // re-binding their callbacks on every state change.
  const rootRef = useRef(root);
  useEffect(() => { rootRef.current = root; }, [root]);

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
    if (!saved || saved.version !== 1) return;
    if (saved.root) dispatch({ type: "set", root: saved.root });
    if (saved.moduleMeta) setModuleMeta(saved.moduleMeta);
    if (saved.iconBase64) setIconPng(base64ToU8(saved.iconBase64));
    if (saved.iconFilename) setIconFilename(saved.iconFilename);
    if (saved.collapsedIds) setCollapsedIds(new Set(saved.collapsedIds));
  }, []);

  // The Qt-WASM renderer uses SizeRootObjectToView, so the QML root sizes to
  // whatever pixel dimensions the iframe gets from CSS layout. Mirror that
  // here: bind the editor root's width/height to the iframe's clientRect so
  // the canvas you design in is the exact same surface the preview shows.
  // We don't snapshot history for layout-driven resizes — undo shouldn't
  // step through window-resize events.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const sync = () => {
      const w = iframe.clientWidth;
      const h = iframe.clientHeight;
      if (w <= 0 || h <= 0) return;
      const cur = rootRef.current;
      if (cur.width === w && cur.height === h) return;
      dispatch({ type: "set", root: { ...cur, width: w, height: h } });
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
    setSelectedId(node.id);
  };

  const qmlPreview = useMemo(() => emitMainQml(root, false), [root]);
  const qmlExport = useMemo(() => emitMainQml(root, true), [root]);

  useEffect(() => {
    const id = setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "loadQml", source: qmlPreview }, "*",
      );
    }, 100);
    return () => clearTimeout(id);
  }, [qmlPreview]);

  // ── Edit ops (each one snapshots history at the right boundary) ──────────

  const updateNode = (id: NodeId, patch: Partial<Node>) => {
    dispatch({
      type: "commit",
      root: mutateTree(root, (clone) => {
        const { node } = findNode(clone, id);
        if (node) Object.assign(node, patch);
      }),
    });
  };

  const insertChild = (parentId: NodeId, child: Node) => {
    dispatch({
      type: "commit",
      root: mutateTree(root, (clone) => {
        const { node } = findNode(clone, parentId);
        if (node && isContainer(node)) node.children.push(child);
      }),
    });
  };

  const deleteNode = (id: NodeId) => {
    if (id === root.id) return;
    dispatch({
      type: "commit",
      root: mutateTree(root, (clone) => {
        const { parent, index } = findNode(clone, id);
        if (parent && index >= 0) parent.children.splice(index, 1);
      }),
    });
    setSelectedId(null);
  };

  const duplicateNode = (id: NodeId) => {
    if (id === root.id) return;
    let newSelectedId: NodeId | null = null;
    dispatch({
      type: "commit",
      root: mutateTree(root, (clone) => {
        const { node, parent, index } = findNode(clone, id);
        if (!node || !parent || index < 0) return;
        const dup = reassignIds(node);
        // Offset slightly so the duplicate is visible on top of the original.
        dup.x += 12; dup.y += 12;
        parent.children.splice(index + 1, 0, dup);
        newSelectedId = dup.id;
      }),
    });
    if (newSelectedId) setSelectedId(newSelectedId);
  };

  // Move an existing node to a new parent + index. Used by the layers
  // panel for reorder / reparent. Guards against creating cycles
  // (dropping a Frame onto its own descendant).
  const moveNode = (sourceId: NodeId, newParentId: NodeId, newIndex: number) => {
    if (sourceId === root.id) return;
    if (isSelfOrDescendant(root, sourceId, newParentId)) return;
    dispatch({
      type: "commit",
      root: mutateTree(root, (clone) => {
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
      const snap: SaveState = {
        version: 1,
        root,
        moduleMeta,
        iconBase64: u8ToBase64(iconPng),
        iconFilename,
        collapsedIds: [...collapsedIds],
      };
      saveToStorage(snap);
    }, 400);
    return () => clearTimeout(handle);
  }, [root, moduleMeta, iconPng, iconFilename, collapsedIds]);

  // ── Save / Open / New ─────────────────────────────────────────────────────

  const buildSaveState = (): SaveState => ({
    version: 1,
    root,
    moduleMeta,
    iconBase64: u8ToBase64(iconPng),
    iconFilename,
    collapsedIds: [...collapsedIds],
  });

  const applySaveState = (s: SaveState) => {
    if (s.version !== 1 || !s.root) return;
    dispatch({ type: "set", root: s.root });
    if (s.moduleMeta) setModuleMeta(s.moduleMeta);
    if (s.iconBase64) setIconPng(base64ToU8(s.iconBase64));
    if (s.iconFilename) setIconFilename(s.iconFilename);
    setCollapsedIds(new Set(s.collapsedIds ?? []));
    setSelectedId(null);
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
      const text = await file.text();
      const parsed = JSON.parse(text) as SaveState;
      applySaveState(parsed);
    } catch (e) {
      console.error("Failed to open design", e);
      window.alert("Couldn't read that file — make sure it's a .lgx-design.json saved from this editor.");
    }
  };

  const handleNew = () => {
    if (!window.confirm("Clear the canvas and start over? This wipes the current design.")) return;
    if (typeof window !== "undefined") window.localStorage.removeItem(SAVE_KEY);
    dispatch({ type: "set", root: newRoot() });
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
    setSelectedId(null);
  };

  // ── Drag (move) — pointer-event based, captures initial root by reference ──

  const startMove = (e: React.PointerEvent, id: NodeId) => {
    if (e.button !== 0 || id === root.id) return;
    e.stopPropagation();
    const baseRoot = root;                       // captured snapshot
    const found = findNode(baseRoot, id);
    if (!found.node) return;
    const startCx = e.clientX, startCy = e.clientY;
    const origX = found.node.x, origY = found.node.y;
    let snapshotted = false;

    setSelectedId(id);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startCx;
      const dy = ev.clientY - startCy;
      if (!snapshotted && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        dispatch({ type: "snapshot" });
        snapshotted = true;
      }
      const next = mutateTree(baseRoot, (clone) => {
        const f = findNode(clone, id);
        if (f.node) { f.node.x = Math.round(origX + dx); f.node.y = Math.round(origY + dy); }
      });
      dispatch({ type: "set", root: next });
    };
    const onUp = () => {
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
      const next = mutateTree(baseRoot, (clone) => {
        const f = findNode(clone, id);
        if (f.node) {
          f.node.x = Math.round(nx); f.node.y = Math.round(ny);
          f.node.width = Math.round(nw); f.node.height = Math.round(nh);
        }
      });
      dispatch({ type: "set", root: next });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

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
    setSelectedId(fresh.id);
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
        if (selectedId) { e.preventDefault(); duplicateNode(selectedId); }
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        e.preventDefault();
        deleteNode(selectedId);
        return;
      }
      if (selectedId && selectedId !== root.id) {
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        let dx = 0, dy = 0;
        if (e.key === "ArrowLeft")  dx = -step;
        if (e.key === "ArrowRight") dx =  step;
        if (e.key === "ArrowUp")    dy = -step;
        if (e.key === "ArrowDown")  dy =  step;
        if (dx !== 0 || dy !== 0) {
          e.preventDefault();
          const { node } = findNode(root, selectedId);
          if (node) updateNode(selectedId, { x: node.x + dx, y: node.y + dy });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, root]);

  // ── Export ────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    const name = sanitizeName(moduleMeta.name) || "my_widget";

    // Collect every Image node's data URL, write each to assets/<n>.<ext>,
    // and rewrite the tree so the emitted QML references those files
    // instead of inline base64. The tree clone is throwaway — never mounted.
    type AssetEntry = { rel: string; data: Uint8Array };
    const assets: AssetEntry[] = [];
    const seen = new Map<string, string>();   // dataURL -> assetPath
    const exportRoot: FrameNode = JSON.parse(JSON.stringify(root));
    let assetCounter = 0;
    const walk = (n: Node) => {
      if (n.kind === "Image" && n.src.startsWith("data:")) {
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
    exportRoot.children.forEach(walk);
    const qmlSource = emitMainQml(exportRoot, true);

    const result = await exportLgx({
      name,
      version: moduleMeta.version.trim() || "0.1.0",
      description: moduleMeta.description,
      category: moduleMeta.category.trim() || "example",
      author: moduleMeta.author,
      iconPng,
      iconFilename,
      qmlSource,
      extraFiles: assets,
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

  const selectedNode = selectedId ? findNode(root, selectedId).node : null;
  const selectedAbs = selectedId ? absoluteRect(root, selectedId) : null;
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900">
      <header className="flex h-12 items-center justify-between border-b border-zinc-200 bg-white px-4">
        <h1 className="text-sm font-semibold tracking-tight">
          <span className="text-zinc-900">lgx</span>
          <span className="text-zinc-400">.guru</span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
            onClick={handleNew}
            title="Clear and start a new design"
          >New</button>
          <button
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
            onClick={() => designFileInputRef.current?.click()}
            title="Open a saved .lgx-design.json"
          >Open</button>
          <button
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
            onClick={handleSaveDesign}
            title="Download a .lgx-design.json snapshot"
          >Save</button>
          <input
            ref={designFileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleOpenDesign(f);
              e.target.value = "";
            }}
          />
          <span className="mx-1 h-5 w-px bg-zinc-200" />
          <button
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-30"
            disabled={!canUndo}
            onClick={() => dispatch({ type: "undo" })}
            title="Undo (Cmd+Z)"
          >Undo</button>
          <button
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-30"
            disabled={!canRedo}
            onClick={() => dispatch({ type: "redo" })}
            title="Redo (Cmd+Shift+Z)"
          >Redo</button>
          <button
            className="ml-2 rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
            onClick={handleExport}
          >Export .lgx</button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left column: palette (top) + layers (bottom, scrollable) */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-200 bg-white">
          <div className="shrink-0 border-b border-zinc-200 p-3">
            <div className="mb-2 text-xs font-semibold uppercase text-zinc-500">
              Components
            </div>
            <div className="flex flex-col gap-1.5">
              {PALETTE.map((p) => (
                <button
                  key={p.kind}
                  draggable
                  onDragStart={() => setDraggingKind(p.kind)}
                  onDragEnd={() => setDraggingKind(null)}
                  onClick={p.kind === "Image" ? () => imageFileInputRef.current?.click() : undefined}
                  className="cursor-grab rounded border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-left text-xs hover:border-zinc-400 active:cursor-grabbing"
                  title={p.kind === "Image" ? "Click to upload, or drag for a placeholder" : undefined}
                >
                  {p.label}
                </button>
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
            <p className="mt-3 text-[11px] leading-tight text-zinc-500">
              Drag onto the canvas, or drop image files from your OS.
            </p>
            <div className="mt-4 border-t border-zinc-200 pt-3 text-[11px] leading-tight text-zinc-500">
              <div className="mb-1 font-semibold uppercase">Shortcuts</div>
              <div>Cmd+Z / Shift undo · Cmd+D dup</div>
              <div>Del/Backspace remove</div>
              <div>Arrows nudge (Shift = 10px)</div>
            </div>
          </div>

          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-1.5">
              <span className="text-xs font-semibold uppercase text-zinc-500">Layers</span>
              <span className="text-[10px] text-zinc-400">drag to reorder</span>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              <LayersPanel
                root={root}
                selectedId={selectedId}
                onSelect={setSelectedId}
                collapsedIds={collapsedIds}
                onToggleCollapsed={toggleCollapsed}
                onToggleHidden={toggleHidden}
                onToggleLocked={toggleLocked}
                onMove={moveNode}
              />
            </div>
          </div>
        </aside>

        {/* Canvas + preview */}
        <main className="flex flex-1 flex-col min-w-0">
          {/* Canvas section — same inner shape as the preview section below
              (bar header + flex-1 full-bleed content area) so their content
              dimensions match exactly and the canvas == preview pixel-for-pixel. */}
          <section className="flex flex-1 flex-col bg-zinc-100 min-h-0">
            <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-3 py-1.5">
              <span className="text-xs font-semibold uppercase text-zinc-500">
                Canvas
              </span>
              <span className="text-[11px] text-zinc-400">
                {root.width}×{root.height}px · drag · resize
              </span>
            </div>
            <div
              ref={canvasRef}
              className="relative flex-1 overflow-hidden"
              onClick={() => setSelectedId(null)}
            >
              <CanvasArea
                root={root}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onStartMove={startMove}
                onCanvasDrop={handleCanvasDrop}
                onCanvasDragOver={handleCanvasDragOver}
                draggingKind={draggingKind}
                resizeOverlay={
                  selectedAbs && selectedId && selectedId !== root.id && selectedNode && !selectedNode.locked ? (
                    <ResizeOverlay
                      rect={selectedAbs}
                      onStart={(anchor, e) => startResize(e, selectedId, anchor)}
                    />
                  ) : null
                }
              />
            </div>
          </section>

          <section className="flex h-1/2 flex-col bg-zinc-100 min-h-0">
            <div className="flex items-center justify-between border-t border-zinc-200 bg-white px-3 py-1.5">
              <span className="text-xs font-semibold uppercase text-zinc-500">
                Live preview (Qt-WASM)
              </span>
              <span className="text-[11px] text-zinc-400">renderer @ {RENDERER_URL}</span>
            </div>
            <iframe
              ref={iframeRef}
              src={RENDERER_URL}
              className="h-full w-full bg-white"
              title="qml-renderer"
            />
          </section>
        </main>

        {/* Inspector */}
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-zinc-200 bg-white p-3">
          <ModulePanel
            meta={moduleMeta}
            onChange={setModuleMeta}
            iconPreviewUrl={iconPreviewUrl}
            iconFilename={iconFilename}
            iconError={iconError}
            onIconUpload={handleIconUpload}
            sanitizedName={sanitizeName(moduleMeta.name) || "my_widget"}
          />

          <div className="my-4 border-t border-zinc-200" />

          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-zinc-500">
              Inspector
            </span>
            {selectedNode && selectedId !== root.id && (
              <div className="flex items-center gap-2">
                <button
                  className="text-[11px] text-zinc-600 hover:underline"
                  onClick={() => selectedId && duplicateNode(selectedId)}
                >duplicate</button>
                <button
                  className="text-[11px] text-red-600 hover:underline"
                  onClick={() => selectedId && deleteNode(selectedId)}
                >delete</button>
              </div>
            )}
          </div>
          {!selectedNode ? (
            <p className="text-xs text-zinc-500">
              Click a node in the canvas to edit. Click empty space to deselect.
            </p>
          ) : (
            <Inspector
              node={selectedNode}
              isRoot={selectedId === root.id}
              onChange={(patch) => selectedId && updateNode(selectedId, patch)}
            />
          )}
          <details className="mt-6">
            <summary className="cursor-pointer text-xs font-semibold uppercase text-zinc-500">
              Generated QML
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-50 p-2 text-[10px] leading-tight text-zinc-700">
              {qmlExport}
            </pre>
          </details>
        </aside>
      </div>
    </div>
  );
}

// ── CanvasArea ──────────────────────────────────────────────────────────────

function CanvasArea({
  root,
  selectedId,
  onSelect,
  onStartMove,
  onCanvasDrop,
  onCanvasDragOver,
  draggingKind,
  resizeOverlay,
}: {
  root: FrameNode;
  selectedId: NodeId | null;
  onSelect: (id: NodeId | null) => void;
  onStartMove: (e: React.PointerEvent, id: NodeId) => void;
  onCanvasDrop: (e: React.DragEvent, frameId: NodeId) => void;
  onCanvasDragOver: (e: React.DragEvent) => void;
  draggingKind: NodeKind | null;
  resizeOverlay: React.ReactNode;
}) {
  return (
    <div
      className="relative inline-block bg-white"
      style={{ width: root.width, height: root.height }}
      onClick={(e) => { e.stopPropagation(); onSelect(root.id); }}
      onDragOver={onCanvasDragOver}
      onDrop={(e) => onCanvasDrop(e, root.id)}
    >
      {root.children.map((child) => (
        <NodeView
          key={child.id}
          node={child}
          selectedId={selectedId}
          onSelect={onSelect}
          onStartMove={onStartMove}
          onCanvasDrop={onCanvasDrop}
          onCanvasDragOver={onCanvasDragOver}
          draggingKind={draggingKind}
        />
      ))}
      {resizeOverlay}
    </div>
  );
}

// Build the CSS-equivalent of the node's CommonStyle, plus its absolute
// positioning. `box-sizing: border-box` matches Qt's Rectangle (border draws
// inside the bounds, not outside).
function commonStyleCss(node: Node): React.CSSProperties {
  const s = node.style;
  return {
    position: "absolute",
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    backgroundColor: s.backgroundColor,
    opacity: s.opacity,
    borderColor: s.borderColor,
    borderWidth: s.borderWidth,
    borderStyle: s.borderWidth > 0 ? "solid" : "none",
    borderRadius: s.borderRadius,
    transform: s.rotation !== 0 ? `rotate(${s.rotation}deg)` : undefined,
    boxSizing: "border-box",
    overflow: "hidden",
  };
}

function NodeView({
  node,
  selectedId,
  onSelect,
  onStartMove,
  onCanvasDrop,
  onCanvasDragOver,
  draggingKind,
}: {
  node: Node;
  selectedId: NodeId | null;
  onSelect: (id: NodeId | null) => void;
  onStartMove: (e: React.PointerEvent, id: NodeId) => void;
  onCanvasDrop: (e: React.DragEvent, frameId: NodeId) => void;
  onCanvasDragOver: (e: React.DragEvent) => void;
  draggingKind: NodeKind | null;
}) {
  // Hidden nodes don't render in the canvas at all (they don't ship to QML
  // either — see qmlEmit.ts). Toggle in the layers panel to bring back.
  if (node.hidden) return null;

  const isSelected = node.id === selectedId;
  const cssStyle = commonStyleCss(node);

  // Selection outline lives on a separate transparent overlay so it doesn't
  // get clipped by overflow:hidden on the styled wrapper.
  const selectionOutline = isSelected
    ? "outline outline-2 outline-offset-[-2px] outline-blue-500"
    : "hover:outline hover:outline-1 hover:outline-offset-[-1px] hover:outline-blue-300";

  // Locked nodes are still selectable (so the user can unlock them) but
  // can't be moved or resized; pointerdown skips startMove.
  const commonProps = {
    onPointerDown: node.locked
      ? undefined
      : (e: React.PointerEvent) => onStartMove(e, node.id),
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); onSelect(node.id); },
  };

  if (node.kind === "Frame") {
    // Frames get a faint dashed editor-only border when transparent so users
    // can see and grab them. If the user sets a backgroundColor, drop the
    // dashed chrome (the real bg makes the frame visible on its own).
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
            selectedId={selectedId}
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

  if (node.kind === "Text") {
    // Inner div so text-align works with vertical centering via flex.
    return (
      <div
        {...commonProps}
        className={`cursor-grab active:cursor-grabbing ${selectionOutline}`}
        style={{
          ...cssStyle,
          display: "flex",
          alignItems: "center",
          userSelect: "none",
          fontSize: node.pixelSize,
          color: node.color,
          fontWeight: node.fontWeight,
          fontStyle: node.italic ? "italic" : "normal",
          fontFamily: node.fontFamily || undefined,
          letterSpacing: node.letterSpacing,
          lineHeight: node.lineHeight,
        }}
      >
        <div style={{ width: "100%", textAlign: node.textAlign }}>
          {node.text || <span className="italic text-zinc-400">(empty)</span>}
        </div>
      </div>
    );
  }

  if (node.kind === "Button") {
    return (
      <div
        {...commonProps}
        className={`cursor-grab active:cursor-grabbing ${selectionOutline}`}
        style={cssStyle}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => e.preventDefault()}
          style={{
            width: "100%",
            height: "100%",
            color: node.textColor,
            fontWeight: node.fontWeight,
            background: node.style.backgroundColor === "transparent"
              ? "rgb(244, 244, 245)"  // zinc-100 default chrome
              : "transparent",         // honor the user's bg via outer wrapper
            border: node.style.borderWidth > 0 ? "none" : "1px solid rgb(161, 161, 170)",
            borderRadius: "inherit",
            cursor: "inherit",
            pointerEvents: "none",
            fontFamily: "inherit",
            fontSize: "inherit",
          }}
        >
          {node.text}
        </button>
      </div>
    );
  }

  if (node.kind === "Image") {
    return (
      <div
        {...commonProps}
        className={`cursor-grab active:cursor-grabbing ${selectionOutline}`}
        style={cssStyle}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={node.src}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: node.fit,
            display: "block",
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
      </div>
    );
  }

  // The Controls 2 family below: render an approximation of the Qt control
  // with its own internal events disabled so the canvas drag/select wins.
  // These are previews — not interactive in the editor.
  const innerNoInteract: React.CSSProperties = {
    pointerEvents: "none",
    userSelect: "none",
  };

  if (node.kind === "TextField") {
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <input
          type="text"
          value={node.text}
          placeholder={node.placeholder}
          readOnly
          tabIndex={-1}
          onChange={() => {}}
          style={{
            ...innerNoInteract,
            width: "100%",
            height: "100%",
            padding: "0 8px",
            border: "1px solid rgb(161, 161, 170)",
            borderRadius: "inherit",
            fontSize: node.pixelSize,
            background: node.style.backgroundColor === "transparent" ? "white" : "transparent",
            boxSizing: "border-box",
          }}
        />
      </div>
    );
  }

  if (node.kind === "CheckBox") {
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          display: "flex", alignItems: "center", gap: 6, height: "100%", padding: "0 4px",
        }}>
          <span style={{
            display: "inline-block",
            width: 16, height: 16,
            border: "1px solid rgb(115, 115, 115)",
            borderRadius: 3,
            background: node.checked ? "rgb(37, 99, 235)" : "white",
            position: "relative",
          }}>
            {node.checked && (
              <svg viewBox="0 0 16 16" width="14" height="14" style={{ position: "absolute", top: 0, left: 0 }}>
                <path d="M3 8 L 7 12 L 13 4" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <span style={{ fontSize: node.pixelSize, color: "rgb(39, 39, 42)" }}>{node.text}</span>
        </div>
      </div>
    );
  }

  if (node.kind === "Switch") {
    const trackW = 36, trackH = 20, dotR = 8;
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          display: "flex", alignItems: "center", gap: 8, height: "100%", padding: "0 4px",
        }}>
          <span style={{
            position: "relative",
            display: "inline-block",
            width: trackW, height: trackH,
            borderRadius: trackH / 2,
            background: node.checked ? "rgb(37, 99, 235)" : "rgb(212, 212, 216)",
          }}>
            <span style={{
              position: "absolute",
              top: (trackH - dotR * 2) / 2,
              left: node.checked ? trackW - dotR * 2 - 2 : 2,
              width: dotR * 2, height: dotR * 2,
              borderRadius: "50%",
              background: "white",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }} />
          </span>
          <span style={{ fontSize: node.pixelSize, color: "rgb(39, 39, 42)" }}>{node.text}</span>
        </div>
      </div>
    );
  }

  if (node.kind === "Slider") {
    const range = node.to - node.from || 1;
    const pct = Math.max(0, Math.min(1, (node.value - node.from) / range));
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          position: "relative",
          height: "100%", display: "flex", alignItems: "center", padding: "0 8px",
        }}>
          <div style={{ position: "relative", width: "100%", height: 4 }}>
            <div style={{
              position: "absolute", inset: 0,
              background: "rgb(212, 212, 216)", borderRadius: 2,
            }} />
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${pct * 100}%`,
              background: "rgb(37, 99, 235)", borderRadius: 2,
            }} />
            <div style={{
              position: "absolute", top: -6, left: `calc(${pct * 100}% - 8px)`,
              width: 16, height: 16, borderRadius: "50%",
              background: "white", border: "1px solid rgb(115, 115, 115)",
              boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
            }} />
          </div>
        </div>
      </div>
    );
  }

  if (node.kind === "ProgressBar") {
    const range = node.to - node.from || 1;
    const pct = Math.max(0, Math.min(1, (node.value - node.from) / range));
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          position: "relative", height: "100%", width: "100%",
          background: "rgb(212, 212, 216)", borderRadius: "inherit", overflow: "hidden",
        }}>
          {node.indeterminate ? (
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(90deg, transparent 0%, rgb(37, 99, 235) 50%, transparent 100%)",
              backgroundSize: "200% 100%",
            }} />
          ) : (
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${pct * 100}%`,
              background: "rgb(37, 99, 235)",
            }} />
          )}
        </div>
      </div>
    );
  }

  if (node.kind === "TextArea") {
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <textarea
          value={node.text}
          placeholder={node.placeholder}
          readOnly
          tabIndex={-1}
          onChange={() => {}}
          style={{
            ...innerNoInteract,
            width: "100%", height: "100%",
            padding: "6px 8px",
            border: "1px solid rgb(161, 161, 170)",
            borderRadius: "inherit",
            fontSize: node.pixelSize,
            background: node.style.backgroundColor === "transparent" ? "white" : "transparent",
            boxSizing: "border-box",
            resize: "none",
            whiteSpace: node.wrapMode === "word" ? "pre-wrap" : "pre",
            overflow: "auto",
            fontFamily: "inherit",
          }}
        />
      </div>
    );
  }

  if (node.kind === "RadioButton") {
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          display: "flex", alignItems: "center", gap: 6, height: "100%", padding: "0 4px",
        }}>
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16,
            border: "1.5px solid rgb(115, 115, 115)",
            borderRadius: "50%",
            background: "white",
          }}>
            {node.checked && (
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "rgb(37, 99, 235)",
              }} />
            )}
          </span>
          <span style={{ fontSize: node.pixelSize, color: "rgb(39, 39, 42)" }}>{node.text}</span>
        </div>
      </div>
    );
  }

  if (node.kind === "ComboBox") {
    const current = node.model[node.currentIndex] ?? "";
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          height: "100%", padding: "0 8px",
          border: "1px solid rgb(161, 161, 170)",
          borderRadius: "inherit",
          background: node.style.backgroundColor === "transparent" ? "white" : "transparent",
          fontSize: node.pixelSize,
        }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {current || <span style={{ color: "rgb(161, 161, 170)" }}>(empty)</span>}
          </span>
          <span style={{ marginLeft: 8, color: "rgb(115, 115, 115)" }}>▾</span>
        </div>
      </div>
    );
  }

  if (node.kind === "SpinBox") {
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          display: "grid", gridTemplateColumns: "28px 1fr 28px",
          height: "100%",
          border: "1px solid rgb(161, 161, 170)",
          borderRadius: "inherit",
          background: node.style.backgroundColor === "transparent" ? "white" : "transparent",
          overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgb(244, 244, 245)", color: "rgb(115, 115, 115)",
            borderRight: "1px solid rgb(212, 212, 216)",
          }}>−</div>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            fontVariantNumeric: "tabular-nums",
          }}>{node.value}</div>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgb(244, 244, 245)", color: "rgb(115, 115, 115)",
            borderLeft: "1px solid rgb(212, 212, 216)",
          }}>+</div>
        </div>
      </div>
    );
  }

  if (node.kind === "BusyIndicator") {
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        <div style={{
          ...innerNoInteract,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {node.running ? (
            <div style={{
              width: "60%", height: "60%", aspectRatio: "1 / 1",
              borderRadius: "50%",
              border: "3px solid rgb(212, 212, 216)",
              borderTopColor: "rgb(37, 99, 235)",
              animation: "spin 0.9s linear infinite",
            }} />
          ) : (
            <div style={{
              width: "60%", height: "60%", aspectRatio: "1 / 1",
              borderRadius: "50%",
              border: "3px solid rgb(212, 212, 216)",
            }} />
          )}
          <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
        </div>
      </div>
    );
  }

  if (node.kind === "AnimatedImage") {
    return (
      <div {...commonProps} className={`cursor-grab active:cursor-grabbing ${selectionOutline}`} style={cssStyle}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={node.src}
          alt=""
          draggable={false}
          style={{
            width: "100%", height: "100%",
            objectFit: node.fit,
            display: "block",
            pointerEvents: "none",
            userSelect: "none",
            opacity: node.playing ? 1 : 0.5,
          }}
        />
      </div>
    );
  }

  // Rectangle — visual is entirely the CommonStyle.
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
          className="pointer-events-auto absolute rounded-sm border border-blue-500 bg-white"
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

const I_LABEL = "block text-[11px] font-medium text-zinc-600 mb-0.5";
const I_INPUT =
  "w-full rounded border border-zinc-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none";
const I_SUMMARY =
  "cursor-pointer text-[11px] font-semibold uppercase text-zinc-500 select-none mb-2";

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
    <label className="flex items-center gap-2 text-[11px] text-zinc-600">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-zinc-300"
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
  return (
    <div>
      <label className={I_LABEL}>{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={isHex ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-7 shrink-0 cursor-pointer rounded border border-zinc-300 p-0"
          title="Pick color"
        />
        <input
          className={I_INPUT}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#rrggbb / transparent"
        />
      </div>
    </div>
  );
}

function Inspector({
  node,
  isRoot,
  onChange,
}: {
  node: Node;
  isRoot: boolean;
  onChange: (patch: Partial<Node>) => void;
}) {
  // Style is nested — patch helper builds {style: {...node.style, ...patch}}
  const updateStyle = (patch: Partial<typeof node.style>) =>
    onChange({ style: { ...node.style, ...patch } } as Partial<Node>);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[11px] text-zinc-500">
        kind: <span className="font-mono">{node.kind}</span>
      </div>

      {/* Position + size */}
      <details open>
        <summary className={I_SUMMARY}>Position</summary>
        {isRoot ? (
          <div className="text-[11px] text-zinc-500">
            <div className="mb-1">
              size <span className="font-mono">{node.width}×{node.height}px</span>
            </div>
            <div className="text-zinc-400">auto-sized to the live preview</div>
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
        <summary className={I_SUMMARY}>Style</summary>
        <div className="flex flex-col gap-2.5">
          <ColorField
            label="background"
            value={node.style.backgroundColor}
            onChange={(v) => updateStyle({ backgroundColor: v })}
          />
          <NumField
            label="opacity (0–1)"
            step={0.05}
            value={node.style.opacity}
            onChange={(v) => updateStyle({ opacity: Math.max(0, Math.min(1, v)) })}
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
          <NumField
            label="rotation (°)"
            value={node.style.rotation}
            onChange={(v) => updateStyle({ rotation: v })}
          />
        </div>
      </details>

      {/* Type-specific */}
      {node.kind === "Text" && (
        <details open>
          <summary className={I_SUMMARY}>Text</summary>
          <div className="flex flex-col gap-2.5">
            <TextField label="content" value={node.text} onChange={(v) => onChange({ text: v } as Partial<LeafNode>)} />
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
            <TextField label="value" value={node.text}
              onChange={(v) => onChange({ text: v } as Partial<LeafNode>)} />
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
            <TextField label="label" value={node.text}
              onChange={(v) => onChange({ text: v } as Partial<LeafNode>)} />
            <NumField label="pixelSize" value={node.pixelSize}
              onChange={(v) => onChange({ pixelSize: Math.max(1, v) } as Partial<LeafNode>)} />
            <CheckboxField label="checked" checked={node.checked}
              onChange={(v) => onChange({ checked: v } as Partial<LeafNode>)} />
          </div>
        </details>
      )}

      {node.kind === "Slider" && (
        <details open>
          <summary className={I_SUMMARY}>Slider</summary>
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-2 gap-2">
              <NumField label="from" value={node.from}
                onChange={(v) => onChange({ from: v } as Partial<LeafNode>)} />
              <NumField label="to" value={node.to}
                onChange={(v) => onChange({ to: v } as Partial<LeafNode>)} />
            </div>
            <NumField label="value" value={node.value}
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
            <TextField label="value" value={node.text}
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
            <p className="text-[11px] leading-tight text-zinc-500">
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
            <p className="text-[11px] leading-tight text-zinc-500">
              For local files, paste a data: URL or use the Image upload as
              a starting point. GIF / animated WebP recommended.
            </p>
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
      <label className="text-[11px] font-medium text-zinc-600">model</label>
      {value.map((v, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            value={v}
            onChange={(e) => update(i, e.target.value)}
            className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={() => move(i, -1)}
            disabled={i === 0}
            className="rounded px-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"
            title="move up"
          >▲</button>
          <button
            onClick={() => move(i, 1)}
            disabled={i === value.length - 1}
            className="rounded px-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"
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
        className="self-start rounded border border-dashed border-zinc-300 px-2 py-1 text-[11px] text-zinc-600 hover:border-zinc-500"
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
          className="h-20 w-full rounded border border-zinc-200 bg-zinc-50 object-contain"
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
          className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs hover:border-zinc-400"
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
  const labelClass = "block text-[11px] font-medium text-zinc-600 mb-0.5";
  const inputClass =
    "w-full rounded border border-zinc-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none";
  const fileInputRef = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<ModuleMeta>) => onChange({ ...meta, ...patch });

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase text-zinc-500">
        Module
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start gap-2">
          {iconPreviewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={iconPreviewUrl}
              alt="icon"
              className="h-12 w-12 shrink-0 rounded border border-zinc-200 bg-zinc-50 object-contain"
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
              className="w-full truncate rounded border border-zinc-300 bg-white px-1.5 py-1 text-left text-xs hover:border-zinc-400"
              onClick={() => fileInputRef.current?.click()}
              title={iconFilename}
            >
              {iconFilename}
            </button>
            {iconError && <p className="mt-1 text-[11px] text-red-600">{iconError}</p>}
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
            <p className="mt-0.5 text-[11px] text-zinc-500">
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

const kindGlyph = (k: NodeKind): string => {
  switch (k) {
    case "Frame":          return "▢";
    case "Rectangle":      return "■";
    case "Text":           return "T";
    case "Button":         return "▭";
    case "Image":          return "◇";
    case "AnimatedImage":  return "◆";
    case "TextField":      return "I";
    case "TextArea":       return "≡";
    case "ComboBox":       return "▼";
    case "CheckBox":       return "☑";
    case "RadioButton":    return "◉";
    case "Switch":         return "◐";
    case "Slider":         return "═";
    case "SpinBox":        return "#";
    case "ProgressBar":    return "▰";
    case "BusyIndicator":  return "◌";
  }
};

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

type DropWhere = "before" | "after" | "inside";

function LayersPanel({
  root,
  selectedId,
  onSelect,
  collapsedIds,
  onToggleCollapsed,
  onToggleHidden,
  onToggleLocked,
  onMove,
}: {
  root: FrameNode;
  selectedId: NodeId | null;
  onSelect: (id: NodeId) => void;
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
    const isSelected = node.id === selectedId;
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
        onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
        style={{ paddingLeft: 4 + depth * 12 }}
        className={[
          "relative flex items-center gap-1 py-1 pr-2 text-[11px] cursor-pointer select-none",
          isSelected ? "bg-blue-100 text-blue-900" : "text-zinc-700 hover:bg-zinc-50",
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
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[8px] text-zinc-500 hover:text-zinc-800"
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        <span className="font-mono text-zinc-400 shrink-0">{kindGlyph(node.kind)}</span>
        <span className="flex-1 truncate">{kindLabel(node)}</span>

        {!isRoot && (
          <>
            <button
              title={node.locked ? "Unlock" : "Lock"}
              onClick={(e) => { e.stopPropagation(); onToggleLocked(node.id); }}
              className={`shrink-0 ${node.locked ? "text-amber-600" : "text-zinc-400 hover:text-zinc-700"}`}
            >
              <IconLock locked={node.locked} />
            </button>
            <button
              title={node.hidden ? "Show" : "Hide"}
              onClick={(e) => { e.stopPropagation(); onToggleHidden(node.id); }}
              className={`shrink-0 ${node.hidden ? "text-zinc-400" : "text-zinc-500 hover:text-zinc-700"}`}
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
