export function isAbortError(error: unknown, signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === "AbortError");
}

export function rethrowIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason;
}
