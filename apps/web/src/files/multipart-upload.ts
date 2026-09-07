import { ApiError } from '../auth/auth-api';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUploadPartUrl,
  getMultipartUploadStatus,
  initiateMultipartUpload,
  type AuthFetch,
  type MultipartUploadedPart,
  type MultipartUploadSession,
  type StoredFile,
  uploadMultipartPart,
} from './files-api';
import {
  createPersistedMultipartUpload,
  getPersistedMultipartUpload,
  removePersistedMultipartUpload,
  savePersistedMultipartUpload,
} from './multipart-upload-storage';

const SIMPLE_UPLOAD_MAX_SIZE_BYTES =
  10 * 1024 * 1024;

const DEFAULT_MULTIPART_CONCURRENCY = 3;
const DEFAULT_MAX_PART_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 2_000;

export interface MultipartUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  completedParts: number;
  totalParts: number;
  percent: number;
}

interface UploadLargeFileOptions {
  concurrency?: number;
  maxPartAttempts?: number;
  signal?: AbortSignal;
  onProgress?: (
    progress: MultipartUploadProgress,
  ) => void;
}

interface PreparedMultipartUpload {
  session: MultipartUploadSession;
  uploadedParts: MultipartUploadedPart[];
}

export function requiresMultipartUpload(
  file: File,
): boolean {
  return file.size >
    SIMPLE_UPLOAD_MAX_SIZE_BYTES;
}

function createAbortError(): DOMException {
  return new DOMException(
    'Multipart upload was cancelled',
    'AbortError',
  );
}

export function isMultipartUploadAbortError(
  error: unknown,
): boolean {
  return (
    error instanceof DOMException &&
    error.name === 'AbortError'
  );
}

function sleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const handleAbort = () => {
      window.clearTimeout(timeoutId);

      signal?.removeEventListener(
        'abort',
        handleAbort,
      );

      reject(createAbortError());
    };

    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener(
        'abort',
        handleAbort,
      );

      resolve();
    }, delayMs);

    signal?.addEventListener(
      'abort',
      handleAbort,
      { once: true },
    );
  });
}

function isRetryableUploadError(
  error: unknown,
): boolean {
  if (error instanceof ApiError) {
    return (
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }

  return error instanceof TypeError;
}

async function uploadPartWithRetry(
  authFetch: AuthFetch,
  sessionId: string,
  partNumber: number,
  part: Blob,
  maxAttempts: number,
  signal?: AbortSignal,
): Promise<void> {
  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    try {
      const partUrl =
        await createMultipartUploadPartUrl(
          authFetch,
          sessionId,
          partNumber,
          signal,
        );

      await uploadMultipartPart(
        partUrl.url,
        part,
        signal,
      );

      return;
    } catch (error) {
      if (
        isMultipartUploadAbortError(error)
      ) {
        throw error;
      }

      const canRetry =
        attempt < maxAttempts &&
        isRetryableUploadError(error);

      if (!canRetry) {
        throw error;
      }

      const retryDelay =
        RETRY_BASE_DELAY_MS *
        2 ** (attempt - 1);

      await sleep(
        retryDelay,
        signal,
      );
    }
  }
}

async function createFreshMultipartSession(
  authFetch: AuthFetch,
  file: File,
  folderId: string | null,
  signal?: AbortSignal,
): Promise<PreparedMultipartUpload> {
  const persistedUpload =
    createPersistedMultipartUpload(
      file,
      folderId,
    );

  /*
   * Сохраняем clientRequestId ДО запроса.
   *
   * Если сервер создаст сессию, но ответ потеряется
   * из-за сети или reload, этот clientRequestId
   * можно использовать повторно.
   */
  savePersistedMultipartUpload(
    file,
    folderId,
    persistedUpload,
  );

  const session =
    await initiateMultipartUpload(
      authFetch,
      {
        clientRequestId:
          persistedUpload.clientRequestId,
        fileName: file.name,
        mimeType:
          file.type || undefined,
        totalSize:
          file.size.toString(),
        folderId,
      },
      signal,
    );

  persistedUpload.sessionId = session.id;

  savePersistedMultipartUpload(
    file,
    folderId,
    persistedUpload,
  );

  return {
    session,
    uploadedParts: [],
  };
}

