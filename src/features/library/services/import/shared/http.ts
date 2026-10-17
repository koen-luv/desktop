export function requireOk(response: Response, provider: string): void {
  if (!response.ok) throw new Error(`${provider} request failed (${response.status}).`);
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function rethrowIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

export async function tryFetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return undefined;
    return (await response.json()) as unknown;
  } catch {
    rethrowIfAborted(init.signal ?? undefined);
    return undefined;
  }
}

export async function tryFetchText(url: string, init: RequestInit = {}): Promise<string | undefined> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    rethrowIfAborted(init.signal ?? undefined);
    return undefined;
  }
}
