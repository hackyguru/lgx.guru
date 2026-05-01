import "@/app/globals.css";
import type { AppProps } from "next/app";
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const App = ({ Component, pageProps }: AppProps) => {
  return (
    <div
      className={`${geistSans.variable} ${geistMono.variable} font-sans min-h-screen flex flex-col bg-canvas text-ink`}
    >
      <Component {...pageProps} />
    </div>
  );
};

export default App;
