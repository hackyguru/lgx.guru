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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label={`${name} module details`}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-160 flex-col overflow-hidden rounded-card-lg border border-border-subtle bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-[18px] font-medium leading-[1.15] tracking-tight text-ink">
                {name}
              </h2>
              <span className="font-mono text-[11px] text-ink-muted">{id}</span>
              {!available && (
                <span className="rounded-pill bg-surface-cool px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                  coming soon
                </span>
              )}
              {variant === "custom" && (
                <span className="rounded-pill bg-success-bg px-2 py-0.5 text-[10px] font-medium text-success">
                  built by AI for this project
                </span>
              )}
            </div>
            {description && (
              <p className="mt-2 text-[12px] leading-snug text-ink-muted">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="-mt-1 -mr-1 shrink-0 rounded-pill px-2 py-1 text-[14px] leading-none text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {!available && (
            <div className="mb-4 rounded-card border border-warning bg-warning-bg px-4 py-3 text-[12px] leading-snug text-warning">
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
                        className="rounded-card border border-border-subtle bg-canvas px-4 py-3"
                      >
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-[12px] font-semibold text-ink">
                            {m.name}
                          </span>
                          {m.returns !== "void" && (
                            <span className="rounded-pill bg-surface-cool px-2 py-0.5 text-[10px] text-ink-muted">
                              gives back {friendlyType(m.returns)}
                            </span>
                          )}
                        </div>
                        {m.description && (
                          <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
                            {m.description}
                          </p>
                        )}
                        {m.args.length > 0 && (
                          <div className="mt-3">
                            <p className="eyebrow">You provide</p>
                            <ul className="mt-1.5 space-y-0.5">
                              {m.args.map((a) => (
                                <li key={a.name} className="text-[12px] text-ink-muted">
                                  <span className="font-mono">{a.name}</span>
                                  <span> · {friendlyType(a.type)}</span>
                                  {a.description && (
                                    <span> — {a.description}</span>
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
                        className="rounded-card border border-border-subtle bg-canvas px-4 py-3"
                      >
                        <div className="font-mono text-[12px] font-semibold text-ink">
                          {ev.name}
                        </div>
                        {ev.description && (
                          <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">
                            {ev.description}
                          </p>
                        )}
                        {ev.data.length > 0 && (
                          <div className="mt-3">
                            <p className="eyebrow">You receive</p>
                            <ul className="mt-1.5 space-y-0.5">
                              {ev.data.map((d) => (
                                <li key={d.name} className="text-[12px] text-ink-muted">
                                  <span className="font-mono">{d.name}</span>
                                  <span> · {friendlyType(d.type)}</span>
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
                <ol className="list-decimal space-y-1.5 pl-4 text-[12px] leading-snug text-ink-muted">
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
              <p className="text-[12px] text-ink-muted">
                This module currently exposes no methods or events.
              </p>
            )
          )}
        </div>

        <footer className="flex justify-end border-t border-border-subtle px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-pill bg-action px-5 py-1.5 text-[12px] font-medium text-action-on transition-opacity hover:opacity-90"
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
    <section className="mb-5">
      <p className="eyebrow">{title}</p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