async function prepareMultipartUpload(
  authFetch: AuthFetch,
  file: File,
  folderId: string | null,
  signal?: AbortSignal,
): Promise<PreparedMultipartUpload> {
  let persistedUpload =
    getPersistedMultipartUpload(
      file,
      folderId,
    );

  if (!persistedUpload) {
    return createFreshMultipartSession(
      authFetch,
      file,
      folderId,
      signal,
    );
  }

  /*
   * Есть clientRequestId, но reload мог случиться
   * раньше, чем мы успели записать sessionId.
   *
   * Повторяем initiate с тем же ключом.
   * Backend сделает это идемпотентно.
   */
  if (!persistedUpload.sessionId) {
    const session =
      await initiateMultipartUpload(
        authFetch,
        {
          clientRequestId:
            persistedUpload.clientRequestId,
          fileName: file.name,
          mimeType:
            file.type || undefined,
          totalSize:
            file.size.toString(),
          folderId,
        },
        signal,
      );

    persistedUpload = {
      ...persistedUpload,
      sessionId: session.id,
    };

    savePersistedMultipartUpload(
      file,
      folderId,
      persistedUpload,
    );

    return {
      session,
      uploadedParts: [],
    };
  }

  try {
    const status =
      await getMultipartUploadStatus(
        authFetch,
        persistedUpload.sessionId,
        signal,
      );

    if (
      status.status === 'UPLOADING' ||
      status.status === 'COMPLETING' ||
      status.status === 'COMPLETED'
    ) {
      return {
        session: status,
        uploadedParts:
          status.uploadedParts,
      };
    }

    /*
     * ABORTED / EXPIRED / FAILED / CREATED
     * не продолжаем как существующую загрузку.
     */
    removePersistedMultipartUpload(
      file,
      folderId,
    );

    return createFreshMultipartSession(
      authFetch,
      file,
      folderId,
      signal,
    );
  } catch (error) {
    if (
      isMultipartUploadAbortError(error)
    ) {
      throw error;
    }

    /*
     * Локальная запись может пережить удаление
     * серверной сессии.
     */
    if (
      error instanceof ApiError &&
      error.status === 404
    ) {
      removePersistedMultipartUpload(
        file,
        folderId,
      );

      return createFreshMultipartSession(
        authFetch,
        file,
        folderId,
        signal,
      );
    }

    throw error;
  }
}

function readUploadedParts(
  parts: MultipartUploadedPart[],
  totalParts: number,
): {
  partNumbers: Set<number>;
  uploadedBytes: number;
} {
  const partNumbers = new Set<number>();
  let uploadedBytes = 0;

  for (const part of parts) {
    const size = Number(part.size);

    if (
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > totalParts ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(
        'Multipart upload status contains invalid part metadata',
      );
    }

    if (partNumbers.has(part.partNumber)) {
      continue;
    }

    partNumbers.add(part.partNumber);
    uploadedBytes += size;
  }

  return {
    partNumbers,
    uploadedBytes,
  };
}

