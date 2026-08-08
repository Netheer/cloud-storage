import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PropsWithChildren } from 'react';
import {
  API_URL,
  login as loginRequest,
  logout as logoutRequest,
  refreshSession,
  register as registerRequest,
} from './auth-api';
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
} from './auth-context';
import type {
  AuthResponse,
  AuthUser,
  LoginInput,
  RegisterInput,
} from './auth.types';

export function AuthProvider({ children }: PropsWithChildren) {
  const accessTokenRef = useRef<string | null>(null);

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  const applySession = useCallback((session: AuthResponse) => {
    accessTokenRef.current = session.accessToken;
    setUser(session.user);
    setStatus('authenticated');
  }, []);

  const clearSession = useCallback(() => {
    accessTokenRef.current = null;
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  useEffect(() => {
    let active = true;

    void refreshSession()
      .then((session) => {
        if (!active) {
          return;
        }

        if (session) {
          applySession(session);
        } else {
          clearSession();
        }
      })
      .catch(() => {
        if (active) {
          clearSession();
        }
      });

    return () => {
      active = false;
    };
  }, [applySession, clearSession]);

  const login = useCallback(
    async (input: LoginInput) => {
      const session = await loginRequest(input);
      applySession(session);
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      await registerRequest(input);

      const session = await loginRequest({
        email: input.email,
        password: input.password,
      });

      applySession(session);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
    clearSession();
  }, [clearSession]);

  const authFetch = useCallback(
    async (
      path: string,
      init: RequestInit = {},
    ): Promise<Response> => {
      const sendRequest = (accessToken: string | null) => {
        const headers = new Headers(init.headers);

        if (accessToken) {
          headers.set(
            'Authorization',
            `Bearer ${accessToken}`,
          );
        }

        return fetch(`${API_URL}${path}`, {
          ...init,
          headers,
          credentials: 'include',
        });
      };

      let response = await sendRequest(accessTokenRef.current);

      if (response.status !== 401) {
        return response;
      }

      const session = await refreshSession();

      if (!session) {
        clearSession();
        return response;
      }

      applySession(session);
      response = await sendRequest(session.accessToken);

      return response;
    },
    [applySession, clearSession],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      login,
      register,
      logout,
      authFetch,
    }),
    [status, user, login, register, logout, authFetch],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}