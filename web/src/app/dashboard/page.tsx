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

  // Render relative when recent, absolute otherwise. Reads Date.now once at
  // render so it's stable for the row but doesn't try to update live.
  const fmtUpdated = (ts: number, now: number): string => {
    const diff = now - ts;
    const m = 60_000;
    if (diff < m) return "just now";
    if (diff < 60 * m) return `${Math.floor(diff / m)}m ago`;
    if (diff < 24 * 60 * m) return `${Math.floor(diff / (60 * m))}h ago`;
    if (diff < 7 * 24 * 60 * m) return `${Math.floor(diff / (24 * 60 * m))}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  const now = hydrated ? Date.now() : 0;

  return (
    <main className="min-h-screen bg-linear-to-b from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-950">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/lgx-logo.svg"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 dark:invert"
            />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                Projects
              </h1>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                lgx.guru — visual builder for Logos Basecamp modules
              </p>
            </div>
          </div>
          <button
            onClick={handleNew}
            className="rounded-md bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400"
          >
            <span className="mr-1">+</span>New project
          </button>
        </header>

        {!hydrated ? (
          <div className="rounded-lg border border-zinc-200 bg-white/60 p-8 text-center text-xs text-zinc-400 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-500">
            Loading…
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white/60 p-12 text-center backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/40">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </div>
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              No projects yet
            </div>
            <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Each project is a self-contained <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] dark:bg-zinc-800">.lgx</span> module — drag-and-drop UI plus optional AI-built backend logic.
            </p>
            <button
              onClick={handleNew}
              className="mt-5 rounded-md bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400"
            >
              Create your first project
            </button>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {projects.map((p) => (
              <li
                key={p.id}
                className="group flex items-stretch gap-2 rounded-md border border-zinc-200 bg-white shadow-sm transition-all hover:border-indigo-300 hover:shadow dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700"
              >
                <button
                  onClick={() => handleOpen(p.id)}
                  className="flex-1 px-4 py-3 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                      {p.name}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                    Updated {fmtUpdated(p.updatedAt, now)}
                  </div>
                </button>
                <div className="flex items-center gap-1 pr-2.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    onClick={() => handleRename(p)}
                    className="rounded px-2 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    title="Rename"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => handleDelete(p)}
                    className="rounded px-2 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:text-zinc-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-8 text-center text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          Projects are stored in this browser. Use Export → Download project (.json) for a portable backup.
        </p>
      </div>
    </main>
  );
}
