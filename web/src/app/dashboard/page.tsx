"use client";

// Project list. Migrates the legacy single-project localStorage entry into
// a real project on first visit, so returning users land on their work
// rather than an empty page.

import React, { useEffect, useState } from "react";
import {
  createProject, deleteProject, listProjects, migrateLegacy, renameProject,
  type ProjectMeta,
} from "../lib/projects";
import ThemeToggle from "../ThemeToggle";

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
    window.location.assign(`/builder?project=${encodeURIComponent(meta.id)}`);
  };

  const handleOpen = (id: string) => {
    window.location.assign(`/builder?project=${encodeURIComponent(id)}`);
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
    <main className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex w-full items-center justify-between border-b border-border-subtle px-6 py-4 sm:px-10 sm:py-5">
        <a href="/" className="flex items-center gap-3 link-inline">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/lgx-logo.svg"
            alt="lgx.guru"
            width={32}
            height={32}
            className="h-8 w-8 dark:invert"
          />
          <span className="text-ink-muted">/</span>
          <span className="eyebrow">Projects</span>
        </a>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <button onClick={handleNew} className="gradient-accent h-10 px-5 inline-flex items-center gap-2 rounded-[160px] text-sm font-medium text-white transition-opacity hover:opacity-90 cursor-pointer">
            <span className="text-[16px] leading-none" aria-hidden>+</span>
            New project
          </button>
        </div>
      </header>
      <div className="w-full px-6 py-12 sm:px-10 sm:py-16">
        <div className="mb-10 flex items-end justify-between gap-6">
          <h1 className="font-display max-w-[20ch] text-[clamp(1.75rem,4vw,2.5rem)] font-medium leading-[1.1] tracking-tight text-ink">
            Your projects.
          </h1>
          {hydrated && projects.length > 0 && (
            <p className="eyebrow shrink-0">
              {projects.length} {projects.length === 1 ? "project" : "projects"}
            </p>
          )}
        </div>

        {!hydrated ? (
          <div
            className="flex min-h-40 items-center justify-center"
            role="status"
            aria-label="Loading projects"
          >
            <svg
              className="h-6 w-6 animate-spin text-ink-muted"
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
        ) : projects.length === 0 ? (
          <div className="card-feature-lg text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-border-soft bg-canvas">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink" aria-hidden="true">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </div>
            <h2 className="text-[18px] font-medium leading-[1.2] text-ink">
              No projects yet
            </h2>
            <p className="mx-auto mt-2 max-w-[44ch] text-[14px] leading-normal text-ink-muted">
              Each project is a self-contained{" "}
              <span className="font-mono text-[12px] text-ink">.lgx</span> module —
              drag-and-drop UI plus optional AI-built backend logic.
            </p>
            <button onClick={handleNew} className="btn-primary mt-7">
              Create your first project
              <span aria-hidden>→</span>
            </button>
          </div>
        ) : (
          // Project cards. Each is a sage-on-canvas card with its name as a
          // display heading, an updated-meta eyebrow, and a watermarked
          // initial as a soft visual hook on the right. Open is the primary
          // affordance — the whole card is a button. Rename / Delete sit on
          // top as siblings (z-10) so clicks don't bubble to the card.
          <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id} className="group relative">
                <button
                  onClick={() => handleOpen(p.id)}
                  className="block w-full overflow-hidden rounded-card-lg bg-surface-warm p-7 text-left transition-all hover:bg-canvas hover:ring-1 hover:ring-border-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  aria-label={`Open ${p.name}`}
                >
                  <div className="flex min-h-30 flex-col">
                    <p className="eyebrow">
                      Updated {fmtUpdated(p.updatedAt, now)}
                    </p>
                    <h3 className="font-display mt-3 text-[22px] font-medium leading-[1.15] tracking-tight text-ink line-clamp-2">
                      {p.name}
                    </h3>
                  </div>
                  <div className="mt-6 flex items-center justify-between">
                    <span className="eyebrow text-ink-muted opacity-60">
                      Open
                    </span>
                    <span
                      aria-hidden
                      className="text-ink-muted transition-transform duration-200 group-hover:translate-x-1 group-hover:text-ink"
                    >
                      →
                    </span>
                  </div>
                </button>
                {/* Action buttons — siblings of the open-button so clicks
                    don't bubble. Hidden until row hover/focus to keep the
                    card visually clean. */}
                <div className="absolute right-4 top-4 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    onClick={() => handleRename(p)}
                    className="rounded-pill px-3 py-1.5 text-[11px] font-medium text-ink-muted hover:bg-canvas hover:text-ink transition-colors"
                    title="Rename"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => handleDelete(p)}
                    className="rounded-pill px-3 py-1.5 text-[11px] font-medium text-ink-muted hover:bg-danger-bg hover:text-danger transition-colors"
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

      </div>

      <footer className="mt-auto border-t border-border-subtle">
        <p className="px-6 py-6 text-center text-[11px] leading-normal text-ink-muted sm:px-10">
          Projects are stored in this browser. Use Export → Download project (.json)
          for a portable backup.
        </p>
      </footer>
    </main>
  );
}
