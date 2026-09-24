export interface PersistedMultipartUpload {
  clientRequestId: string;
  sessionId: string | null;
  fileName: string;
  fileSize: number;
  fileType: string;
  lastModified: number;
  folderId: string | null;
  targetFileId: string | null;
}

const STORAGE_KEY_PREFIX =
  'cloud-storage:multipart-upload:v1:';

function getStorageKey(
  file: File,
  folderId: string | null,
  targetFileId: string | null = null,
): string {
  /*
   * Для обычных загрузок сохраняем старый fingerprint.
   * Это позволяет не ломать уже существующее
   * resume-состояние Stage 3.
   */
  const fingerprint =
    targetFileId === null
      ? [
          file.name,
          file.size,
          file.type,
          file.lastModified,
          folderId,
        ]
      : [
          'version',
          targetFileId,
          file.name,
          file.size,
          file.type,
          file.lastModified,
        ];

  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(
    JSON.stringify(fingerprint),
  )}`;
}

function isPersistedMultipartUpload(
  value: unknown,
): value is Omit<
  PersistedMultipartUpload,
  'targetFileId'
> & {
  targetFileId?: string | null;
} {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false;
  }

  const upload = value as Record<string, unknown>;

  return (
    typeof upload.clientRequestId === 'string' &&
    (upload.sessionId === null ||
      typeof upload.sessionId === 'string') &&
    typeof upload.fileName === 'string' &&
    typeof upload.fileSize === 'number' &&
    typeof upload.fileType === 'string' &&
    typeof upload.lastModified === 'number' &&
    (upload.folderId === null ||
      typeof upload.folderId === 'string') &&
    (upload.targetFileId === undefined ||
      upload.targetFileId === null ||
      typeof upload.targetFileId === 'string')
  );
}

export function createPersistedMultipartUpload(
  file: File,
  folderId: string | null,
  targetFileId: string | null = null,
): PersistedMultipartUpload {
  return {
    clientRequestId: crypto.randomUUID(),
    sessionId: null,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    lastModified: file.lastModified,
    folderId,
    targetFileId,
  };
}

export function getPersistedMultipartUpload(
  file: File,
  folderId: string | null,
  targetFileId: string | null = null,
): PersistedMultipartUpload | null {
  const storageKey = getStorageKey(
    file,
    folderId,
    targetFileId,
  );

  const storedValue =
    window.localStorage.getItem(storageKey);

  if (!storedValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(storedValue) as unknown;

    if (!isPersistedMultipartUpload(parsed)) {
      window.localStorage.removeItem(storageKey);
      return null;
    }

    const normalized: PersistedMultipartUpload = {
      ...parsed,
      targetFileId:
        parsed.targetFileId ?? null,
    };

    /*
     * Дополнительная защита от использования локальной
     * записи не для того типа загрузки.
     */
    if (
      normalized.targetFileId !== targetFileId
    ) {
      window.localStorage.removeItem(storageKey);
      return null;
    }

    return normalized;
  } catch {
    window.localStorage.removeItem(storageKey);
    return null;
  }
}

export function savePersistedMultipartUpload(
  file: File,
  folderId: string | null,
  upload: PersistedMultipartUpload,
  targetFileId: string | null =
    upload.targetFileId,
): void {
  const storageKey = getStorageKey(
    file,
    folderId,
    targetFileId,
  );

  window.localStorage.setItem(
    storageKey,
    JSON.stringify(upload),
  );
}

export function removePersistedMultipartUpload(
  file: File,
  folderId: string | null,
  targetFileId: string | null = null,
): void {
  window.localStorage.removeItem(
    getStorageKey(
      file,
      folderId,
      targetFileId,
    ),
  );
}