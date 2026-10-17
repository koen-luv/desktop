import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCanaryProbe, canClientDirectFetch, markDirectFetchFailed } from './canaryProbe';

describe('canaryProbe', () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;

  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        mockStorage = {};
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) {
      vi.stubGlobal('localStorage', originalLocalStorage);
    }
  });

  it('classifies client as unblocked when canary probe returns 204/opaque response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      type: 'opaque',
    } as any);

    const result = await runCanaryProbe(true);
    expect(result.canDirectFetch).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(canClientDirectFetch()).toBe(true);
  });

  it('classifies client as blocked when canary probe fails with network error / TSPU reset', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    const result = await runCanaryProbe(true);
    expect(result.canDirectFetch).toBe(false);
    expect(result.reason).toBe('Failed to fetch');
    expect(canClientDirectFetch()).toBe(false);
  });

  it('classifies client as blocked when probe times out (TSPU blackhole)', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const result = await runCanaryProbe(true);
    expect(result.canDirectFetch).toBe(false);
    expect(result.reason).toBe('TSPU_TIMEOUT');
  });

  it('allows marking direct fetch failed on playback stall', () => {
    markDirectFetchFailed('STALL_AFTER_2S');
    expect(canClientDirectFetch()).toBe(false);
  });
});
