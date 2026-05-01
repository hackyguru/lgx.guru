import BuilderClient from "../BuilderClient";
import { Monitor } from "@phosphor-icons/react/dist/ssr";

export default function BuilderPage() {
  return (
    <>
      {/* Mobile gate — visible only on small screens */}
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center text-ink md:hidden">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full gradient-accent">
          <Monitor size={32} weight="bold" className="text-white" />
        </div>
        <h1 className="text-[20px] font-medium leading-[1.2]">
          Desktop required
        </h1>
        <p className="mt-3 max-w-[36ch] text-[14px] leading-relaxed text-ink-muted">
          The editor needs a larger screen to work properly. Please open this page on a desktop or laptop browser.
        </p>
        <a href="/dashboard" className="btn-primary mt-8">
          Back to projects
          <span aria-hidden>&larr;</span>
        </a>
      </div>

      {/* Editor — hidden on mobile, shown on md+ */}
      <div className="hidden md:contents">
        <BuilderClient />
      </div>
    </>
  );
}
