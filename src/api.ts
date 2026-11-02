import type { ApiError } from '../shared/types';
import { API_VERSION, SERVER_RESTART_MESSAGE } from '../shared/protocol';
let token = '';
export function setToken(value: string) { token = value; }
export class ApiRequestError extends Error {
  constructor(message: string, public code: string, public recovery?: ApiError['error']['recovery']) { super(message); }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Look-in-Git-Token': token, 'X-Look-in-Git-Api-Version': String(API_VERSION), ...options.headers },
  });
  const data = await response.json() as T & ApiError;
  if (!response.ok) {
    const missingAction = response.status === 404 && data.error?.code === 'NOT_FOUND' && /\/(action-review|actions)(\?|$)/.test(url);
    throw new ApiRequestError(missingAction ? SERVER_RESTART_MESSAGE : data.error?.message || 'Unable to reach the local Git server.', data.error?.code || 'REQUEST_FAILED', data.error?.recovery);
  }
  if (url === '/session' && (data as { apiVersion?: number }).apiVersion !== API_VERSION) throw new ApiRequestError(SERVER_RESTART_MESSAGE, 'API_VERSION_MISMATCH');
  return data;
}
export function query(values: Record<string, string | undefined>) {
  return new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
}
export function readPreference<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem('look-in-git:' + key); return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
export function savePreference(key: string, value: unknown) {
  try { localStorage.setItem('look-in-git:' + key, JSON.stringify(value)); } catch { /* Private browsing may disable storage. */ }
  window.dispatchEvent(new CustomEvent('look-in-git:preference', {detail:key}));
}
