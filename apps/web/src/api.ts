export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let csrfToken: string | null = null;
export const setCsrf = (t: string | null) => {
  csrfToken = t;
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let code = 'error';
    let message = 'Não foi possível concluir a operação';
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      code = j.error?.code ?? code;
      message = j.error?.message ?? message;
    } catch {
      /* corpo não-JSON */
    }
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('ipl:unauthenticated'));
    throw new ApiError(res.status, code, message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T,>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T,>(path: string) => request<T>('DELETE', path),
  async download(path: string, filename: string): Promise<void> {
    const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'download_failed', 'Não foi possível baixar o arquivo');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
