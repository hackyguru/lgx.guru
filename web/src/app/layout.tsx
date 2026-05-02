import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Comprehensive site metadata — applies to every App Router page
// (/dashboard, /builder/*) via this root layout. Per-page metadata can
// override individual fields. The Pages Router landing (pages/index.tsx)
// duplicates the same OG/Twitter tags via next/head since metadata
// exports don't propagate across the router boundary.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://lgx.guru";
const SITE_NAME = "lgx.guru";
const SITE_DESCRIPTION =
  "Build Logos Basecamp modules without writing code. Drag-and-drop editor, AI-wired logic, live Qt-WASM preview, cross-platform .lgx export.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — visual builder for Logos Basecamp`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "Logos Basecamp",
    "lgx",
    ".lgx module",
    "QML builder",
    "Qt visual editor",
    "no-code Basecamp",
    "AI UI builder",
    "QML WASM",
  ],
  authors: [{ name: "Logos", url: "https://logos.co" }],
  creator: "Logos",
  publisher: "Logos",
  formatDetection: { email: false, address: false, telephone: false },
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: "/favicon-32.png",
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} — visual builder for Logos Basecamp`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: "en_US",
    images: [
      { url: "/lgx-og.png", width: 640, height: 336, alt: "lgx.guru — build Basecamp modules without writing code." },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — visual builder for Logos Basecamp`,
    description: SITE_DESCRIPTION,
    images: ["/lgx-og.png"],
  },
  robots: { index: true, follow: true },
};

// `themeColor` lives on `viewport` since Next 14; in Next 16 it's flat-out
// ignored when set on `metadata` (and the dev-mode warning that flagged
// our previous shape coincided with stale Turbopack chunk errors that
// crashed client hydration on /dashboard).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0e" },
  ],
};

// Inline bootstrap: runs synchronously before React hydrates so the page
// renders in the right theme on first paint (no flash of light-on-dark).
// Reads the persisted preference, falling back to the OS preference. Mirrors
// what useTheme() in BuilderClient.tsx does — keep both in sync if changed.
const themeBootstrap = `
(function () {
  try {
    // #theme=dark|light overrides everything — handy for screenshots / shared
    // previews without nuking the user's localStorage preference.
    // ?theme= and #theme= overrides — handy for screenshots / shared
    // previews without nuking the user's localStorage preference.
    var override = (location.search.match(/[?&]theme=(light|dark)/) || [])[1]
                || (location.hash.match(/theme=(light|dark)/) || [])[1];
    var stored = override || localStorage.getItem("lgx.theme");
    var pref = stored || "system";
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = pref === "dark" || (pref === "system" && prefersDark);
    if (dark) document.documentElement.classList.add("dark");
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Synchronous theme bootstrap. Runs as the body parses, before any
            UI paints, so the page renders in the right theme on first paint
            (no flash of light-on-dark). React 19 doesn't re-execute this on
            the client — that's the desired behavior; the editor's useTheme()
            hook owns runtime toggles. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        {children}
      </body>
    </html>
  );
}
