import { useEffect, useState } from 'react';
import { ApiError } from '../auth/auth-api';
import { useAuth } from '../auth/useAuth';
import { listFolders, type Folder } from './folders-api';

interface MoveFolderDialogProps {
  itemName: string;
  itemType: 'folder' | 'file';
  currentFolderId: string | null;
  excludedFolderId?: string;
  isSubmitting: boolean;
  error: string | null;
  onClose: () => void;
  onMove: (folderId: string | null) => Promise<void>;
}

interface DestinationBreadcrumb {
  id: string;
  name: string;
}

export function MoveFolderDialog({
  itemName,
  itemType,
  currentFolderId,
  excludedFolderId,
  isSubmitting,
  error,
  onClose,
  onMove,
}: MoveFolderDialogProps) {
  const { authFetch } = useAuth();

  const [breadcrumbs, setBreadcrumbs] = useState<
    DestinationBreadcrumb[]
  >([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] =
    useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  const currentFolder =
    breadcrumbs[breadcrumbs.length - 1] ?? null;
  const destinationId = currentFolder?.id ?? null;
  const isCurrentLocation =
    destinationId === currentFolderId;

  useEffect(() => {
    let active = true;

    setIsLoading(true);
    setLoadError(null);

    void listFolders(authFetch, destinationId)
      .then((loadedFolders) => {
        if (active) {
          setFolders(
  excludedFolderId
    ? loadedFolders.filter(
        (candidate) =>
          candidate.id !== excludedFolderId,
      )
    : loadedFolders,
);
        }
      })
      .catch((requestError: unknown) => {
        if (!active) {
          return;
        }

        setLoadError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Не удалось загрузить папки',
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
    destinationId,
    excludedFolderId,
    reloadVersion,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSubmitting, onClose]);

  const handleOpenFolder = (destination: Folder) => {
    setBreadcrumbs((current) => [
      ...current,
      {
        id: destination.id,
        name: destination.name,
      },
    ]);
  };

  const handleOpenRoot = () => {
    setBreadcrumbs([]);
  };

  const handleOpenBreadcrumb = (index: number) => {
    setBreadcrumbs((current) =>
      current.slice(0, index + 1),
    );
  };

  return (
    <div
      className="move-dialog-backdrop"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          !isSubmitting
        ) {
          onClose();
        }
      }}
    >
      <section
        className="move-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-dialog-title"
      >
        <header className="move-dialog__header">
          <div>
            <h2 id="move-dialog-title">
  {itemType === 'file'
    ? 'Переместить файл'
    : 'Переместить папку'}
</h2>

<p>
  Выберите новое расположение для
  <strong> «{itemName}»</strong>.
</p>
          </div>

          <button
            type="button"
            className="move-dialog__close"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={isSubmitting}
          >
            ×
          </button>
        </header>

        <nav
          className="move-dialog__breadcrumbs"
          aria-label="Папка назначения"
        >
          <button type="button" onClick={handleOpenRoot}>
            Мои файлы
          </button>

          {breadcrumbs.map((breadcrumb, index) => (
            <span key={breadcrumb.id}>
              <span>/</span>
              <button
                type="button"
                onClick={() =>
                  handleOpenBreadcrumb(index)
                }
              >
                {breadcrumb.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="move-dialog__browser">
          {isLoading ? (
            <p className="move-dialog__status">
              Загружаем папки…
            </p>
          ) : loadError ? (
            <div
              className="move-dialog__load-error"
              role="alert"
            >
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() =>
                  setReloadVersion(
                    (version) => version + 1,
                  )
                }
              >
                Повторить
              </button>
            </div>
          ) : folders.length > 0 ? (
            <div className="move-dialog__folder-list">
              {folders.map((destination) => (
                <button
                  type="button"
                  key={destination.id}
                  onClick={() =>
                    handleOpenFolder(destination)
                  }
                >
                  <span aria-hidden="true">📁</span>
                  <strong>{destination.name}</strong>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="move-dialog__status">
              В этой папке нет вложенных папок.
            </p>
          )}
        </div>

        {error && (
          <div className="move-dialog__error" role="alert">
            {error}
          </div>
        )}

        <footer className="move-dialog__actions">
          <button
            type="button"
            className="move-dialog__cancel"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Отмена
          </button>

          <button
            type="button"
            className="move-dialog__confirm"
            onClick={() => void onMove(destinationId)}
            disabled={
              isSubmitting ||
              isLoading ||
              loadError !== null ||
              isCurrentLocation
            }
          >
            {isSubmitting
              ? 'Перемещаем…'
              : isCurrentLocation
                ? 'Уже находится здесь'
                : destinationId === null
                  ? 'Переместить в корень'
                  : 'Переместить сюда'}
          </button>
        </footer>
      </section>
    </div>
  );
}