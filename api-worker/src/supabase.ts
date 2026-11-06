export class SupabaseError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly details?: string,
  ) {
    super(message);
    this.name = "SupabaseError";
  }
}

interface InsertOptions {
  onConflict?: string;
  ignoreDuplicates?: boolean;
  returning?: boolean;
}

/**
 * Minimal PostgREST client. The Worker talks to Supabase with the service role
 * key, so every table has RLS enabled and no public policy: the key never ships
 * to clients and the API is the only door.
 */
export class Supabase {
  private readonly base: string;

  constructor(
    url: string,
    private readonly key: string,
  ) {
    this.base = `${url.replace(/\/+$/, "")}/rest/v1/`;
  }

  private async send<T>(
    path: string,
    init: RequestInit,
    prefer?: string,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("apikey", this.key);
    headers.set("authorization", `Bearer ${this.key}`);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (prefer) headers.set("prefer", prefer);

    const response = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let body: {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        hint?: unknown;
      } = {};
      try {
        body = text ? (JSON.parse(text) as typeof body) : {};
      } catch {
        // a proxy or Supabase gateway answered with html/plain text
      }
      const message =
        typeof body.message === "string" && body.message
          ? body.message
          : `Supabase request failed (${response.status}).`;
      throw new SupabaseError(
        response.status,
        typeof body.code === "string" ? body.code : undefined,
        message,
        typeof body.details === "string"
          ? body.details
          : typeof body.hint === "string"
            ? body.hint
            : undefined,
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  select<T>(table: string, query: string): Promise<T[]> {
    return this.send<T[]>(`${table}?${query}`, { method: "GET" });
  }

  async first<T>(table: string, query: string): Promise<T | null> {
    const rows = await this.select<T>(table, query);
    return rows[0] ?? null;
  }

  insert<T>(
    table: string,
    rows: unknown[],
    options: InsertOptions = {},
  ): Promise<T[]> {
    const query = options.onConflict
      ? `?on_conflict=${encodeURIComponent(options.onConflict)}`
      : "";
    const prefer = options.ignoreDuplicates
      ? "resolution=ignore-duplicates,return=minimal"
      : options.returning === false
        ? "return=minimal"
        : "return=representation";
    return this.send<T[]>(
      `${table}${query}`,
      { method: "POST", body: JSON.stringify(rows) },
      prefer,
    ).then((result) => result ?? []);
  }

  upsert<T>(table: string, rows: unknown[], onConflict: string): Promise<T[]> {
    return this.send<T[]>(
      `${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      { method: "POST", body: JSON.stringify(rows) },
      "resolution=merge-duplicates,return=representation",
    ).then((result) => result ?? []);
  }

  update<T>(table: string, filter: string, patch: unknown): Promise<T[]> {
    return this.send<T[]>(
      `${table}?${filter}`,
      { method: "PATCH", body: JSON.stringify(patch) },
      "return=representation",
    ).then((result) => result ?? []);
  }

  async delete(table: string, filter: string): Promise<void> {
    await this.send<undefined>(
      `${table}?${filter}`,
      { method: "DELETE" },
      "return=minimal",
    );
  }

  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    return this.send<T>(`rpc/${fn}`, {
      method: "POST",
      body: JSON.stringify(args),
    });
  }
}
