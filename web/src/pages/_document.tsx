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
      <Head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </Head>
      <body className="min-h-full flex flex-col antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
};

export default Document;
