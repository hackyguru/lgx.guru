import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "lgx.guru",
  description: "Visual builder for Logos Basecamp UI modules — design QML widgets in the browser, export as .lgx.",
};

// Inline bootstrap: runs synchronously before React hydrates so the page
// renders in the right theme on first paint (no flash of light-on-dark).
// Reads the persisted preference, falling back to the OS preference. Mirrors
// what useTheme() in page.tsx does — keep both in sync if changed.
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
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
