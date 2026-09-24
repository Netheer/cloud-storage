import {
  useEffect,
  useState,
} from 'react';
import { ApiError } from '../auth/auth-api';
import {
  createFileVersionDownload,
  listFileVersions,
  restoreFileVersion,
  type AuthFetch,
  type StoredFile,
  type StoredFileVersion,
} from './files-api';

interface FileVersionsDialogProps {
  authFetch: AuthFetch;
  file: StoredFile;
  onClose: () => void;
  onRestored: () => void;
}

function formatVersionSize(size: string): string {
  const bytes = Number(size);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Неизвестный размер';
  }

  if (bytes < 1024) {
    return `${bytes} Б`;
  }

  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} КиБ`;
  }

  return `${(bytes / 1024 ** 2).toFixed(1)} МиБ`;
}

function formatVersionDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function FileVersionsDialog({
  authFetch,
  file,
  onClose,
  onRestored,
}: FileVersionsDialogProps) {
  const [versions, setVersions] = useState<
    StoredFileVersion[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] =
    useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [
    downloadingVersionId,
    setDownloadingVersionId,
  ] = useState<string | null>(null);
  const [
    restoringVersionId,
    setRestoringVersionId,
  ] = useState<string | null>(null);
  const [actionError, setActionError] =
    useState<string | null>(null);

  useEffect(() => {
    let active = true;

    setIsLoading(true);
    setLoadError(null);

    void listFileVersions(authFetch, file.id)
      .then((loadedVersions) => {
        if (active) {
          setVersions(loadedVersions);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setLoadError(
          error instanceof ApiError
            ? error.message
            : 'Не удалось загрузить историю версий',
        );
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    authFetch,
    file.id,
    reloadVersion,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        restoringVersionId === null
      ) {
        onClose();
      }
    };

    window.addEventListener(
      'keydown',
      handleKeyDown,
    );

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      );
    };
  }, [onClose, restoringVersionId]);

  const handleDownload = async (
    version: StoredFileVersion,
  ) => {
    setDownloadingVersionId(version.id);
    setActionError(null);

    try {
      const download =
        await createFileVersionDownload(
          authFetch,
          file.id,
          version.id,
        );

      const link = document.createElement('a');

      link.href = download.url;
      link.rel = 'noopener noreferrer';

      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      setActionError(
        error instanceof ApiError
          ? error.message
          : 'Не удалось скачать версию файла',
      );
    } finally {
      setDownloadingVersionId(null);
    }
  };

  const handleRestore = async (
    version: StoredFileVersion,
  ) => {
    setRestoringVersionId(version.id);
    setActionError(null);

    try {
      await restoreFileVersion(
        authFetch,
        file.id,
        version.id,
      );

      onRestored();
      onClose();
    } catch (error) {
      setActionError(
        error instanceof ApiError
          ? error.message
          : 'Не удалось восстановить версию файла',
      );

      setReloadVersion(
        (current) => current + 1,
      );
    } finally {
      setRestoringVersionId(null);
    }
  };

  return (
    <div
      className="versions-dialog-backdrop"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          restoringVersionId === null
        ) {
          onClose();
        }
      }}
    >
      <section
        className="versions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="versions-dialog-title"
      >
        <header className="versions-dialog__header">
          <div>
            <p>Файл</p>
            <h2 id="versions-dialog-title">
              История версий
            </h2>
            <span>{file.name}</span>
          </div>

          <button
            className="versions-dialog__close"
            type="button"
            aria-label="Закрыть"
            disabled={restoringVersionId !== null}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {actionError && (
          <div
            className="versions-dialog__error"
            role="alert"
          >
            {actionError}
          </div>
        )}

        <div className="versions-dialog__content">
          {isLoading ? (
            <p className="versions-dialog__status">
              Загружаем историю…
            </p>
          ) : loadError ? (
            <div
              className="versions-dialog__load-error"
              role="alert"
            >
              <span>{loadError}</span>

              <button
                type="button"
                onClick={() =>
                  setReloadVersion(
                    (current) => current + 1,
                  )
                }
              >
                Повторить
              </button>
            </div>
          ) : versions.length === 0 ? (
            <p className="versions-dialog__status">
              Версии файла не найдены.
            </p>
          ) : (
            <div className="versions-list">
              {versions.map((version) => (
                <article
                  className="version-row"
                  key={version.id}
                >
                  <div className="version-row__info">
                    <div className="version-row__title">
                      <strong>
                        Версия {version.versionNumber}
                      </strong>

                      {version.isCurrent && (
                        <span className="version-row__current">
                          Текущая
                        </span>
                      )}
                    </div>

                    <span>
                      {version.originalName}
                    </span>

                    <span>
                      {formatVersionSize(version.size)}
                      {' · '}
                      {formatVersionDate(
                        version.createdAt,
                      )}
                    </span>
                  </div>

                  <div className="version-row__actions">
                    <button
                      type="button"
                      disabled={
                        downloadingVersionId ===
                          version.id ||
                        restoringVersionId !== null
                      }
                      onClick={() =>
                        void handleDownload(version)
                      }
                    >
                      {downloadingVersionId ===
                      version.id
                        ? 'Скачиваем…'
                        : 'Скачать'}
                    </button>

                    {!version.isCurrent && (
                      <button
                        type="button"
                        disabled={
                          restoringVersionId !== null ||
                          downloadingVersionId !== null
                        }
                        onClick={() =>
                          void handleRestore(version)
                        }
                      >
                        {restoringVersionId ===
                        version.id
                          ? 'Восстанавливаем…'
                          : 'Восстановить'}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}