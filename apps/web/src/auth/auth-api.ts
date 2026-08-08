import type {
  AuthResponse,
  AuthUser,
  LoginInput,
  RegisterInput,
} from './auth.types';

export const API_URL =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);

    this.name = 'ApiError';
    this.status = status;
  }
}

let refreshRequest: Promise<AuthResponse | null> | null = null;

async function getErrorMessage(response: Response): Promise<string> {
  const fallback = `Ошибка запроса: HTTP ${response.status}`;

  try {
    const body = (await response.json()) as unknown;

    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body
    ) {
      const message = body.message;

      if (typeof message === 'string') {
        return message;
      }

      if (
        Array.isArray(message) &&
        message.every((item) => typeof item === 'string')
      ) {
        return message.join(', ');
      }
    }
  } catch {
    return fallback;
  }

  return fallback;
}

async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, init);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      await getErrorMessage(response),
    );
  }

  return (await response.json()) as T;
}

export function login(input: LoginInput): Promise<AuthResponse> {
  return requestJson<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function register(input: RegisterInput): Promise<AuthUser> {
  return requestJson<AuthUser>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function refreshSession(): Promise<AuthResponse | null> {
  if (refreshRequest) {
    return refreshRequest;
  }

  refreshRequest = (async () => {
    const response = await apiFetch('/auth/refresh', {
      method: 'POST',
    });

    if (response.status === 401) {
      return null;
    }

    if (!response.ok) {
      throw new ApiError(
        response.status,
        await getErrorMessage(response),
      );
    }

    return (await response.json()) as AuthResponse;
  })().finally(() => {
    refreshRequest = null;
  });

  return refreshRequest;
}

export async function logout(): Promise<void> {
  const response = await apiFetch('/auth/logout', {
    method: 'POST',
  });

  if (!response.ok) {
    throw new ApiError(
      response.status,
      await getErrorMessage(response),
    );
  }
}