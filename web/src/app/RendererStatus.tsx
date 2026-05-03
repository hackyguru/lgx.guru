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

// Bumped to 60s now that Qt-WASM boot timing varies + auto-retry is off.
// The renderer-ready handshake (iframe → parent) is the canonical signal
// that booting succeeded; iframe.onLoad has been unreliable in practice
// (sometimes never fires on first cold-cache load even though Qt-WASM
// finished). We still surface a manual retry button if we time out.
const LOAD_TIMEOUT_MS = 60_000;
// Auto-retry was masking real bugs by remounting the iframe every 15s,
// which discarded any QML the editor had successfully loaded. The proper
// handshake makes auto-retry unnecessary; user can hit the manual retry
// button if the renderer genuinely fails.
const MAX_AUTO_RETRIES = 0;

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
  // Tracks how many silent reloads we've done since the last successful
  // load. Resets to 0 on `ready` and on a manual user retry click.
  const autoRetryCountRef = useRef(0);

  // Capability check runs once after mount so SSR output stays stable.
  useEffect(() => {
    const cap = checkCapabilities();
    if (!cap.ok) {
      setStatus({ kind: "unsupported", reasons: cap.reasons });
      return;
    }
    setStatus({ kind: "loading" });
  }, []);

  // Watchdog: if the iframe never fires `load` within LOAD_TIMEOUT_MS, do
  // a silent reload (up to MAX_AUTO_RETRIES). After that, surface the
  // timeout state so the user gets an explicit retry button.
  useEffect(() => {
    if (status.kind !== "loading") return;
    timeoutRef.current = window.setTimeout(() => {
      if (autoRetryCountRef.current < MAX_AUTO_RETRIES) {
        autoRetryCountRef.current += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `[lgx] renderer didn't load in ${LOAD_TIMEOUT_MS}ms — silent retry ${autoRetryCountRef.current}/${MAX_AUTO_RETRIES}.`,
        );
        // Bumping the reloadKey forces the iframe's src to change, which
        // remounts it from scratch — clears any half-booted Qt-WASM state.
        setReloadKey((k) => k + 1);
        // Stay in "loading" state and re-arm the watchdog by toggling
        // status briefly so the effect re-runs. Easiest way: dispatch a
        // status with a new identity.
        setStatus({ kind: "loading" });
      } else {
        setStatus({ kind: "timeout" });
      }
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [status.kind, reloadKey]);

  const handleLoad = useCallback(() => {
    autoRetryCountRef.current = 0;
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
    autoRetryCountRef.current = 0;
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
    "absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface-warm/95 px-6 text-center";

  if (status.kind === "checking") {
    return (
      <div className={wrap}>
        <div className="text-xs text-ink-muted">Checking browser support…</div>
      </div>
    );
  }

  if (status.kind === "unsupported") {
    return (
      <div className={wrap}>
        <div className="font-display text-[18px] font-medium tracking-tight text-ink">
          Live preview unavailable
        </div>
        <ul className="max-w-md list-disc pl-4 text-left text-xs text-ink-muted marker:text-ink-muted">
          {status.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <div className="text-[11px] text-ink-muted">
          Try the latest Chrome, Firefox, or Safari.
        </div>
      </div>
    );
  }

  if (status.kind === "loading") {
    return (
      <div className={wrap}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/lgx-logo.svg"
          alt=""
          width={48}
          height={48}
          className="h-12 w-12 animate-pulse dark:invert"
        />
      </div>
    );
  }

  if (status.kind === "timeout") {
    return (
      <div className={wrap}>
        <div className="font-display text-[18px] font-medium tracking-tight text-warning">
          Renderer is taking longer than expected
        </div>
        <div className="max-w-sm text-[12px] leading-snug text-ink-muted">
          The renderer didn&apos;t finish loading in 60 seconds. This can happen on
          slow connections or if the Qt-WASM build is unreachable.
        </div>
        <button
          onClick={onRetry}
          className="mt-1 rounded-pill border border-border-soft bg-canvas px-3 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
        >
          Reload renderer
        </button>
      </div>
    );
  }

  // error
  return (
    <div className={wrap}>
      <div className="font-display text-[18px] font-medium tracking-tight text-danger">
        Renderer failed to load
      </div>
      <div className="max-w-sm text-[12px] leading-snug text-ink-muted">
        {status.message}
      </div>
      <div className="max-w-sm break-all font-mono text-[10px] text-ink-muted">
        {url}
      </div>
      <button
        onClick={onRetry}
        className="mt-1 rounded-pill border border-border-soft bg-canvas px-3 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-warm hover:text-ink"
      >
        Reload renderer
      </button>
    </div>
  );
}

