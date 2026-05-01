"use client";

import { useEffect, useState } from "react";
import { Sun, Moon, CircleHalf } from "@phosphor-icons/react";

type ThemePref = "light" | "dark" | "system";

export default function ThemeToggle({ className = "" }: { className?: string }) {
  const [themePref, setThemePref] = useState<ThemePref>("system");

  useEffect(() => {
    const stored = window.localStorage.getItem("lgx.theme") as ThemePref | null;
    if (stored === "light" || stored === "dark" || stored === "system") setThemePref(stored);
  }, []);

  useEffect(() => {
    const apply = () => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const dark = themePref === "dark" || (themePref === "system" && prefersDark);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    if (themePref === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [themePref]);

  const cycleTheme = () => {
    const next: ThemePref = themePref === "light" ? "dark" : themePref === "dark" ? "system" : "light";
    setThemePref(next);
    try { window.localStorage.setItem("lgx.theme", next); } catch {}
  };

  return (
    <button
      className={`flex h-7 w-7 items-center justify-center rounded-md border border-border-subtle bg-canvas text-ink-muted transition-colors hover:bg-surface-warm hover:border-border-soft hover:text-ink dark:text-ink-muted ${className}`}
      onClick={cycleTheme}
      title={`Theme: ${themePref} (click to cycle light \u2192 dark \u2192 system)`}
      aria-label="Cycle theme"
    >
      {themePref === "light" ? <Sun size={14} weight="duotone" /> : themePref === "dark" ? <Moon size={14} weight="duotone" /> : <CircleHalf size={14} weight="duotone" />}
    </button>
  );
}
