import type { SessionResponse } from './types';

// GitHub Pages production fallback.
const PRODUCTION_FALLBACK_API = 'https://dosh-backend.onrender.com';

export const API_BASE_URL = resolveApiBaseUrl();
export const WS_URL = toWebSocketUrl(API_BASE_URL);

export async function authenticate(
  password: string,
  clientId: string
): Promise<{ token: string; session: SessionResponse['session'] }> {
  const response = await fetch(`${API_BASE_URL}/api/auth`, {
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

export async function getSession(token: string, clientId: string): Promise<SessionResponse['session']> {
  const params = new URLSearchParams({ token, clientId });
  const response = await fetch(`${API_BASE_URL}/api/session?${params.toString()}`);
  const payload = await response.json();

  if (!response.ok || !payload?.ok || !payload?.session) {
    throw new Error(payload?.error || 'Session check failed');
  }

  return payload.session;
}

export interface AdminTab {
  id: string;
  name: string;
  people: number;
  expenses: number;
}

export async function listTabs(token: string): Promise<AdminTab[]> {
  const params = new URLSearchParams({ token });
  const response = await fetch(`${API_BASE_URL}/api/tabs?${params.toString()}`);
  const payload = await response.json();

  if (!response.ok || !payload?.ok || !Array.isArray(payload?.tabs)) {
    throw new Error(payload?.error || 'Failed to load tabs');
  }

  return payload.tabs;
}

export async function createTab(token: string, name: string, password: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/tabs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ token, name, password })
  });

  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to create tab');
  }
}

export async function deleteTab(token: string, tabId: string): Promise<void> {
  const params = new URLSearchParams({ token });
  const response = await fetch(`${API_BASE_URL}/api/tabs/${encodeURIComponent(tabId)}?${params.toString()}`, {
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
