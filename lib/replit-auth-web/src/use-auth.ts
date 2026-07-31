import { useCallback, useEffect, useState } from 'react';
import type { AuthUser } from '@workspace/api-client-react';

export type { AuthUser };

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
}

function getBasePath() {
  return import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';
}

// Origin of the API server when the web app is hosted on a different origin
// (self-hosted split deployment). Empty string = same origin (default).
function getApiBase() {
  return import.meta.env.VITE_API_URL?.replace(/\/+$/, '') ?? '';
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch(`${getApiBase()}/api/auth/user`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ user: AuthUser | null }>;
      })
      .then((data) => {
        if (!cancelled) {
          setUser(data.user ?? null);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(() => {
    const base = getBasePath();
    // Split-origin deployments: pass the absolute frontend URL so the OIDC
    // callback lands back on the web app, not on the API host. The server
    // validates it against its configured WEB_ORIGIN.
    const returnTo = getApiBase() ? `${window.location.origin}${base}` : base;
    window.location.href = `${getApiBase()}/api/login?returnTo=${encodeURIComponent(returnTo)}`;
  }, []);

  const logout = useCallback(() => {
    const base = getBasePath();
    const returnTo = getApiBase() ? `${window.location.origin}${base}` : base;
    window.location.href = `${getApiBase()}/api/logout?returnTo=${encodeURIComponent(returnTo)}`;
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    logout,
  };
}
