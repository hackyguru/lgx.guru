import Head from "next/head";
import Link from "next/link";
import dynamic from "next/dynamic";
import ThemeToggle from "@/app/ThemeToggle";
import { CursorClick, Brain, Package } from "@phosphor-icons/react";

const HeroLogo = dynamic(() => import("@/app/HeroLogo"), { ssr: false });

const FEATURES = [
  {
    title: "Drag, drop, ship",
    icon: CursorClick,
    body:
      "Pages, frames, lists, navigation, state, triggers — composed in a spatial editor. Live Qt-WASM preview matches Basecamp pixel-for-pixel.",
  },
  {
    title: "AI wires the logic",
    icon: Brain,
    body:
      "Describe behavior in plain English. AI generates C++ for any custom backend, compiles it, wires up triggers, and patches the canvas.",
  },
  {
    title: "Cross-platform export",
    icon: Package,
    body:
      "Installable .lgx packages built for macOS and Linux in parallel via GitHub Actions — or compile locally with Nix.",
  },
] as const;

const HomePage = () => {
  return (
    <>
      <Head>
        <title>LGX Guru</title>
        <meta
          name="description"
          content="Build Logos Basecamp modules without writing code. Drag-and-drop editor, AI-wired logic, live Qt-WASM preview, cross-platform .lgx export."
        />
        <meta name="application-name" content="lgx.guru" />
        <meta name="author" content="Logos" />
        <meta
          name="keywords"
          content="Logos Basecamp, lgx, .lgx module, QML builder, Qt visual editor, no-code Basecamp, AI UI builder, QML WASM"
        />
        <meta name="robots" content="index, follow" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d0d0e" />
        <link rel="canonical" href="https://lgx.guru/" />

        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="shortcut icon" href="/favicon-32.png" />

        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="lgx.guru" />
        <meta property="og:locale" content="en_US" />
        <meta property="og:url" content="https://lgx.guru/" />
        <meta property="og:title" content="lgx.guru — visual builder for Logos Basecamp" />
        <meta
          property="og:description"
          content="Build Logos Basecamp modules without writing code. Drag-and-drop editor, AI-wired logic, live Qt-WASM preview, cross-platform .lgx export."
        />
        <meta property="og:image" content="https://lgx.guru/lgx-og.png" />
        <meta property="og:image:width" content="640" />
        <meta property="og:image:height" content="336" />
        <meta
          property="og:image:alt"
          content="lgx.guru — build Basecamp modules without writing code."
        />

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="lgx.guru — visual builder for Logos Basecamp" />
        <meta
          name="twitter:description"
          content="Drag, drop, ship. AI-wired logic, Qt-WASM preview, cross-platform .lgx export."
        />
        <meta name="twitter:image" content="https://lgx.guru/lgx-og.png" />
      </Head>

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-canvas focus:outline-none"
      >
        Skip to content
      </a>

      <main id="main-content" className="relative flex min-h-screen flex-col bg-canvas text-ink">
        {/* Navbar */}
        <header className="sticky top-0 z-30 flex w-full items-center justify-between border-b border-border-subtle bg-canvas/85 px-6 py-4 backdrop-blur sm:px-10 sm:py-5">
          <div className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/lgx-logo.svg"
              alt="lgx.guru"
              width={32}
              height={32}
              className="h-8 w-8 dark:invert"
            />
          </div>
          <nav aria-label="Primary" className="flex items-center gap-2">
            <a
              href="https://github.com/logos-co/logos-basecamp"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex h-10 items-center rounded-pill px-4 text-sm font-medium text-ink hover:bg-surface-warm transition-colors"
            >
              About Basecamp
            </a>
            <ThemeToggle />
            <Link
              href="/dashboard"
              className="btn-primary h-10! px-5!"
              aria-label="Open editor"
            >
              Open editor
              <span aria-hidden>→</span>
            </Link>
          </nav>
        </header>

        {/* Centred logo + features — fills the remaining viewport */}
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 sm:px-10">
          <HeroLogo />

          <div className="mt-12 grid w-full max-w-6xl gap-6 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="card-feature text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full gradient-accent">
                  <f.icon size={20} weight="bold" className="text-white" />
                </div>
                <h3 className="text-[17px] font-medium leading-[1.2] text-ink">
                  {f.title}
                </h3>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </>
  );
};

export default HomePage;
