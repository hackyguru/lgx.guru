"use client";

// "Ask AI" — a chat-style panel that keeps a running history of all AI
// interactions. Each prompt + result is recorded so the user always knows
// what was asked and what changed. History is lifted to BuilderClient so
// it survives modal close/reopen.

import React, { useEffect, useRef, useState } from "react";
import type { AppState, CoreModuleSpec } from "./types";

type ResultKind = "patch" | "build";

interface PatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export interface AIHistoryEntry {
  id: number;
  prompt: string;
  timestamp: number;
  result:
    | {
        kind: "success";
        resultKind: ResultKind;
        summary: string;
        operations: PatchOp[];
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
}

interface Props {
  open: boolean;
  onClose: () => void;
  app: AppState;
  dispatch: (action: { type: "commit"; app: AppState }) => void;
  history: AIHistoryEntry[];
  onHistory: (h: AIHistoryEntry[]) => void;
}

let nextId = 1;

export function AskAIModal({ open, onClose, app, dispatch, history, onHistory }: Props) {
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState<{ prompt: string; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Elapsed timer for pending request
  useEffect(() => {
    if (!pending) return;
    const t0 = pending.startedAt;
    const id = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [pending]);

  // Auto-scroll to bottom when history changes or pending changes
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, pending]);

  const close = () => {
    if (pending) return;
    onClose();
  };

  // Escape closes the panel. Without a backdrop to click on, this is the
  // keyboard-only escape hatch.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // close is stable enough — re-evaluating only on open/pending toggle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  const ask = async () => {
    const trimmed = prompt.trim();
    if (trimmed.length < 3 || pending) return;
    const promptText = trimmed;
    setPrompt("");
    setElapsed(0);
    setPending({ prompt: promptText, startedAt: Date.now() });

    try {
      const res = await fetch("/api/apply-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptText, app }),
      });
      const data = await res.json();
      const resultKind: ResultKind = data?.kind === "build" ? "build" : "patch";

      if (!res.ok || !data?.ok || !data?.app) {
        const entry: AIHistoryEntry = {
          id: nextId++,
          prompt: promptText,
          timestamp: Date.now(),
          result: {
            kind: "error",
            message: data?.error ?? `HTTP ${res.status}`,
            resultKind,
            operations: Array.isArray(data?.operations) ? (data.operations as PatchOp[]) : undefined,
            errors: Array.isArray(data?.errors) ? (data.errors as string[]) : undefined,
            attempts: typeof data?.attempts === "number" ? data.attempts : undefined,
          },
        };
        onHistory([...history, entry]);
      } else {
        dispatch({ type: "commit", app: data.app as AppState });
        const entry: AIHistoryEntry = {
          id: nextId++,
          prompt: promptText,
          timestamp: Date.now(),
          result: {
            kind: "success",
            resultKind,
            summary: typeof data.summary === "string" ? data.summary : "Done.",
            operations: Array.isArray(data.operations) ? (data.operations as PatchOp[]) : [],
            spec: data.spec as CoreModuleSpec | undefined,
            attempts: typeof data.attempts === "number" ? data.attempts : undefined,
            durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
          },
        };
        onHistory([...history, entry]);
      }
    } catch (err) {
      const entry: AIHistoryEntry = {
        id: nextId++,
        prompt: promptText,
        timestamp: Date.now(),
        result: { kind: "error", message: err instanceof Error ? err.message : "Network error" },
      };
      onHistory([...history, entry]);
    } finally {
      setPending(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  if (!open) return null;

  const isEmpty = history.length === 0 && !pending;

  const examples = [
    "Show the London time in the title",
    "Center the Hello World label and make the page background yellow",
    "Add a Send button that publishes the input field's contents to /chat/1/lobby/text",
    "When the Send button is clicked, increment the message count variable",
    "Make this label show the count variable instead of static text",
  ];

  return (
    // Right-edge slide-over panel. No backdrop — the canvas + inspector
    // stay visible and interactive while the user iterates with AI. Closes
    // via the X button or Escape key (see effect above).
    <aside
      role="dialog"
      aria-label="Ask AI"
      className="fixed inset-y-0 right-0 z-50 flex w-[min(420px,92vw)] flex-col overflow-hidden border-l border-border-subtle bg-canvas shadow-2xl"
    >
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div className="min-w-0 flex-1">
            {/* Vibecode wordmark in place of "Ask AI" text. dark:invert
                mirrors the lgx-logo treatment so the wordmark flips
                cleanly between light and dark modes. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/vibecode.svg"
              alt="Vibecode"
              className="h-5 dark:invert"
            />
          </div>
          <div className="flex items-center gap-1.5">
            {history.length > 0 && (
              <button
                onClick={() => onHistory([])}
                disabled={!!pending}
                className="rounded-pill px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink disabled:opacity-30"
                title="Clear history"
              >
                Clear
              </button>
            )}
            <button
              onClick={close}
              disabled={!!pending}
              className="-mr-1 rounded-pill px-2 py-1 text-[14px] leading-none text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink disabled:opacity-30"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        {/* Scrollable conversation area — flex-1 fills the full panel
            height between header and footer. */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
          {/* Empty state with examples */}
          {isEmpty && (
            <div className="space-y-4">
              <div className="py-4 text-center text-[12px] leading-snug text-ink-muted">
                No changes yet. Ask AI to modify your app.
              </div>
              <div>
                <p className="eyebrow">Examples</p>
                <ul className="mt-2 space-y-1.5">
                  {examples.map((ex) => (
                    <li key={ex}>
                      <button
                        onClick={() => setPrompt(ex)}
                        className="w-full rounded-control border border-border-subtle bg-canvas px-3 py-2 text-left text-[12px] leading-snug text-ink-muted transition-colors hover:border-border-soft hover:bg-surface-warm hover:text-ink"
                      >
                        {ex}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* History entries */}
          {history.map((entry, i) => (
            <div key={entry.id} className={i > 0 ? "mt-4" : ""}>
              {/* User prompt */}
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent/10 px-3 py-2 dark:bg-accent/20">
                  <div className="text-[11px] leading-snug text-ink">{entry.prompt}</div>
                  <div className="mt-0.5 text-right text-[9px] text-ink-muted">
                    {fmtTime(entry.timestamp)}
                  </div>
                </div>
              </div>

              {/* AI response */}
              <div className="mt-1.5 flex justify-start">
                <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-border-subtle bg-surface-warm px-3 py-2">
                  {entry.result.kind === "success" ? (
                    <SuccessResult result={entry.result} />
                  ) : (
                    <ErrorResult result={entry.result} />
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Pending request */}
          {pending && (
            <div className={history.length > 0 ? "mt-4" : ""}>
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent/10 px-3 py-2 dark:bg-accent/20">
                  <div className="text-[11px] leading-snug text-ink">{pending.prompt}</div>
                </div>
              </div>
              <div className="mt-1.5 flex justify-start">
                <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-border-subtle bg-surface-warm px-3 py-2">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                      <span className="text-[11px] text-ink-muted">
                        Working... {fmt(elapsed)}
                      </span>
                    </div>
                    {elapsed >= 10 && (
                      <div className="text-[10px] leading-snug text-warning">
                        Backend module build in progress — first compile can take several minutes.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input area — always visible at bottom */}
        <footer className="border-t border-border-subtle px-4 py-3">
          <div className="flex gap-2">
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
              rows={2}
              placeholder={pending ? "Waiting for response..." : "What should change?"}
              disabled={!!pending}
              className="flex-1 resize-none rounded-control border border-border-soft bg-canvas px-3 py-2 text-[12px] text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={ask}
              disabled={prompt.trim().length < 3 || !!pending}
              className="rounded-pill gradient-accent px-4 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {pending ? "..." : "Send"}
            </button>
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            {pending ? "Cmd-Z reverts applied changes." : "Cmd/Ctrl+Enter to send. Esc closes."}
          </div>
        </footer>
    </aside>
  );
}

// ── Sub-components for history entries ─────────────────────────────────────

function SuccessResult({ result }: {
  result: Extract<AIHistoryEntry["result"], { kind: "success" }>;
}) {
  const uiOps = result.operations.filter((o) => !o.path.startsWith("/coreModule"));
  const uiCount = uiOps.length;
  const secondary = result.resultKind === "build"
    ? uiCount === 0
      ? "Module compiled and added."
      : `Module compiled + ${uiCount} UI change${uiCount === 1 ? "" : "s"}.`
    : `${result.operations.length} change${result.operations.length === 1 ? "" : "s"} applied.`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-1.5">
        <span className="mt-px text-[11px] text-success">+</span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium leading-snug text-ink">{result.summary}</div>
          <div className="text-[10px] text-ink-muted">{secondary}</div>
        </div>
      </div>

      {result.resultKind === "build" && result.spec && result.spec.methods.length > 0 && (
        <details className="rounded border border-border-subtle">
          <summary className="cursor-pointer px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            Methods
          </summary>
          <ul className="border-t border-border-subtle px-2 py-1.5 space-y-1">
            {result.spec.methods.map((m) => (
              <li key={m.name} className="font-mono text-[10px] text-ink">
                {m.name}({m.args.map((a) => `${a.name}: ${a.type}`).join(", ")})
                <span className="text-ink-muted"> -&gt; {m.returns}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.operations.length > 0 && (
        <details className="rounded border border-border-subtle">
          <summary className="cursor-pointer px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            Changes ({result.operations.length})
          </summary>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all border-t border-border-subtle px-2 py-1.5 text-[9px] text-ink-muted">
            {result.operations.map((o) =>
              `${o.op.padEnd(8)} ${o.path}${o.op !== "remove" ? ` = ${shortValue(o.value)}` : ""}`
            ).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

function ErrorResult({ result }: {
  result: Extract<AIHistoryEntry["result"], { kind: "error" }>;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-1.5">
        <span className="mt-px text-[11px] text-danger">x</span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium leading-snug text-ink">
            {result.resultKind === "build"
              ? `Build failed${result.attempts ? ` (${result.attempts} attempt${result.attempts === 1 ? "" : "s"})` : ""}`
              : "Couldn't apply"}
          </div>
          <div className="mt-0.5 text-[10px] leading-snug text-danger">{result.message}</div>
        </div>
      </div>

      {result.errors && result.errors.length > 0 && (
        <details className="rounded border border-danger/30">
          <summary className="cursor-pointer px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-danger">
            Compiler errors
          </summary>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap border-t border-danger/30 bg-danger-bg px-2 py-1.5 text-[9px] leading-snug text-danger">
            {result.errors.join("\n\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortValue(v: unknown): string {
  if (v === undefined) return "(no value)";
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + "..." : s;
}
