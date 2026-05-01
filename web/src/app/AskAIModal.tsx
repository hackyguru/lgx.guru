"use client";

// "Ask AI" — a focused modal that turns a natural-language request into a
// JSON Patch against AppState and applies it as one undo step. Sibling to
// BuildModuleModal: this one mutates the visual layer + wiring, that one
// generates C++ backend modules.

import React, { useEffect, useRef, useState } from "react";
import type { AppState, CoreModuleSpec } from "./types";

type ResultKind = "patch" | "build";

type Stage =
  | { kind: "idle" }
  | { kind: "asking"; startedAt: number }
  | {
      kind: "success";
      resultKind: ResultKind;
      summary: string;
      operations: PatchOp[];
      // Build-only details:
      spec?: CoreModuleSpec;
      attempts?: number;
      durationMs?: number;
    }
  | {
      kind: "error";
      message: string;
      resultKind?: ResultKind;
      operations?: PatchOp[];
      errors?: string[];
      attempts?: number;
    };

interface PatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

interface Props {
  open: boolean;
  onClose: () => void;
  app: AppState;
  dispatch: (action: { type: "commit"; app: AppState }) => void;
}

export function AskAIModal({ open, onClose, app, dispatch }: Props) {
  const [prompt, setPrompt] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  useEffect(() => {
    if (stage.kind !== "asking") return;
    const startedAt = stage.startedAt;
    const id = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [stage]);

  const close = () => {
    if (stage.kind === "asking") return;
    setStage({ kind: "idle" });
    onClose();
  };

  const ask = async () => {
    const trimmed = prompt.trim();
    if (trimmed.length < 3 || stage.kind === "asking") return;
    setElapsed(0);
    setStage({ kind: "asking", startedAt: Date.now() });
    try {
      const res = await fetch("/api/apply-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmed, app }),
      });
      const data = await res.json();
      const resultKind: ResultKind = data?.kind === "build" ? "build" : "patch";
      if (!res.ok || !data?.ok || !data?.app) {
        setStage({
          kind: "error",
          message: data?.error ?? `HTTP ${res.status}`,
          resultKind,
          operations: Array.isArray(data?.operations) ? (data.operations as PatchOp[]) : undefined,
          errors: Array.isArray(data?.errors) ? (data.errors as string[]) : undefined,
          attempts: typeof data?.attempts === "number" ? data.attempts : undefined,
        });
        return;
      }
      // Commit lands as one history entry — Cmd-Z reverts the whole change
      // (including builds that replaced /coreModule).
      dispatch({ type: "commit", app: data.app as AppState });
      setStage({
        kind: "success",
        resultKind,
        summary: typeof data.summary === "string" ? data.summary : "Done.",
        operations: Array.isArray(data.operations) ? (data.operations as PatchOp[]) : [],
        spec: data.spec as CoreModuleSpec | undefined,
        attempts: typeof data.attempts === "number" ? data.attempts : undefined,
        durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
      });
    } catch (err) {
      setStage({ kind: "error", message: err instanceof Error ? err.message : "Network error" });
    }
  };

  const newRequest = () => {
    setPrompt("");
    setStage({ kind: "idle" });
    inputRef.current?.focus();
  };

  if (!open) return null;

  const examples = [
    "Show the London time in the title",
    "Center the Hello World label and make the page background yellow",
    "Add a Send button that publishes the input field's contents to /chat/1/lobby/text",
    "When the Send button is clicked, increment the message count variable",
    "Make this label show the count variable instead of static text",
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/40 px-4 dark:bg-black/60"
      onClick={close}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-160 flex-col overflow-hidden rounded-lg border border-border-subtle bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-ink">Ask AI</div>
            <div className="text-[11px] text-ink-muted">
              {stage.kind === "success"
                ? "Applied. Cmd-Z reverts everything."
                : "Describe the change. AI wires it up — variables, triggers, bindings, all of it."}
            </div>
          </div>
          <button
            onClick={close}
            disabled={stage.kind === "asking"}
            className="-mr-1 rounded p-1 text-ink-muted hover:bg-surface-cool hover:text-ink-muted disabled:opacity-30 dark:hover:text-ink"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {stage.kind === "idle" && (
            <div className="space-y-3">
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    ask();
                  }
                }}
                rows={4}
                placeholder="What should change?"
                className="w-full resize-none rounded border border-border-soft bg-canvas px-3 py-2 text-[12px] text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none dark:placeholder:text-ink-muted"
              />
              <div className="text-[10px] text-ink-muted">
                ⌘/Ctrl+Enter to send.
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  Examples
                </div>
                <ul className="mt-1 space-y-1">
                  {examples.map((ex) => (
                    <li key={ex}>
                      <button
                        onClick={() => setPrompt(ex)}
                        className="w-full rounded border border-border-subtle px-2 py-1.5 text-left text-[11px] leading-snug text-ink-muted hover:border-border-soft hover:bg-surface-warm dark:hover:border-border-soft"
                      >
                        {ex}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {stage.kind === "asking" && (
            <div className="space-y-3 py-2">
              <div className="space-y-2.5">
                <div className="h-3 w-4/5 animate-pulse rounded-full bg-border-subtle" />
                <div className="h-3 w-3/5 animate-pulse rounded-full bg-border-subtle" />
                <div className="h-3 w-2/5 animate-pulse rounded-full bg-border-subtle" />
                <div className="mt-1 text-[11px] text-ink-muted">
                  Working out the change... {fmt(elapsed)}
                </div>
              </div>
              {/* After ~10s the request is probably a backend build (nix
                  download + compile dominates). Surface that so users
                  don't think the spinner is stuck. */}
              {elapsed >= 10 && (
                <div className="rounded border border-warning bg-warning-bg px-3 py-2 text-[11px] leading-snug text-warning dark:border-warning dark:bg-warning-bg dark:text-warning">
                  Looks like a backend module build — first compile of a fresh module can take several minutes while the Logos SDK downloads. Subsequent builds are much faster.
                </div>
              )}
              <div className="rounded border border-border-subtle bg-surface-warm px-3 py-2 text-[11px] text-ink-muted">
                <span className="font-mono text-ink-muted">»</span> {prompt}
              </div>
            </div>
          )}

          {stage.kind === "success" && (() => {
            // For multi-step (build + wire) responses, count UI ops separately
            // from the /coreModule replace so the secondary line reads naturally.
            const uiOps = stage.operations.filter((o) => !o.path.startsWith("/coreModule"));
            const uiCount = uiOps.length;
            const secondary = stage.resultKind === "build"
              ? uiCount === 0
                ? "Module compiled and added to your project."
                : `Module compiled, plus ${uiCount} UI change${uiCount === 1 ? "" : "s"} applied.`
              : `${stage.operations.length} change${stage.operations.length === 1 ? "" : "s"} applied`;
            return (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 text-success dark:text-success">✓</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-ink">
                    {stage.summary}
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    {secondary}
                  </div>
                </div>
              </div>

              {stage.resultKind === "build" && stage.spec && (
                <div className="space-y-2">
                  {stage.spec.methods.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                        Methods
                      </div>
                      <ul className="mt-1 space-y-1">
                        {stage.spec.methods.map((m) => (
                          <li key={m.name} className="rounded border border-border-subtle px-2 py-1.5">
                            <div className="font-mono text-[11px] text-ink">
                              {m.name}({m.args.map((a) => `${a.name}: ${a.type}`).join(", ")}){" "}
                              <span className="text-ink-muted">→ {m.returns}</span>
                            </div>
                            {m.description && (
                              <div className="mt-0.5 text-[10px] text-ink-muted">{m.description}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(stage.spec.events ?? []).length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                        Events
                      </div>
                      <ul className="mt-1 space-y-1">
                        {(stage.spec.events ?? []).map((ev) => (
                          <li key={ev.name} className="rounded border border-border-subtle px-2 py-1.5">
                            <div className="font-mono text-[11px] text-ink">
                              {ev.name} {`{ ${ev.data.map((d) => `${d.name}: ${d.type}`).join(", ")} }`}
                            </div>
                            {ev.description && (
                              <div className="mt-0.5 text-[10px] text-ink-muted">{ev.description}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {stage.operations.length > 0 && (
                <details className="rounded border border-border-subtle">
                  <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                    What changed (advanced)
                  </summary>
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-border-subtle bg-surface-warm px-3 py-2 text-[10px] text-ink-muted">
                    {stage.operations.map((o) =>
                      `${o.op.padEnd(8)} ${o.path}${o.op !== "remove" ? ` = ${shortValue(o.value)}` : ""}`
                    ).join("\n")}
                  </pre>
                </details>
              )}
            </div>
            );
          })()}

          {stage.kind === "error" && (
            <div className="space-y-2">
              <div className="text-[12px] font-medium text-ink">
                {stage.resultKind === "build"
                  ? `Build failed${stage.attempts ? ` after ${stage.attempts} attempt${stage.attempts === 1 ? "" : "s"}` : ""}`
                  : "Couldn't apply"}
              </div>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-danger bg-danger-bg px-3 py-2 text-[11px] text-danger">
                {stage.message}
              </pre>
              {stage.errors && stage.errors.length > 0 && (
                <details className="rounded border border-border-subtle">
                  <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                    Compiler errors (last attempt)
                  </summary>
                  <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-danger bg-danger-bg px-3 py-2 text-[10px] leading-snug text-danger">
                    {stage.errors.join("\n\n")}
                  </pre>
                </details>
              )}
              {stage.operations && stage.operations.length > 0 && (
                <details className="rounded border border-border-subtle">
                  <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                    Patch the AI tried (advanced)
                  </summary>
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-border-subtle bg-surface-warm px-3 py-2 text-[10px] text-ink-muted">
                    {stage.operations.map((o) =>
                      `${o.op.padEnd(8)} ${o.path}${o.op !== "remove" ? ` = ${shortValue(o.value)}` : ""}`
                    ).join("\n")}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
          {stage.kind === "idle" && (
            <>
              <button
                onClick={close}
                className="rounded border border-border-soft px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-cool"
              >
                Cancel
              </button>
              <button
                onClick={ask}
                disabled={prompt.trim().length < 3}
                className="rounded gradient-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                Send
              </button>
            </>
          )}
          {stage.kind === "asking" && (
            <div className="flex items-center gap-2">
              <div className="h-3 w-16 animate-pulse rounded-full bg-border-subtle" />
            </div>
          )}
          {stage.kind === "success" && (
            <>
              <button
                onClick={close}
                className="rounded border border-border-soft px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-cool"
              >
                Done
              </button>
              <button
                onClick={newRequest}
                className="rounded gradient-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                Ask another
              </button>
            </>
          )}
          {stage.kind === "error" && (
            <>
              <button
                onClick={close}
                className="rounded border border-border-soft px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-cool"
              >
                Cancel
              </button>
              <button
                onClick={() => setStage({ kind: "idle" })}
                className="rounded bg-action px-3 py-1.5 text-xs font-medium text-action-on hover:opacity-90"
              >
                Try again
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function shortValue(v: unknown): string {
  if (v === undefined) return "(no value)";
  const s = JSON.stringify(v);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

