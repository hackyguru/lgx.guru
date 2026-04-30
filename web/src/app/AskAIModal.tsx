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
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 px-4 dark:bg-black/60"
      onClick={close}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-160 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <div>
            <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Ask AI</div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {stage.kind === "success"
                ? "Applied. Cmd-Z reverts everything."
                : "Describe the change. AI wires it up — variables, triggers, bindings, all of it."}
            </div>
          </div>
          <button
            onClick={close}
            disabled={stage.kind === "asking"}
            className="-mr-1 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
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
                className="w-full resize-none rounded border border-zinc-300 bg-white px-3 py-2 text-[12px] text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
              <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                ⌘/Ctrl+Enter to send.
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Examples
                </div>
                <ul className="mt-1 space-y-1">
                  {examples.map((ex) => (
                    <li key={ex}>
                      <button
                        onClick={() => setPrompt(ex)}
                        className="w-full rounded border border-zinc-200 px-2 py-1.5 text-left text-[11px] leading-snug text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
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
              <div className="flex items-center gap-3">
                <Spinner />
                <div>
                  <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-100">
                    Working out the change…
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Elapsed: {fmt(elapsed)}
                  </div>
                </div>
              </div>
              {/* After ~10s the request is probably a backend build (nix
                  download + compile dominates). Surface that so users
                  don't think the spinner is stuck. */}
              {elapsed >= 10 && (
                <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                  Looks like a backend module build — first compile of a fresh module can take several minutes while the Logos SDK downloads. Subsequent builds are much faster.
                </div>
              )}
              <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <span className="font-mono text-zinc-400 dark:text-zinc-500">»</span> {prompt}
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
                <span className="mt-0.5 text-emerald-600 dark:text-emerald-400">✓</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-100">
                    {stage.summary}
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {secondary}
                  </div>
                </div>
              </div>

              {stage.resultKind === "build" && stage.spec && (
                <div className="space-y-2">
                  {stage.spec.methods.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Methods
                      </div>
                      <ul className="mt-1 space-y-1">
                        {stage.spec.methods.map((m) => (
                          <li key={m.name} className="rounded border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">
                            <div className="font-mono text-[11px] text-zinc-800 dark:text-zinc-100">
                              {m.name}({m.args.map((a) => `${a.name}: ${a.type}`).join(", ")}){" "}
                              <span className="text-zinc-400 dark:text-zinc-500">→ {m.returns}</span>
                            </div>
                            {m.description && (
                              <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">{m.description}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(stage.spec.events ?? []).length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Events
                      </div>
                      <ul className="mt-1 space-y-1">
                        {(stage.spec.events ?? []).map((ev) => (
                          <li key={ev.name} className="rounded border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">
                            <div className="font-mono text-[11px] text-zinc-800 dark:text-zinc-100">
                              {ev.name} {`{ ${ev.data.map((d) => `${d.name}: ${d.type}`).join(", ")} }`}
                            </div>
                            {ev.description && (
                              <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">{ev.description}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {stage.operations.length > 0 && (
                <details className="rounded border border-zinc-200 dark:border-zinc-700">
                  <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    What changed (advanced)
                  </summary>
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-[10px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
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
              <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-100">
                {stage.resultKind === "build"
                  ? `Build failed${stage.attempts ? ` after ${stage.attempts} attempt${stage.attempts === 1 ? "" : "s"}` : ""}`
                  : "Couldn't apply"}
              </div>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-red-300 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
                {stage.message}
              </pre>
              {stage.errors && stage.errors.length > 0 && (
                <details className="rounded border border-zinc-200 dark:border-zinc-700">
                  <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Compiler errors (last attempt)
                  </summary>
                  <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-snug text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">
                    {stage.errors.join("\n\n")}
                  </pre>
                </details>
              )}
              {stage.operations && stage.operations.length > 0 && (
                <details className="rounded border border-zinc-200 dark:border-zinc-700">
                  <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Patch the AI tried (advanced)
                  </summary>
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-[10px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                    {stage.operations.map((o) =>
                      `${o.op.padEnd(8)} ${o.path}${o.op !== "remove" ? ` = ${shortValue(o.value)}` : ""}`
                    ).join("\n")}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
          {stage.kind === "idle" && (
            <>
              <button
                onClick={close}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={ask}
                disabled={prompt.trim().length < 3}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
              >
                Send
              </button>
            </>
          )}
          {stage.kind === "asking" && (
            <button disabled className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
              Working…
            </button>
          )}
          {stage.kind === "success" && (
            <>
              <button
                onClick={close}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Done
              </button>
              <button
                onClick={newRequest}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                Ask another
              </button>
            </>
          )}
          {stage.kind === "error" && (
            <>
              <button
                onClick={close}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => setStage({ kind: "idle" })}
                className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
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

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700 dark:border-zinc-600 dark:border-t-zinc-200" />
  );
}
