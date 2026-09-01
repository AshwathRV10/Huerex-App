/**
 * One place where the browser talks to the server.
 *
 * Errors come back as `{ error, code }` and are thrown as ApiError so every
 * screen can show the server's own sentence — those messages were written to
 * be read by the person at the machine, not by a developer.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuth(): boolean { return this.status === 401; }
  get isForbidden(): boolean { return this.status === 403; }
  get isConflict(): boolean { return this.status === 409; }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await fetch(withQuery(path, query), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

  if (!res.ok) {
    const err = payload as { error?: string; code?: string } | null;
    throw new ApiError(
      res.status,
      err?.error ?? (res.status === 401 ? 'Please sign in again' : 'Something went wrong'),
      err?.code,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),

  /** Exports stream as CSV, so they bypass the JSON wrapper. */
  download(path: string, query?: Query): void {
    window.open(withQuery(path, query), '_blank', 'noopener');
  },
};

export interface Paged<T> { rows: T[]; total?: number; limit?: number; offset?: number }
