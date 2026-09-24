import { ApiError } from '../auth/auth-api';

export type ShareRole = 'VIEWER' | 'EDITOR';

export type AuthFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export interface Share {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: ShareRole;
  createdAt: string;
  updatedAt: string;
}

export interface SharedFolder {
  id: string;
  name: string;
  ownerId: string;
  parentId: string | null;
  role: ShareRole;
  sharedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SharedFile {
  id: string;
  name: string;
  ownerId: string;
  folderId: string | null;
  status: string;
  mimeType: string | null;
  size: string | null;
  role: ShareRole;
  sharedAt: string;
  createdAt: string;
  updatedAt: string;
}

async function getErrorMessage(
  response: Response,
): Promise<string> {
  const fallback =
    `Ошибка запроса: HTTP ${response.status}`;

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
        message.every(
          (item) => typeof item === 'string',
        )
      ) {
        return message.join(', ');
      }
    }
  } catch {
    return fallback;
  }

  return fallback;
}

async function readJson<T>(
  response: Response,
): Promise<T> {
  if (!response.ok) {
    throw new ApiError(
      response.status,
      await getErrorMessage(response),
    );
  }

  return (await response.json()) as T;
}

async function expectOk(
  response: Response,
): Promise<void> {
  if (!response.ok) {
    throw new ApiError(
      response.status,
      await getErrorMessage(response),
    );
  }
}

export async function listFolderShares(
  authFetch: AuthFetch,
  folderId: string,
): Promise<Share[]> {
  const response = await authFetch(
    `/folders/${encodeURIComponent(folderId)}/shares`,
  );

  return readJson<Share[]>(response);
}

export async function createFolderShare(
  authFetch: AuthFetch,
  folderId: string,
  email: string,
  role: ShareRole,
): Promise<Share> {
  const response = await authFetch(
    `/folders/${encodeURIComponent(folderId)}/shares`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        role,
      }),
    },
  );

  return readJson<Share>(response);
}

export async function updateFolderShare(
  authFetch: AuthFetch,
  folderId: string,
  grantId: string,
  role: ShareRole,
): Promise<Share> {
  const response = await authFetch(
    `/folders/${encodeURIComponent(folderId)}/shares/${encodeURIComponent(
      grantId,
    )}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role,
      }),
    },
  );

  return readJson<Share>(response);
}

export async function deleteFolderShare(
  authFetch: AuthFetch,
  folderId: string,
  grantId: string,
): Promise<void> {
  const response = await authFetch(
    `/folders/${encodeURIComponent(folderId)}/shares/${encodeURIComponent(
      grantId,
    )}`,
    {
      method: 'DELETE',
    },
  );

  await expectOk(response);
}

export async function listFileShares(
  authFetch: AuthFetch,
  fileId: string,
): Promise<Share[]> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}/shares`,
  );

  return readJson<Share[]>(response);
}

export async function createFileShare(
  authFetch: AuthFetch,
  fileId: string,
  email: string,
  role: ShareRole,
): Promise<Share> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}/shares`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        role,
      }),
    },
  );

  return readJson<Share>(response);
}

export async function updateFileShare(
  authFetch: AuthFetch,
  fileId: string,
  grantId: string,
  role: ShareRole,
): Promise<Share> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}/shares/${encodeURIComponent(
      grantId,
    )}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role,
      }),
    },
  );

  return readJson<Share>(response);
}

export async function deleteFileShare(
  authFetch: AuthFetch,
  fileId: string,
  grantId: string,
): Promise<void> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}/shares/${encodeURIComponent(
      grantId,
    )}`,
    {
      method: 'DELETE',
    },
  );

  await expectOk(response);
}

export async function listSharedFolders(
  authFetch: AuthFetch,
): Promise<SharedFolder[]> {
  const response = await authFetch(
    '/folders/shared-with-me',
  );

  return readJson<SharedFolder[]>(response);
}

export async function listSharedFiles(
  authFetch: AuthFetch,
): Promise<SharedFile[]> {
  const response = await authFetch(
    '/files/shared-with-me',
  );

  return readJson<SharedFile[]>(response);
}