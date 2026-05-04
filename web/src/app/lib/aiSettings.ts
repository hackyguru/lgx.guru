"use client";

// Per-browser BYO AI provider settings. Stored in localStorage so the
// API key is isolated to this browser and never reaches lgx.guru's own
// server (the user's browser passes it directly to /api/* routes which
// run on whatever host serves this app — local pnpm dev, the npx CLI,
// or a self-hosted instance).
//
// Two providers are supported, mirroring the server's pickProvider:
//   - "openai": canonical OpenAI API + model id
//   - "nvidia": NVIDIA's Integrate endpoint (different baseURL, same
//               OpenAI-compatible request shape)
//
// Server still falls back to OPENAI_API_KEY / NVIDIA_API_KEY env vars
// if the user hasn't configured a key here, so existing local-dev
// flows keep working unchanged.

const PROVIDER_KEY = "lgx.guru/v1/ai/provider";
const KEY_KEY      = "lgx.guru/v1/ai/key";
const MODEL_KEY    = "lgx.guru/v1/ai/model";

export type AIProvider = "openai" | "nvidia";

export interface AISettings {
  provider: AIProvider;
  apiKey: string;
  model: string;     // optional; empty string = let server pick its default
}

export const emptyAISettings: AISettings = {
  provider: "openai",
  apiKey: "",
  model: "",
};

export function readAISettings(): AISettings {
  if (typeof window === "undefined") return emptyAISettings;
  const rawProv = window.localStorage.getItem(PROVIDER_KEY);
  const provider: AIProvider = rawProv === "nvidia" ? "nvidia" : "openai";
  return {
    provider,
    apiKey: window.localStorage.getItem(KEY_KEY)   ?? "",
    model:  window.localStorage.getItem(MODEL_KEY) ?? "",
  };
}

export function writeAISettings(s: AISettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PROVIDER_KEY, s.provider);
  if (s.apiKey) window.localStorage.setItem(KEY_KEY, s.apiKey);
  else          window.localStorage.removeItem(KEY_KEY);
  if (s.model)  window.localStorage.setItem(MODEL_KEY, s.model);
  else          window.localStorage.removeItem(MODEL_KEY);
}

export function isAIConfigured(s: AISettings): boolean {
  return s.apiKey.trim().length > 0;
}

// Shape passed to /api/apply-patch + /api/generate-icon in the request
// body. Server reads this and prefers it over OPENAI_API_KEY env. Sent
// only when the user has a configured key — when empty we omit the
// field entirely so the server falls through to env-based auth.
export interface AIRequestAuth {
  provider: AIProvider;
  apiKey: string;
  model?: string;
}

export function settingsToRequestAuth(s: AISettings): AIRequestAuth | null {
  if (!isAIConfigured(s)) return null;
  return {
    provider: s.provider,
    apiKey: s.apiKey.trim(),
    ...(s.model.trim() ? { model: s.model.trim() } : {}),
  };
}
