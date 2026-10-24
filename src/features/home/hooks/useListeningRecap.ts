import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/shared/api";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";
import { useSessionOwner } from "./sessionAwareLoad";
import { buildListeningRecap, type ListeningRecap } from "../recap";

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const cache = new Map<string, { data: ListeningRecap; cachedAt: number }>();

export function useListeningRecap(year = new Date().getFullYear()) {
  const owner = useSessionOwner();
  const [data, setData] = useState<ListeningRecap | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequest = useRef(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  useEffect(() => {
    activeRequest.current += 1;
    setData(null);
    setError(null);
    setIsLoading(false);
  }, [owner, year]);

  const load = useCallback(async () => {
    if (!owner) {
      setError("Sign in to build a recap from your listening history.");
      return;
    }

    const key = `${owner}:${year}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      setData(cached.data);
      setError(null);
      return;
    }

    const requestId = ++activeRequest.current;
    setIsLoading(true);
    setError(null);

    try {
      const history: PlaybackHistoryItem[] = [];
      let cursor: string | undefined;
      let hasMore = true;
      let isPartial = false;

      for (let page = 0; page < MAX_PAGES && hasMore; page += 1) {
        const response = await api.getHistory(cursor, PAGE_SIZE);
        const items = response.items || [];
        history.push(...items);
        cursor = response.nextCursor ?? undefined;
        hasMore = Boolean(cursor);

        if (items.length > 0) {
          const oldestAt = items.reduce((oldest, entry) => {
            const timestamp = Date.parse(entry.listenedAt || "");
            return Number.isFinite(timestamp) ? Math.min(oldest, timestamp) : oldest;
          }, Number.POSITIVE_INFINITY);
          if (oldestAt < new Date(year, 0, 1).getTime()) {
            hasMore = false;
            break;
          }
        }
        if (page === MAX_PAGES - 1 && hasMore) isPartial = true;
      }

      if (requestId !== activeRequest.current || ownerRef.current !== owner) return;
      const recap = buildListeningRecap(history, year, isPartial);
      cache.set(key, { data: recap, cachedAt: Date.now() });
      setData(recap);
    } catch (cause) {
      if (requestId !== activeRequest.current || ownerRef.current !== owner) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load your listening history. Try again.",
      );
    } finally {
      if (requestId === activeRequest.current && ownerRef.current === owner) {
        setIsLoading(false);
      }
    }
  }, [owner, year]);

  return { data, error, isLoading, load };
}
