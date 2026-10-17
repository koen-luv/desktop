/**
 * Client-side Canary Probe for YouTube/Innertube Direct Fetch Capability.
 *
 * Detects whether the user is behind Russian TSPU (RKN) DPI blocking/throttling
 * without relying on naive GeoIP checks (which break for users with GoodbyeDPI,
 * Zapret, ByeDPI, VPNs, or unblocked regional ISPs).
 */

const CANARY_URL = 'https://redirector.googlevideo.com/generate_204';
const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const STORAGE_KEY = 'liner_canary_probe_result';

export interface CanaryProbeResult {
  canDirectFetch: boolean;
  latencyMs: number;
  probedAt: number;
  reason?: string;
}

let inMemoryResult: CanaryProbeResult | null = null;
let activeProbePromise: Promise<CanaryProbeResult> | null = null;

/**
 * Reads cached canary result from localStorage if within TTL.
 */
function getCachedResult(): CanaryProbeResult | null {
  if (inMemoryResult && Date.now() - inMemoryResult.probedAt < CACHE_TTL_MS) {
    return inMemoryResult;
  }

  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: CanaryProbeResult = JSON.parse(raw);
    if (Date.now() - parsed.probedAt < CACHE_TTL_MS) {
      inMemoryResult = parsed;
      return parsed;
    }
  } catch {
    // Ignore corrupt storage
  }

  return null;
}

/**
 * Persists canary result to memory and localStorage.
 */
function persistResult(result: CanaryProbeResult): void {
  inMemoryResult = result;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    } catch {
      // Ignore quota errors
    }
  }
}

/**
 * Executes a live probe against GoogleVideo CDN's zero-overhead generate_204.
 *
 * If TSPU is active and blocking:
 * - Drops packets or returns TCP RST, timing out after 1500ms or throwing immediately.
 * If unblocked / bypassed via GoodbyeDPI/Zapret/VPN:
 * - Resolves with HTTP 204 in <100ms.
 */
export async function runCanaryProbe(force = false): Promise<CanaryProbeResult> {
  if (!force) {
    const cached = getCachedResult();
    if (cached) return cached;
  }

  if (activeProbePromise) {
    return activeProbePromise;
  }

  activeProbePromise = (async () => {
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      // mode: 'no-cors' allows sending cross-origin request to googlevideo.com
      // The TLS handshake and TCP connection will be fully performed, which is
      // what triggers TSPU / DPI inspection.
      const response = await fetch(CANARY_URL, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - start);

      // In no-cors mode, successful fetch returns type: 'opaque' with status: 0
      const result: CanaryProbeResult = {
        canDirectFetch: true,
        latencyMs,
        probedAt: Date.now(),
      };

      persistResult(result);
      return result;
    } catch (err: any) {
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - start);
      const isTimeout = err?.name === 'AbortError';

      const result: CanaryProbeResult = {
        canDirectFetch: false,
        latencyMs,
        probedAt: Date.now(),
        reason: isTimeout ? 'TSPU_TIMEOUT' : (err?.message || 'BLOCKED_DPI'),
      };

      persistResult(result);
      return result;
    } finally {
      activeProbePromise = null;
    }
  })();

  return activeProbePromise;
}

/**
 * Synchronous query for whether direct fetch is permitted.
 * If not yet probed, returns the cached result or a safe default.
 */
export function canClientDirectFetch(): boolean {
  const cached = getCachedResult();
  if (cached) {
    return cached.canDirectFetch;
  }

  // In test environments, return default without triggering unexpected background fetch mocks
  if (
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.TEST)
  ) {
    return true;
  }

  // Trigger probe in background for next time
  void runCanaryProbe();

  // If not yet probed, default to true unless running via edge domain
  if (typeof window !== 'undefined') {
    const isEdge = window.location.hostname.includes('edge.');
    return !isEdge;
  }

  return true;
}

/**
 * Marks direct playback as failed/throttled for this session.
 * Called automatically by player runtime if audio stalls > 2500ms or throws MEDIA_ERR_NETWORK.
 */
export function markDirectFetchFailed(reason = 'PLAYBACK_STALL'): void {
  const failedResult: CanaryProbeResult = {
    canDirectFetch: false,
    latencyMs: 9999,
    probedAt: Date.now(),
    reason,
  };
  persistResult(failedResult);
}

// Automatically re-probe when network status changes (e.g. VPN enabled/disabled)
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void runCanaryProbe(true);
  });
}
