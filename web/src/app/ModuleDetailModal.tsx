"use client";

// Read-only "what's in this module" modal. Shown when the user clicks a row
// in the Modules sidebar tab. Aimed squarely at no-code users, so:
//   - methods are framed as "Things you can do"
//   - events are framed as "Things that can happen"
//   - parameter types use friendly labels (text / number / yes-no)
//   - the footer explains the exact editor steps to wire each up
//
// Accepts a normalized ModuleInfo so the same modal renders for primitives
// (delivery_module et al.) and the user's AI-built custom module.

import React from "react";

export interface ModuleParamView {
  name: string;
  type: string;
  description?: string;
}
export interface ModuleMethodView {
  name: string;
  args: ModuleParamView[];
  returns: string;
  description?: string;
}
export interface ModuleEventView {
  name: string;
  data: ModuleParamView[];
  description?: string;
}

export interface ModuleInfo {
  id: string;
  name: string;
  description?: string;
  available: boolean;            // false → coming-soon primitive
  variant: "logos" | "custom";   // controls the "how to use" copy
  methods: ModuleMethodView[];
  events: ModuleEventView[];
  comingSoonNote?: string;       // optional preview text for coming-soon modules
}

interface Props {
  info: ModuleInfo | null;
  onClose: () => void;
}

const friendlyType = (t: string): string => {
  switch (t) {
    case "string":  return "text";
    case "number":  return "number";
    case "boolean": return "yes / no";
    case "void":    return "(no result)";
    default:        return t;
  }
};

export function ModuleDetailModal({ info, onClose }: Props) {
  if (!info) return null;
  const { name, id, description, available, variant, methods, events, comingSoonNote } = info;
  const hasAny = methods.length > 0 || events.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/40 px-4 dark:bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-160 flex-col overflow-hidden rounded-lg border border-border-subtle bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-border-subtle px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-ink">
                {name}
              </div>
              {!available && (
                <span className="rounded bg-surface-cool px-1.5 py-0.5 text-[9px] font-medium text-ink-muted">
                  coming soon
                </span>
              )}
              {variant === "custom" && (
                <span className="rounded bg-success-bg px-1.5 py-0.5 text-[9px] font-medium text-success dark:bg-success-bg dark:text-success">
                  built by AI for this project
                </span>
              )}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-ink-muted">{id}</div>
            {description && (
              <p className="mt-1 text-[12px] text-ink-muted">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="-mr-1 rounded p-1 text-ink-muted hover:bg-surface-cool hover:text-ink-muted dark:hover:text-ink"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {!available && (
            <div className="mb-3 rounded border border-warning bg-warning-bg px-3 py-2 text-[11px] text-warning dark:border-warning dark:bg-warning-bg dark:text-warning">
              {comingSoonNote ?? "This module isn't installable yet. The list of capabilities will appear here once it ships."}
            </div>
          )}

          {hasAny ? (
            <>
              {methods.length > 0 && (
                <Section
                  title="Things you can do"
                  hint="Each method becomes a “Call module” option on any button you drop on the canvas."
                >
                  <ul className="space-y-2">
                    {methods.map((m) => (
                      <li
                        key={m.name}
                        className="rounded border border-border-subtle bg-canvas px-3 py-2"
                      >
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-[12px] font-semibold text-ink">
                            {m.name}
                          </span>
                          {m.returns !== "void" && (
                            <span className="rounded bg-surface-cool px-1.5 py-0.5 text-[10px] text-ink-muted">
                              gives back {friendlyType(m.returns)}
                            </span>
                          )}
                        </div>
                        {m.description && (
                          <p className="mt-1 text-[11px] leading-snug text-ink-muted">
                            {m.description}
                          </p>
                        )}
                        {m.args.length > 0 && (
                          <div className="mt-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                              You provide
                            </div>
                            <ul className="mt-1 space-y-0.5">
                              {m.args.map((a) => (
                                <li key={a.name} className="text-[11px] text-ink-muted">
                                  <span className="font-mono">{a.name}</span>
                                  <span className="text-ink-muted"> · {friendlyType(a.type)}</span>
                                  {a.description && (
                                    <span className="text-ink-muted"> — {a.description}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {events.length > 0 && (
                <Section
                  title="Things that can happen"
                  hint="Wire each event to a trigger in the Logic tab to react when it fires."
                >
                  <ul className="space-y-2">
                    {events.map((ev) => (
                      <li
                        key={ev.name}
                        className="rounded border border-border-subtle bg-canvas px-3 py-2"
                      >
                        <div className="font-mono text-[12px] font-semibold text-ink">
                          {ev.name}
                        </div>
                        {ev.description && (
                          <p className="mt-1 text-[11px] leading-snug text-ink-muted">
                            {ev.description}
                          </p>
                        )}
                        {ev.data.length > 0 && (
                          <div className="mt-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                              You receive
                            </div>
                            <ul className="mt-1 space-y-0.5">
                              {ev.data.map((d) => (
                                <li key={d.name} className="text-[11px] text-ink-muted">
                                  <span className="font-mono">{d.name}</span>
                                  <span className="text-ink-muted"> · {friendlyType(d.type)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="How to use this in your app">
                <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-snug text-ink-muted">
                  <li>
                    Drag a <span className="font-mono">Button</span> onto the canvas (Design tab → Components).
                  </li>
                  <li>
                    Select it, set the inspector&apos;s <span className="font-mono">When clicked</span> action to
                    <span className="font-mono"> Call module method</span>.
                  </li>
                  <li>
                    Pick <span className="font-mono">{name}</span>, then a method.
                  </li>
                  {events.length > 0 && (
                    <li>
                      For events, open the <span className="font-mono">Logic</span> tab → add a trigger →
                      <span className="font-mono"> When module event happens</span> → choose
                      <span className="font-mono"> {id}</span> + the event.
                    </li>
                  )}
                </ol>
              </Section>
            </>
          ) : (
            available && (
              <p className="text-[11px] text-ink-muted">
                This module currently exposes no methods or events.
              </p>
            )
          )}
        </div>

        <footer className="flex justify-end border-t border-border-subtle px-4 py-3">
          <button
            onClick={onClose}
            className="rounded bg-action px-3 py-1.5 text-xs font-medium text-action-on hover:opacity-90"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}

function Section({
  title, hint, children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h3>
      {hint && <p className="mt-0.5 text-[10px] text-ink-muted">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}
