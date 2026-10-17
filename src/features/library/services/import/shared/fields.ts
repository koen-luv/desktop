import { asRecord, type JsonRecord } from "@/shared/media/innertube/innertubeJson";

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function trimmedString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function isRecord(value: JsonRecord | undefined): value is JsonRecord {
  return Boolean(value);
}

export function recordAt(value: unknown, ...path: string[]): JsonRecord | undefined {
  let current = asRecord(value);
  for (const key of path) {
    current = asRecord(current?.[key]);
    if (!current) return undefined;
  }
  return current;
}

export function collectByKey(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectByKey(entry, key, out);
    return out;
  }
  const record = asRecord(value);
  if (!record) return out;
  for (const [name, entry] of Object.entries(record)) {
    if (name === key) out.push(entry);
    collectByKey(entry, key, out);
  }
  return out;
}

export function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