export async function uploadLargeFile(
  authFetch: AuthFetch,
  file: File,
  folderId: string | null,
  options: UploadLargeFileOptions = {},
): Promise<StoredFile> {
  let activeSessionId: string | null = null;

  try {
    const prepared =
      await prepareMultipartUpload(
        authFetch,
        file,
        folderId,
        options.signal,
      );

    const session = prepared.session;

    activeSessionId = session.id;

    if (options.signal?.aborted) {
      throw createAbortError();
    }

    /*
     * Complete идемпотентен на backend.
     * Поэтому завершённую сессию можно безопасно
     * запросить ещё раз и получить существующий File.
     */
    if (
      session.status === 'COMPLETED' ||
      session.status === 'COMPLETING'
    ) {
      const completedFile =
        await completeMultipartUpload(
          authFetch,
          session.id,
        );

      removePersistedMultipartUpload(
        file,
        folderId,
      );

      return completedFile;
    }

    if (session.status !== 'UPLOADING') {
      throw new Error(
        `Multipart upload session has unexpected status: ${session.status}`,
      );
    }

    const partSize =
      Number(session.partSize);

    if (
      !Number.isSafeInteger(partSize) ||
      partSize <= 0
    ) {
      throw new Error(
        'Multipart upload part size is invalid',
      );
    }

    const requestedConcurrency =
      options.concurrency ??
      DEFAULT_MULTIPART_CONCURRENCY;

    const maxPartAttempts =
      options.maxPartAttempts ??
      DEFAULT_MAX_PART_ATTEMPTS;

    if (
      !Number.isInteger(
        requestedConcurrency,
      ) ||
      requestedConcurrency < 1
    ) {
      throw new Error(
        'Multipart upload concurrency is invalid',
      );
    }

    if (
      !Number.isInteger(maxPartAttempts) ||
      maxPartAttempts < 1
    ) {
      throw new Error(
        'Multipart upload retry attempts value is invalid',
      );
    }

    const {
      partNumbers: uploadedPartNumbers,
      uploadedBytes:
        initialUploadedBytes,
    } = readUploadedParts(
      prepared.uploadedParts,
      session.totalParts,
    );

    let nextPartNumber = 1;

    let completedParts =
      uploadedPartNumbers.size;

    let uploadedBytes =
      initialUploadedBytes;

    const reportProgress = () => {
      options.onProgress?.({
        uploadedBytes,
        totalBytes: file.size,
        completedParts,
        totalParts: session.totalParts,
        percent: Math.round(
          (uploadedBytes / file.size) * 100,
        ),
      });
    };

    reportProgress();

    const takeNextPartNumber =
      (): number | null => {
        while (
          nextPartNumber <=
            session.totalParts &&
          uploadedPartNumbers.has(
            nextPartNumber,
          )
        ) {
          nextPartNumber += 1;
        }

        if (
          nextPartNumber >
          session.totalParts
        ) {
          return null;
        }

        const selectedPartNumber =
          nextPartNumber;

        nextPartNumber += 1;

        return selectedPartNumber;
      };

    const workerCount = Math.min(
      requestedConcurrency,
      session.totalParts -
        uploadedPartNumbers.size,
    );

    const uploadWorker =
      async (): Promise<void> => {
        while (true) {
          if (options.signal?.aborted) {
            throw createAbortError();
          }

          const partNumber =
            takeNextPartNumber();

          if (partNumber === null) {
            return;
          }

          const start =
            (partNumber - 1) *
            partSize;

          const end = Math.min(
            start + partSize,
            file.size,
          );

          const part =
            file.slice(start, end);

          await uploadPartWithRetry(
            authFetch,
            session.id,
            partNumber,
            part,
            maxPartAttempts,
            options.signal,
          );

          uploadedPartNumbers.add(
            partNumber,
          );

          completedParts += 1;
          uploadedBytes += part.size;

          reportProgress();
        }
      };

    if (workerCount > 0) {
      await Promise.all(
        Array.from(
          { length: workerCount },
          () => uploadWorker(),
        ),
      );
    }

    if (options.signal?.aborted) {
      throw createAbortError();
    }

    const completedFile =
      await completeMultipartUpload(
        authFetch,
        session.id,
      );

    removePersistedMultipartUpload(
      file,
      folderId,
    );

    return completedFile;
  } catch (error) {
    if (
      isMultipartUploadAbortError(error)
    ) {
      if (activeSessionId) {
        try {
          await abortMultipartUpload(
            authFetch,
            activeSessionId,
          );
        } catch {
          // Пользователь уже отменил операцию.
          // Ошибка cleanup не должна подменять AbortError.
        }
      }

      removePersistedMultipartUpload(
        file,
        folderId,
      );
    }

    /*
     * При обычной сетевой ошибке запись специально
     * НЕ удаляем. Она нужна для следующего resume.
     */
    throw error;
  }
}