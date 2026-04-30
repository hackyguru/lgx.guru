"use client";

// Multi-project persistence layer. Backed by localStorage today (one entry
// per project + an index for the dashboard). Designed so the surface stays
// stable if we move to a server/filesystem store later — every operation
// would just go async and route through /api/projects/...
//
// Storage shape:
//   lgx.guru/v2/projects                  → ProjectMeta[]   (index)
//   lgx.guru/v2/project/<id>              → unknown         (full SaveState)
//   lgx.guru/v1/save                      → legacy single-project save
//                                           (migrated into v2 on first run)

const INDEX_KEY = "lgx.guru/v2/projects";
const PROJECT_KEY = (id: string) => `lgx.guru/v2/project/${id}`;
const LEGACY_KEY = "lgx.guru/v1/save";

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

const newProjectId = (): string =>
  `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const safeRead = <T,>(key: string, fallback: T): T => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const safeWrite = (key: string, value: unknown): boolean => {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // QuotaExceeded etc.
    return false;
  }
};

const readIndex = (): ProjectMeta[] => safeRead<ProjectMeta[]>(INDEX_KEY, []);
const writeIndex = (list: ProjectMeta[]) => safeWrite(INDEX_KEY, list);

export function listProjects(): ProjectMeta[] {
  return [...readIndex()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProjectMeta(id: string): ProjectMeta | null {
  return readIndex().find((p) => p.id === id) ?? null;
}

export function getProjectState(id: string): unknown {
  return safeRead<unknown>(PROJECT_KEY(id), null);
}

export function saveProjectState(id: string, state: unknown): void {
  safeWrite(PROJECT_KEY(id), state);
  // Bump updatedAt on the index so the dashboard sort reflects activity.
  const index = readIndex();
  const idx = index.findIndex((p) => p.id === id);
  if (idx >= 0) {
    index[idx] = { ...index[idx], updatedAt: Date.now() };
    writeIndex(index);
  }
}

export function createProject(name: string): ProjectMeta {
  const meta: ProjectMeta = {
    id: newProjectId(),
    name: name.trim() || "Untitled project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeIndex([...readIndex(), meta]);
  return meta;
}

export function renameProject(id: string, name: string): void {
  const index = readIndex();
  const idx = index.findIndex((p) => p.id === id);
  if (idx < 0) return;
  index[idx] = { ...index[idx], name: name.trim() || index[idx].name, updatedAt: Date.now() };
  writeIndex(index);
}

export function deleteProject(id: string): void {
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(PROJECT_KEY(id)); } catch {}
  }
  writeIndex(readIndex().filter((p) => p.id !== id));
}

// Idempotent: if a v2 index already exists, do nothing. Otherwise lift the
// legacy single-project save into a fresh project so existing users don't
// see an empty dashboard.
export function migrateLegacy(): ProjectMeta | null {
  if (typeof window === "undefined") return null;
  if (readIndex().length > 0) return null;
  const legacy = safeRead<unknown>(LEGACY_KEY, null);
  if (!legacy) return null;
  const meta = createProject("My first project");
  saveProjectState(meta.id, legacy);
  return meta;
}
