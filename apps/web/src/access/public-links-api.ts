import { ApiError } from '../auth/auth-api';

export type PublicLinkTargetType =
  | 'folder'
  | 'file';

export interface PublicLink {
  id: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedPublicLink
  extends PublicLink {
  token: string;
}

export interface PublicFile {
  id: string;
  name: string;
  mimeType: string | null;
  size: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicFolderItem {
  id: string;
  name: string;
  parentId: string | null;
}

export interface PublicFolderFile {
  id: string;
  name: string;
  mimeType: string | null;
  size: string;
}

export interface PublicFolderContents {
  rootFolderId: string;
  folder: PublicFolderItem;
  folders: PublicFolderItem[];
  files: PublicFolderFile[];
}

export interface PublicDownload {
  url: string;
  expiresAt: string;
}

type AuthFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

const API_URL =
  import.meta.env.VITE_API_URL.replace(
    /\/$/,
    '',
  );

async function getErrorMessage(
  response: Response,
): Promise<string> {
  const fallback =
    `Ошибка запроса: HTTP ${response.status}`;

  try {
    const body =
      (await response.json()) as unknown;

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
          (item) =>
            typeof item === 'string',
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

function getTargetPath(
  type: PublicLinkTargetType,
  targetId: string,
): string {
  const resource =
    type === 'folder'
      ? 'folders'
      : 'files';

  return `/${resource}/${encodeURIComponent(
    targetId,
  )}/public-links`;
}

export async function createPublicLink(
  authFetch: AuthFetch,
  type: PublicLinkTargetType,
  targetId: string,
  expiresAt: string | null,
): Promise<CreatedPublicLink> {
  const response = await authFetch(
    getTargetPath(type, targetId),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expiresAt,
      }),
    },
  );

  return readJson<CreatedPublicLink>(
    response,
  );
}

export async function listPublicLinks(
  authFetch: AuthFetch,
  type: PublicLinkTargetType,
  targetId: string,
): Promise<PublicLink[]> {
  const response = await authFetch(
    getTargetPath(type, targetId),
  );

  return readJson<PublicLink[]>(response);
}

export async function revokePublicLink(
  authFetch: AuthFetch,
  type: PublicLinkTargetType,
  targetId: string,
  linkId: string,
): Promise<void> {
  const response = await authFetch(
    `${getTargetPath(
      type,
      targetId,
    )}/${encodeURIComponent(linkId)}`,
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

export function buildPublicLinkUrl(
  type: PublicLinkTargetType,
  token: string,
): string {
  const resource =
    type === 'folder'
      ? 'folders'
      : 'files';

  return `${
    window.location.origin
  }/public/${resource}/${encodeURIComponent(
    token,
  )}`;
}

async function publicFetch(
  path: string,
): Promise<Response> {
  return fetch(`${API_URL}${path}`);
}

export async function getPublicFile(
  token: string,
): Promise<PublicFile> {
  const response = await publicFetch(
    `/public/files/${encodeURIComponent(
      token,
    )}`,
  );

  return readJson<PublicFile>(response);
}

export async function createPublicFileDownload(
  token: string,
): Promise<PublicDownload> {
  const response = await publicFetch(
    `/public/files/${encodeURIComponent(
      token,
    )}/download`,
  );

  return readJson<PublicDownload>(response);
}

export async function getPublicFolder(
  token: string,
  folderId?: string,
): Promise<PublicFolderContents> {
  const tokenPath =
    `/public/folders/${encodeURIComponent(
      token,
    )}`;

  const path = folderId
    ? `${tokenPath}/folders/${encodeURIComponent(
        folderId,
      )}`
    : tokenPath;

  const response = await publicFetch(path);

  return readJson<PublicFolderContents>(
    response,
  );
}

export async function createPublicFolderFileDownload(
  token: string,
  fileId: string,
): Promise<PublicDownload> {
  const response = await publicFetch(
    `/public/folders/${encodeURIComponent(
      token,
    )}/files/${encodeURIComponent(
      fileId,
    )}/download`,
  );

  return readJson<PublicDownload>(response);
}