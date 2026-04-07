import type { SessionResponse } from './types';

// GitHub Pages production fallback.
const PRODUCTION_FALLBACK_API = 'https://dosh-backend.onrender.com';
const FETCH_TIMEOUT_MS = 15000;

export class ApiError extends Error {
  code: 'network' | 'timeout' | 'unknown';

  constructor(message: string, code: 'network' | 'timeout' | 'unknown' = 'unknown') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export const API_BASE_URL = resolveApiBaseUrl();
export const WS_URL = toWebSocketUrl(API_BASE_URL);

export async function authenticate(
  password: string,
  clientId: string
): Promise<{ token: string; session: SessionResponse['session'] }> {
  const response = await safeFetch(`${API_BASE_URL}/api/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ password, clientId })
  });

  const payload = await response.json();

  if (!response.ok || !payload?.ok || typeof payload?.token !== 'string') {
    throw new Error(payload?.error || 'Authentication failed');
  }

  return {
    token: payload.token,
    session: payload.session
  };
}

export async function pingBackend(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${API_BASE_URL}/`, { signal: controller.signal });
    return response.ok || response.status < 500;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function getSession(token: string, clientId: string): Promise<SessionResponse['session']> {
  const params = new URLSearchParams({ token, clientId });
  const response = await safeFetch(`${API_BASE_URL}/api/session?${params.toString()}`);
  const payload = await response.json();

  if (!response.ok || !payload?.ok || !payload?.session) {
    throw new Error(payload?.error || 'Session check failed');
  }

  return payload.session;
}

export interface AdminTab {
  id: string;
  name: string;
  currency: string;
  people: number;
  expenses: number;
}

export async function listTabs(token: string): Promise<AdminTab[]> {
  const params = new URLSearchParams({ token });
  const response = await safeFetch(`${API_BASE_URL}/api/tabs?${params.toString()}`);
  const payload = await response.json();

  if (!response.ok || !payload?.ok || !Array.isArray(payload?.tabs)) {
    throw new Error(payload?.error || 'Failed to load tabs');
  }

  return payload.tabs;
}

export async function createTab(token: string, name: string, password: string, currency: string): Promise<void> {
  const response = await safeFetch(`${API_BASE_URL}/api/tabs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ token, name, password, currency })
  });

  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to create tab');
  }
}

export async function deleteTab(token: string, tabId: string): Promise<void> {
  const params = new URLSearchParams({ token });
  const response = await safeFetch(`${API_BASE_URL}/api/tabs/${encodeURIComponent(tabId)}?${params.toString()}`, {
    method: 'DELETE'
  });

  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to delete tab');
  }
}

function resolveApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (configured && typeof configured === 'string' && configured.length > 0) {
    return configured.replace(/\/$/, '');
  }

  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000';
  }

  return PRODUCTION_FALLBACK_API;
}

function toWebSocketUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) {
    return `wss://${httpUrl.slice('https://'.length)}`;
  }

  if (httpUrl.startsWith('http://')) {
    return `ws://${httpUrl.slice('http://'.length)}`;
  }

  return httpUrl;
}

async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('Server is taking a while to wake up. Enter the password again or retry in ~30-60s.', 'timeout');
    }

    throw new ApiError('Server is starting on Render, please wait ~30-60s and try again.', 'network');
  } finally {
    window.clearTimeout(timeoutId);
  }
}
