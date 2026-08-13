import { ApiError } from '../auth/auth-api';

export interface StoredFile {
  id: string;
  name: string;
  ownerId: string;
  folderId: string | null;
  status: string;
  mimeType: string | null;
  size: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileDownload {
  url: string;
  expiresAt: string;
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

export async function listFiles(
  authFetch: AuthFetch,
  folderId: string | null,
): Promise<StoredFile[]> {
  const query = folderId
    ? `?folderId=${encodeURIComponent(folderId)}`
    : '';

  const response = await authFetch(`/files${query}`);

  return readJson<StoredFile[]>(response);
}

export async function uploadFile(
  authFetch: AuthFetch,
  file: File,
  folderId: string | null,
): Promise<StoredFile> {
  const formData = new FormData();

  formData.append('file', file);

  if (folderId) {
    formData.append('folderId', folderId);
  }

  const response = await authFetch('/files/upload', {
    method: 'POST',
    body: formData,
  });

  return readJson<StoredFile>(response);
}

export async function createFileDownload(
  authFetch: AuthFetch,
  fileId: string,
): Promise<FileDownload> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}/download`,
  );

  return readJson<FileDownload>(response);
}

export async function renameFile(
  authFetch: AuthFetch,
  fileId: string,
  name: string,
): Promise<StoredFile> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    },
  );

  return readJson<StoredFile>(response);
}

export async function deleteFile(
  authFetch: AuthFetch,
  fileId: string,
): Promise<void> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}`,
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

export async function moveFile(
  authFetch: AuthFetch,
  fileId: string,
  folderId: string | null,
): Promise<StoredFile> {
  const response = await authFetch(
    `/files/${encodeURIComponent(fileId)}/move`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folderId }),
    },
  );

  return readJson<StoredFile>(response);
}