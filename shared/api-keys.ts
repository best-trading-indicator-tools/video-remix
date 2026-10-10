export const API_PROVIDERS = ["deepseek", "pixabay", "pexels", "postiz"] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];
export interface ApiKeyStatus {
  provider: ApiProvider;
  source: "settings" | "environment" | "none";
  hasEnvironmentKey: boolean;
}
export interface ApiKeySettings { providers: ApiKeyStatus[] }
export interface ApiConnectionResult {
  status: "ready" | "missing" | "invalid" | "no-credit" | "rate-limited" | "unavailable";
  message: string;
  checkedAt: string;
}
