"use client";

// Project list. Migrates the legacy single-project localStorage entry into
// a real project on first visit, so returning users land on their work
// rather than an empty page.

import React, { useEffect, useState } from "react";
import {
  createProject, deleteProject, listProjects, migrateLegacy, renameProject,
  type ProjectMeta,
} from "../lib/projects";

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    migrateLegacy();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjects(listProjects());
    setHydrated(true);
  }, []);

  const refresh = () => setProjects(listProjects());

  const handleNew = () => {
    const name = window.prompt("Name your project", "Untitled project");
    if (name === null) return;
    const meta = createProject(name);
    window.location.assign(`/?project=${encodeURIComponent(meta.id)}`);
  };

  const handleOpen = (id: string) => {
    window.location.assign(`/?project=${encodeURIComponent(id)}`);
  };

  const handleRename = (p: ProjectMeta) => {
    const name = window.prompt("Rename project", p.name);
    if (name === null) return;
    renameProject(p.id, name);
    refresh();
  };

  const handleDelete = (p: ProjectMeta) => {
    if (!window.confirm(`Delete "${p.name}"? This can't be undone.`)) return;
    deleteProject(p.id);
    refresh();
  };

  // Absolute timestamp avoids reading Date.now() during render (rules of
  // react / impurity). Loses the "5 min ago" feel but stays accurate without
  // needing a periodic re-render to keep relative strings fresh.
  const fmtUpdated = (ts: number): string => new Date(ts).toLocaleString();

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-10 dark:bg-zinc-800">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-center justify-between">
          <h1 className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/lgx-logo.svg"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 dark:invert"
            />
            <span className="text-xl font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
              Projects
            </span>
          </h1>
          <button
            onClick={handleNew}
            className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            + New project
          </button>
        </header>

        {!hydrated ? (
          <div className="rounded border border-zinc-200 bg-white p-6 text-center text-xs text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500">
            Loading…
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-600 dark:bg-zinc-900">
            <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
              No projects yet
            </div>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-snug text-zinc-500 dark:text-zinc-400">
              Each project is a self-contained <span className="font-mono">.lgx</span> module — drag-and-drop UI plus optional AI-built backend logic.
            </p>
            <button
              onClick={handleNew}
              className="mt-4 rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Create your first project
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => (
              <li
                key={p.id}
                className="group flex items-stretch gap-2 rounded border border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600"
              >
                <button
                  onClick={() => handleOpen(p.id)}
                  className="flex-1 px-4 py-3 text-left"
                >
                  <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                    {p.name}
                  </div>
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    Updated {fmtUpdated(p.updatedAt)}
                  </div>
                </button>
                <div className="flex items-center gap-1 pr-3 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => handleRename(p)}
                    className="rounded px-2 py-1 text-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    title="Rename"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => handleDelete(p)}
                    className="rounded px-2 py-1 text-[10px] text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-center text-[10px] text-zinc-400 dark:text-zinc-500">
          Projects are stored in this browser. Use the editor&apos;s Save button to download a portable <span className="font-mono">.lgx-design.json</span> backup.
        </p>
      </div>
    </main>
  );
}
