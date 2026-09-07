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

export type AuthFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export type MultipartUploadSessionStatus =
  | 'CREATED'
  | 'UPLOADING'
  | 'COMPLETING'
  | 'COMPLETED'
  | 'ABORTED'
  | 'EXPIRED'
  | 'FAILED'
  | 'ABORTING';

export interface MultipartUploadSession {
  id: string;
  clientRequestId: string;
  originalName: string;
  mimeType: string | null;
  folderId: string | null;
  totalSize: string;
  partSize: string;
  totalParts: number;
  status: MultipartUploadSessionStatus;
  expiresAt: string;
  fileId: string | null;
}

export interface MultipartUploadedPart {
  partNumber: number;
  etag: string;
  size: string;
}

export interface MultipartUploadStatus
  extends MultipartUploadSession {
  uploadedParts: MultipartUploadedPart[];
}

export interface MultipartUploadPartUrl {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface InitiateMultipartUploadInput {
  clientRequestId: string;
  fileName: string;
  mimeType?: string;
  totalSize: string;
  folderId: string | null;
}

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

export async function initiateMultipartUpload(
  authFetch: AuthFetch,
  input: InitiateMultipartUploadInput,
  signal?: AbortSignal,
): Promise<MultipartUploadSession> {
  const response = await authFetch('/files/multipart', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientRequestId: input.clientRequestId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      totalSize: input.totalSize,
      folderId: input.folderId,
    }),
    signal,
  });

  return readJson<MultipartUploadSession>(response);
}

export async function createMultipartUploadPartUrl(
  authFetch: AuthFetch,
  sessionId: string,
  partNumber: number,
  signal?: AbortSignal,
): Promise<MultipartUploadPartUrl> {
  const response = await authFetch(
    `/files/multipart/${encodeURIComponent(sessionId)}/parts/${partNumber}`,
    {
      method: 'POST',
      signal,
    },
  );

  return readJson<MultipartUploadPartUrl>(response);
}

export async function getMultipartUploadStatus(
  authFetch: AuthFetch,
  sessionId: string,
  signal?: AbortSignal,
): Promise<MultipartUploadStatus> {
  const response = await authFetch(
    `/files/multipart/${encodeURIComponent(sessionId)}`,
    {
      signal,
    },
  );

  return readJson<MultipartUploadStatus>(response);
}

export async function completeMultipartUpload(
  authFetch: AuthFetch,
  sessionId: string,
): Promise<StoredFile> {
  const response = await authFetch(
    `/files/multipart/${encodeURIComponent(sessionId)}/complete`,
    {
      method: 'POST',
    },
  );

  return readJson<StoredFile>(response);
}

export async function abortMultipartUpload(
  authFetch: AuthFetch,
  sessionId: string,
): Promise<void> {
  const response = await authFetch(
    `/files/multipart/${encodeURIComponent(sessionId)}`,
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

export async function uploadMultipartPart(
  url: string,
  part: Blob,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body: part,
    signal,
  });

  if (!response.ok) {
    throw new ApiError(
      response.status,
      await getErrorMessage(response),
    );
  }
}