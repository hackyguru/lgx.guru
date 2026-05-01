import Head from "next/head";
import Link from "next/link";

const FEATURES = [
  {
    title: "Compose in the browser",
    body: "Frames, controls, and layout behave like the QML you ship — drag, resize, and refine without leaving the tab.",
  },
  {
    title: "See it running",
    body: "Qt-WASM mirrors Basecamp so you debug visuals and interactions against the same runtime users get.",
  },
  {
    title: "Export with confidence",
    body: "Bundle installable .lgx packages from your project storage — iterate locally, hand off cleanly.",
  },
] as const;

const HomePage = () => {
  return (
    <>
      <Head>
        <title>lgx.guru — LGX Builder</title>
        <meta
          name="description"
          content="Visual builder for Logos Basecamp UI modules — design QML widgets in the browser, export installable .lgx packages."
        />
      </Head>

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:text-background focus:outline-none focus:ring-2 focus:ring-zinc-400"
      >
        Skip to content
      </a>

      <div className="relative flex min-h-screen flex-col overflow-hidden">
        {/* Ambient layers — warm zinc tint, no neon */}
        <div
          className="pointer-events-none fixed inset-0 -z-10"
          aria-hidden
        >
          <div className="absolute inset-0 bg-background" />
          <div className="absolute -left-[45%] top-[-30%] h-[85vmin] w-[85vmin] rounded-full bg-[radial-gradient(circle_at_center,_rgba(212,167,106,0.14)_0%,_transparent_62%)] dark:bg-[radial-gradient(circle_at_center,_rgba(212,167,106,0.09)_0%,_transparent_58%)] blur-3xl" />
          <div className="absolute -right-[35%] bottom-[-45%] h-[95vmin] w-[95vmin] rounded-full bg-[radial-gradient(circle_at_center,_rgba(113,113,122,0.16)_0%,_transparent_65%)] dark:bg-[radial-gradient(circle_at_center,_rgba(82,82,91,0.35)_0%,_transparent_60%)] blur-3xl" />
          <div
            className="absolute inset-0 opacity-[0.35] dark:opacity-[0.2]"
            style={{
              backgroundImage: `radial-gradient(rgba(113,113,122,0.45) 1px, transparent 1px)`,
              backgroundSize: "28px 28px",
              maskImage:
                "radial-gradient(ellipse 75% 65% at 50% 35%, black 22%, transparent 72%)",
            }}
          />
        </div>

        <main id="main-content" className="relative flex flex-1 flex-col">
          <header className="landing-rise mx-auto flex w-full max-w-6xl items-center justify-between px-5 pb-6 pt-8 sm:px-8 sm:pb-10 sm:pt-12 lg:px-10">
            <div className="flex items-baseline gap-3">
              <span className="font-display text-lg font-medium tracking-tight text-foreground sm:text-xl">
                lgx<span className="text-zinc-500 dark:text-zinc-400">.guru</span>
              </span>
              <span className="hidden text-zinc-400 sm:inline dark:text-zinc-600">
                /
              </span>
              <span className="hidden text-xs font-medium uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-500 sm:inline">
                Basecamp
              </span>
            </div>
            <nav aria-label="Primary">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-600 underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Dashboard
              </Link>
            </nav>
          </header>

          <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-14 px-5 pb-16 sm:gap-16 sm:px-8 lg:grid-cols-12 lg:gap-12 lg:px-10 lg:pb-24">
            <div className="flex flex-col justify-center lg:col-span-7 lg:pr-6">
              <p className="landing-rise landing-rise-delay-1 max-w-xl text-sm font-medium text-zinc-600 dark:text-zinc-400">
                Visual toolkit for{" "}
                <span className="text-foreground">Logos Basecamp</span> modules
              </p>

              <h1 className="landing-rise landing-rise-delay-2 font-display mt-5 max-w-[14ch] text-[clamp(2.35rem,6vw,3.85rem)] font-medium leading-[1.06] tracking-tight text-foreground">
                Modules designed here run where readers{" "}
                <span className="italic text-zinc-700 dark:text-zinc-300">
                  actually meet them.
                </span>
              </h1>

              <p className="landing-rise landing-rise-delay-3 mt-7 max-w-lg text-pretty text-base leading-relaxed text-zinc-600 dark:text-zinc-400 sm:text-[1.0625rem]">
                Compose widgets with a spatial editor, wire logic with help when
                you want it, and preview through Qt-WASM — then ship as .lgx for
                your ministry workflow.
              </p>

              <div className="landing-rise landing-rise-delay-4 mt-10 flex flex-wrap items-center gap-4">
                <Link
                  href="/dashboard"
                  className="group inline-flex min-h-11 items-center gap-2 rounded-full bg-foreground px-7 py-2.5 text-sm font-semibold text-background transition-[transform,opacity] hover:opacity-95 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
                  aria-label="Open project dashboard"
                >
                  Open dashboard
                  <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </Link>
                <Link
                  href="/dashboard"
                  className="inline-flex min-h-11 items-center rounded-full border border-zinc-300/90 px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
                  aria-label="View saved projects"
                >
                  Your projects
                </Link>
              </div>

              <ul
                className="landing-rise landing-rise-delay-5 mt-14 max-w-xl space-y-6 border-l border-zinc-200 pl-6 dark:border-zinc-700"
                aria-label="What you can do"
              >
                {FEATURES.map((item) => (
                  <li key={item.title}>
                    <p className="font-medium text-foreground">{item.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                      {item.body}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative flex items-center lg:col-span-5 lg:justify-end">
              <div
                className="landing-rise landing-rise-delay-3 relative w-full max-w-md lg:max-w-none"
                aria-hidden
              >
                <div className="pointer-events-none absolute -right-8 -top-10 hidden h-36 w-36 rounded-full border border-zinc-200/80 dark:border-zinc-700/80 lg:block" />
                <div className="relative overflow-hidden rounded-2xl border border-zinc-200/90 bg-gradient-to-br from-zinc-50 via-white to-zinc-100 shadow-[0_28px_80px_-32px_rgba(24,24,27,0.45)] ring-1 ring-black/[0.03] dark:border-zinc-700/90 dark:from-zinc-900 dark:via-zinc-900 dark:to-zinc-950 dark:shadow-[0_36px_90px_-36px_rgba(0,0,0,0.65)] dark:ring-white/[0.04]">
                  <div className="flex items-center gap-2 border-b border-zinc-200/80 px-4 py-3 dark:border-zinc-700/80">
                    <span className="h-2 w-2 rounded-full bg-red-400/90" />
                    <span className="h-2 w-2 rounded-full bg-amber-400/90" />
                    <span className="h-2 w-2 rounded-full bg-emerald-400/85" />
                    <span className="ml-3 truncate text-[11px] font-medium tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
                      builder · preview
                    </span>
                  </div>
                  <div className="aspect-[5/4] p-5 sm:p-6">
                    <div className="flex h-full flex-col rounded-xl border border-dashed border-zinc-300/80 bg-white/70 dark:border-zinc-600/70 dark:bg-zinc-950/40">
                      <div className="flex flex-1 flex-col items-start gap-3 p-5">
                        <div className="h-3 w-[52%] rounded-full bg-zinc-200 dark:bg-zinc-700" />
                        <div className="h-3 w-[38%] rounded-full bg-zinc-200/90 dark:bg-zinc-700/85" />
                        <div className="mt-auto grid w-full grid-cols-2 gap-3">
                          <div className="h-14 rounded-lg bg-zinc-100 dark:bg-zinc-800/90" />
                          <div className="h-14 rounded-lg bg-zinc-100 dark:bg-zinc-800/90" />
                        </div>
                      </div>
                      <div className="border-t border-zinc-200/70 px-5 py-3 dark:border-zinc-700/70">
                        <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
                          Live Qt-WASM preview
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        <footer className="relative border-t border-zinc-200/90 px-5 py-10 dark:border-zinc-800 sm:px-8 lg:px-10">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-zinc-500 dark:text-zinc-500">
              Built for designers and engineers shipping Basecamp UI modules.
            </p>
            <nav
              className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400"
              aria-label="Footer"
            >
              <Link
                href="/dashboard"
                className="transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
              >
                Dashboard
              </Link>
              <a
                href="https://www.logos.com"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
              >
                Logos.com
              </a>
            </nav>
          </div>
        </footer>
      </div>
    </>
  );
};

export default HomePage;
