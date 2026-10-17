export const FALLBACK_SOUNDCLOUD_CLIENT_IDS = [
  "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo",
  "a3e059563d7fd3372b49b37f00a00bcf",
  "iZIs9mchVcX5lhVR1OiZAkOoIQ9rqk64",
  "bW40AM9wD9hTXwA27R8B2964gW2v4o2r",
];

const SOUNDCLOUD_HOME = "https://soundcloud.com";
const SCRIPT_URL = /src="((?:https:)?\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
const CLIENT_ID_PATTERN = /client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/;

let cachedSoundCloudClientId: string | undefined;

export function rememberSoundCloudClientId(clientId: string): void {
  cachedSoundCloudClientId = clientId;
}

export function resetSoundCloudClientIdCache(): void {
  cachedSoundCloudClientId = undefined;
}

async function fetchText(url: string, init: RequestInit): Promise<string | undefined> {
  try {
    const response = await fetch(url, init);
    return response.ok ? await response.text() : undefined;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    return undefined;
  }
}

function scriptUrlsFromHtml(html: string): string[] {
  return [...html.matchAll(SCRIPT_URL)].map((match) => (match[1].startsWith("//") ? `https:${match[1]}` : match[1]));
}

async function discoverSoundCloudClientId(signal?: AbortSignal): Promise<string | undefined> {
  const html = await fetchText(SOUNDCLOUD_HOME, { headers: { accept: "text/html,application/xhtml+xml" }, signal });
  for (const scriptUrl of html ? scriptUrlsFromHtml(html).reverse() : []) {
    const found = (await fetchText(scriptUrl, { signal }))?.match(CLIENT_ID_PATTERN)?.[1];
    if (found) {
      cachedSoundCloudClientId = found;
      return found;
    }
  }
  return undefined;
}

export async function getSoundCloudClientId(configuredClientId?: string, signal?: AbortSignal): Promise<string> {
  if (configuredClientId?.trim()) return configuredClientId.trim();
  if (cachedSoundCloudClientId) return cachedSoundCloudClientId;
  return (await discoverSoundCloudClientId(signal)) ?? FALLBACK_SOUNDCLOUD_CLIENT_IDS[0];
}

export async function refreshSoundCloudClientId(rejectedClientId: string, signal?: AbortSignal): Promise<string | undefined> {
  if (cachedSoundCloudClientId === rejectedClientId) cachedSoundCloudClientId = undefined;
  const discovered = await discoverSoundCloudClientId(signal);
  if (discovered && discovered !== rejectedClientId) return discovered;
  return FALLBACK_SOUNDCLOUD_CLIENT_IDS.find((clientId) => clientId !== rejectedClientId);
}

export async function getSoundCloudClientIdCandidates(configuredClientId?: string, signal?: AbortSignal): Promise<string[]> {
  const active = await getSoundCloudClientId(configuredClientId, signal);
  return [...new Set([active, ...FALLBACK_SOUNDCLOUD_CLIENT_IDS])].filter((clientId) => clientId.length > 0);
}
