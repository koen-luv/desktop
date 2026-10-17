export const DEFAULT_PRIMARY_API = "https://api.tryliner.fun";

const envUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/+$/, "");
const baseUrl = envUrl || DEFAULT_PRIMARY_API;

export function getApiBaseUrl(): string {
  return baseUrl;
}
