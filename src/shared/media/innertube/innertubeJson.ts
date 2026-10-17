export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function getRuns(value: unknown): JsonRecord[] {
  return asArray(asRecord(value)?.runs)
    .map(asRecord)
    .filter((run): run is JsonRecord => Boolean(run));
}

export function getText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (typeof record?.simpleText === "string" && record.simpleText.trim()) {
    return record.simpleText.trim();
  }
  const text = getRuns(value)
    .map((run) => run.text)
    .filter((part): part is string => typeof part === "string")
    .join("")
    .trim();
  return text || undefined;
}

export function getBrowseEndpoint(value: unknown): JsonRecord | undefined {
  return asRecord(asRecord(asRecord(value)?.navigationEndpoint)?.browseEndpoint);
}

export function getPageType(endpoint: JsonRecord | undefined): string | undefined {
  const config = asRecord(
    asRecord(endpoint?.browseEndpointContextSupportedConfigs)?.browseEndpointContextMusicConfig,
  );
  return typeof config?.pageType === "string" ? config.pageType : undefined;
}

export function runPageType(run: JsonRecord): string | undefined {
  return getPageType(getBrowseEndpoint(run));
}

export function isArtistPage(pageType: string | undefined): boolean {
  return pageType === "MUSIC_PAGE_TYPE_ARTIST" || pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL";
}

export function runsToArtists(
  runs: JsonRecord[],
  accept: (pageType: string | undefined) => boolean = isArtistPage,
): { id: string; name: string }[] {
  return runs.flatMap((run) => {
    const endpoint = getBrowseEndpoint(run);
    const name = typeof run.text === "string" ? run.text.trim() : "";
    return accept(getPageType(endpoint)) && typeof endpoint?.browseId === "string" && name
      ? [{ id: endpoint.browseId, name }]
      : [];
  });
}

export function runsToAlbum(runs: JsonRecord[]): { id: string; title: string } | undefined {
  const albumRun = runs.find((run) => runPageType(run) === "MUSIC_PAGE_TYPE_ALBUM");
  const endpoint = albumRun ? getBrowseEndpoint(albumRun) : undefined;
  return typeof endpoint?.browseId === "string" && typeof albumRun?.text === "string"
    ? { id: endpoint.browseId, title: albumRun.text }
    : undefined;
}

export function findFirst(value: unknown, key: string): JsonRecord | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirst(item, key);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = asRecord(record[key]);
  if (direct) return direct;
  for (const child of Object.values(record)) {
    const found = findFirst(child, key);
    if (found) return found;
  }
  return undefined;
}

export function walkRecords(value: unknown, visit: (record: JsonRecord) => boolean): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walkRecords(item, visit));
    return;
  }
  const record = asRecord(value);
  if (!record || visit(record)) return;
  for (const child of Object.values(record)) walkRecords(child, visit);
}

export function yearFromRuns(value: unknown): number | undefined {
  return getRuns(value)
    .map((run) => (typeof run.text === "string" && /^\d{4}$/.test(run.text) ? Number(run.text) : undefined))
    .find((year): year is number => year !== undefined);
}
