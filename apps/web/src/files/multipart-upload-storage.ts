export interface PersistedMultipartUpload {
  clientRequestId: string;
  sessionId: string | null;
  fileName: string;
  fileSize: number;
  fileType: string;
  lastModified: number;
  folderId: string | null;
}

const STORAGE_PREFIX =
  'cloud-storage:multipart-upload:v1';

function getStorageKey(
  file: File,
  folderId: string | null,
): string {
  const fingerprint = JSON.stringify([
    file.name,
    file.size,
    file.type,
    file.lastModified,
    folderId,
  ]);

  return `${STORAGE_PREFIX}:${encodeURIComponent(fingerprint)}`;
}

function isPersistedMultipartUpload(
  value: unknown,
): value is PersistedMultipartUpload {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.clientRequestId === 'string' &&
    (
      typeof record.sessionId === 'string' ||
      record.sessionId === null
    ) &&
    typeof record.fileName === 'string' &&
    typeof record.fileSize === 'number' &&
    typeof record.fileType === 'string' &&
    typeof record.lastModified === 'number' &&
    (
      typeof record.folderId === 'string' ||
      record.folderId === null
    )
  );
}

export function createPersistedMultipartUpload(
  file: File,
  folderId: string | null,
): PersistedMultipartUpload {
  return {
    clientRequestId: crypto.randomUUID(),
    sessionId: null,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    lastModified: file.lastModified,
    folderId,
  };
}

export function getPersistedMultipartUpload(
  file: File,
  folderId: string | null,
): PersistedMultipartUpload | null {
  const rawValue = localStorage.getItem(
    getStorageKey(file, folderId),
  );

  if (!rawValue) {
    return null;
  }

  try {
    const value = JSON.parse(rawValue) as unknown;

    if (!isPersistedMultipartUpload(value)) {
      removePersistedMultipartUpload(
        file,
        folderId,
      );

      return null;
    }

    return value;
  } catch {
    removePersistedMultipartUpload(
      file,
      folderId,
    );

    return null;
  }
}

export function savePersistedMultipartUpload(
  file: File,
  folderId: string | null,
  upload: PersistedMultipartUpload,
): void {
  localStorage.setItem(
    getStorageKey(file, folderId),
    JSON.stringify(upload),
  );
}

export function removePersistedMultipartUpload(
  file: File,
  folderId: string | null,
): void {
  localStorage.removeItem(
    getStorageKey(file, folderId),
  );
}