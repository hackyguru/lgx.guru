"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Status overlay for the Qt-WASM renderer iframe. The renderer is a multi-MB
// WebAssembly bundle that needs cross-origin isolation (COOP/COEP) and a
// browser with SharedArrayBuffer. Without this overlay a slow first load
// looks like a frozen blank canvas, and an unsupported browser fails silently.

type Status =
  | { kind: "checking" }
  | { kind: "unsupported"; reasons: string[] }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

const LOAD_TIMEOUT_MS = 60_000;

function checkCapabilities(): { ok: true } | { ok: false; reasons: string[] } {
  // Only check what we can reliably check from the parent. The renderer runs
  // in an iframe that's typically a different origin with its own COOP/COEP
  // headers — `crossOriginIsolated` and `SharedArrayBuffer` on the parent
  // don't reflect what's available inside the iframe, so checking them here
  // produces false-positive failures on browsers where the iframe loads fine.
  // If the iframe genuinely can't start, the timeout/error states catch it.
  const reasons: string[] = [];
  if (typeof WebAssembly !== "object") {
    reasons.push("WebAssembly is not available in this browser.");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function useRendererStatus() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const [reloadKey, setReloadKey] = useState(0);
  const timeoutRef = useRef<number | null>(null);

  // Capability check runs once after mount so SSR output stays stable.
  useEffect(() => {
    const cap = checkCapabilities();
    if (!cap.ok) {
      setStatus({ kind: "unsupported", reasons: cap.reasons });
      return;
    }
    setStatus({ kind: "loading" });
  }, []);

  // Watchdog: if the iframe never fires `load`, surface a timeout so the user
  // sees a retry button instead of an indefinite spinner.
  useEffect(() => {
    if (status.kind !== "loading") return;
    timeoutRef.current = window.setTimeout(() => {
      setStatus({ kind: "timeout" });
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [status.kind, reloadKey]);

  const handleLoad = useCallback(() => {
    setStatus((p) => (p.kind === "loading" ? { kind: "ready" } : p));
  }, []);

  const handleError = useCallback(() => {
    setStatus((p) =>
      p.kind === "loading"
        ? { kind: "error", message: "The renderer iframe failed to load." }
        : p,
    );
  }, []);

  const retry = useCallback(() => {
    setStatus({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

  return { status, handleLoad, handleError, retry, reloadKey };
}

export function RendererStatus({
  status,
  url,
  onRetry,
}: {
  status: Status;
  url: string;
  onRetry: () => void;
}) {
  if (status.kind === "ready") return null;

  const wrap =
    "absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-zinc-50/95 dark:bg-zinc-900/95 px-6 text-center";

  if (status.kind === "checking") {
    return (
      <div className={wrap}>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">Checking browser support…</div>
      </div>
    );
  }

  if (status.kind === "unsupported") {
    return (
      <div className={wrap}>
        <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          Live preview unavailable
        </div>
        <ul className="max-w-md list-disc pl-4 text-left text-xs text-zinc-500 dark:text-zinc-400 marker:text-zinc-400">
          {status.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
          Try the latest Chrome, Firefox, or Safari.
        </div>
      </div>
    );
  }

  if (status.kind === "loading") {
    return (
      <div className={wrap}>
        <Spinner />
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          Loading renderer…
        </div>
        <div className="max-w-sm text-[11px] text-zinc-500 dark:text-zinc-400">
          Downloading the Qt-WASM runtime. The first visit pulls ~20 MB; later
          visits load from cache.
        </div>
      </div>
    );
  }

  if (status.kind === "timeout") {
    return (
      <div className={wrap}>
        <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
          Renderer is taking longer than expected
        </div>
        <div className="max-w-sm text-[11px] text-zinc-500 dark:text-zinc-400">
          The renderer didn&apos;t finish loading in 60 seconds. This can happen on
          slow connections or if the Qt-WASM build is unreachable.
        </div>
        <button
          onClick={onRetry}
          className="mt-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Reload renderer
        </button>
      </div>
    );
  }

  // error
  return (
    <div className={wrap}>
      <div className="text-sm font-semibold text-red-700 dark:text-red-300">
        Renderer failed to load
      </div>
      <div className="max-w-sm text-[11px] text-zinc-500 dark:text-zinc-400">
        {status.message}
      </div>
      <div className="max-w-sm break-all text-[10px] text-zinc-400 dark:text-zinc-500">
        {url}
      </div>
      <button
        onClick={onRetry}
        className="mt-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
      >
        Reload renderer
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 dark:border-t-blue-400" />
  );
}
