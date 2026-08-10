import { ApiError } from '../auth/auth-api';

export interface Folder {
  id: string;
  name: string;
  ownerId: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

type AuthFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

async function getErrorMessage(
  response: Response,
): Promise<string> {
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

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiError(
      response.status,
      await getErrorMessage(response),
    );
  }

  return (await response.json()) as T;
}

export async function listFolders(
  authFetch: AuthFetch,
  parentId: string | null,
): Promise<Folder[]> {
  const query = parentId
    ? `?parentId=${encodeURIComponent(parentId)}`
    : '';

  const response = await authFetch(`/folders${query}`);

  return readJson<Folder[]>(response);
}

export async function createFolder(
  authFetch: AuthFetch,
  name: string,
  parentId: string | null,
): Promise<Folder> {
  const response = await authFetch('/folders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      parentId,
    }),
  });

  return readJson<Folder>(response);
}

export async function renameFolder(
  authFetch: AuthFetch,
  folderId: string,
  name: string,
): Promise<Folder> {
  const response = await authFetch(
    `/folders/${encodeURIComponent(folderId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    },
  );

  return readJson<Folder>(response);
}

export async function deleteFolder(
  authFetch: AuthFetch,
  folderId: string,
): Promise<void> {
  const response = await authFetch(
    `/folders/${encodeURIComponent(folderId)}`,
    {
      method: 'DELETE',
    },
  );

  if (!response.ok) {
    throw new ApiError(
      response.status,
      await getErrorMessage(response),
    );
  }
}

export async function moveFolder(
  authFetch: AuthFetch,
  folderId: string,
  parentId: string | null,
): Promise<Folder> {
  const response = await authFetch(
    `/folders/${encodeURIComponent(folderId)}/move`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parentId }),
    },
  );

  return readJson<Folder>(response);
}