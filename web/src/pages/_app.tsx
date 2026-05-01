import "@/app/globals.css";
import type { AppProps } from "next/app";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  weight: "400",
});

const App = ({ Component, pageProps }: AppProps) => {
  return (
    <div
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} font-sans min-h-screen flex flex-col bg-background text-foreground`}
    >
      <Component {...pageProps} />
    </div>
  );
};

export default App;
