import { Head, Html, Main, NextScript } from "next/document";

const themeBootstrap = `
(function () {
  try {
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

const Document = () => {
  return (
    <Html lang="en" className="h-full" suppressHydrationWarning>
      <Head />
      <body className="min-h-full flex flex-col antialiased">
        {/* Synchronous theme bootstrap — body-level so React 19 doesn't
            warn about scripts in component trees. Still runs before any
            UI paints because <Main /> follows. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
};

export default Document;
