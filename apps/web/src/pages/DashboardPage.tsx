import {
  useEffect,
  useState,
} from 'react';
import '../App.css';
import { ApiError } from '../auth/auth-api';
import { useAuth } from '../auth/useAuth';
import {
  createFolder,
  listFolders,
  type Folder,
  renameFolder,
  deleteFolder,
  moveFolder,
} from '../folders/folders-api';
import { FolderNameDialog } from '../folders/FolderNameDialog';
import { DeleteFolderDialog } from '../folders/DeleteFolderDialog';
import { MoveFolderDialog } from '../folders/MoveFolderDialog';

type Breadcrumb = {
  id: string;
  name: string;
};

function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 48"
      width="48"
      height="48"
    >
      <path
        d="M5 12.5A4.5 4.5 0 0 1 9.5 8h9.2c1.4 0 2.7.7 3.5 1.8l2.2 3.2h14.1a4.5 4.5 0 0 1 4.5 4.5v18a4.5 4.5 0 0 1-4.5 4.5h-29A4.5 4.5 0 0 1 5 35.5v-23Z"
        fill="currentColor"
      />
      <path
        d="M5 18h38"
        fill="none"
        stroke="rgb(255 255 255 / 35%)"
        strokeWidth="2"
      />
    </svg>
  );
}

function folderCountLabel(count: number): string {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return `${count} папок`;
  }

  if (lastDigit === 1) {
    return `${count} папка`;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return `${count} папки`;
  }

  return `${count} папок`;
}

function DashboardPage() {
  const { user, logout, authFetch } = useAuth();

  const [breadcrumbs, setBreadcrumbs] = useState<
    Breadcrumb[]
  >([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] =
  useState(false);
  const [dialogError, setDialogError] =
    useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] =
    useState<string | null>(null);
  const [folderToRename, setFolderToRename] =
    useState<Folder | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] =
    useState<string | null>(null);
  const [folderToDelete, setFolderToDelete] =
    useState<Folder | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] =
    useState<string | null>(null);
  const currentFolder =
    breadcrumbs[breadcrumbs.length - 1] ?? null;
  const currentParentId = currentFolder?.id ?? null;
  const [folderToMove, setFolderToMove] =
    useState<Folder | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] =
    useState<string | null>(null);

  const userLabel =
    user?.displayName || user?.email || 'Пользователь';
  const userInitial = userLabel.charAt(0).toUpperCase();

  useEffect(() => {
    let active = true;

    setIsLoading(true);
    setError(null);

    void listFolders(authFetch, currentParentId)
      .then((loadedFolders) => {
        if (active) {
          setFolders(loadedFolders);
        }
      })
      .catch((requestError: unknown) => {
        if (!active) {
          return;
        }

        setError(
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
  }, [authFetch, currentParentId, reloadVersion]);

  const handleCreateFolder = async (name: string) => {
    setIsCreating(true);
    setDialogError(null);

    try {
      await createFolder(authFetch, name, currentParentId);
      setIsCreateDialogOpen(false);
      setReloadVersion((version) => version + 1);
    } catch (requestError) {
      setDialogError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Не удалось создать папку',
      );
    } finally {
      setIsCreating(false);
    } 
  };

  const handleOpenRenameDialog = (folder: Folder) => {
  setActiveMenuId(null);
  setRenameError(null);
  setFolderToRename(folder);
};

const handleRenameFolder = async (name: string) => {
  if (!folderToRename) {
    return;
  }

  setIsRenaming(true);
  setRenameError(null);

  try {
    await renameFolder(authFetch, folderToRename.id, name);
    setFolderToRename(null);
    setReloadVersion((version) => version + 1);
  } catch (requestError) {
    setRenameError(
      requestError instanceof ApiError
        ? requestError.message
        : 'Не удалось переименовать папку',
    );
  } finally {
    setIsRenaming(false);
  }
};

const handleOpenCreateDialog = () => {
  setDialogError(null);
  setIsCreateDialogOpen(true);
};

  const handleOpenFolder = (folder: Folder) => {
    setBreadcrumbs((current) => [
      ...current,
      {
        id: folder.id,
        name: folder.name,
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

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setError(null);

    try {
      await logout();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Не удалось выполнить выход',
      );
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleOpenDeleteDialog = (folder: Folder) => {
    setActiveMenuId(null);
    setDeleteError(null);
    setFolderToDelete(folder);
  };

  const handleDeleteFolder = async () => {
    if (!folderToDelete) {
      return;
    }

    setIsDeleting(true);
    setDeleteError(null);

    try {
      await deleteFolder(authFetch, folderToDelete.id);
      setFolderToDelete(null);
      setReloadVersion((version) => version + 1);
    } catch (requestError) {
      if (
        requestError instanceof ApiError &&
        (requestError.status === 400 ||
          requestError.status === 409)
      ) {
        setDeleteError(
          'Папка не пуста. Сначала удалите или переместите её содержимое.',
        );
      } else {
        setDeleteError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Не удалось удалить папку',
        );
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handleOpenMoveDialog = (folder: Folder) => {
  setActiveMenuId(null);
  setMoveError(null);
  setFolderToMove(folder);
  };

  const handleMoveFolder = async (
    parentId: string | null,
  ) => {
    if (!folderToMove) {
      return;
    }

    setIsMoving(true);
    setMoveError(null);

    try {
      await moveFolder(
        authFetch,
        folderToMove.id,
        parentId,
      );

      setFolderToMove(null);
      setReloadVersion((version) => version + 1);
    } catch (requestError) {
      if (
        requestError instanceof ApiError &&
        requestError.status === 400
      ) {
        setMoveError(
          'Нельзя переместить папку в саму себя или в одну из её вложенных папок.',
        );
      } else {
        setMoveError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Не удалось переместить папку',
        );
      }
    } finally {
      setIsMoving(false);
    }
  };

  return (
    <main className="file-manager">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">C</div>
          <div>
            <strong>Cloud Storage</strong>
            <span>Личное пространство</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Основная навигация">
          <button className="sidebar-nav__item sidebar-nav__item--active">
            <span className="sidebar-nav__icon">▰</span>
            Мои файлы
          </button>
        </nav>

        <div className="sidebar__spacer" />

        <div className="sidebar-account">
          <div className="avatar">{userInitial}</div>
          <div className="sidebar-account__identity">
            <strong>{userLabel}</strong>
            <span>{user?.email}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            title="Выйти"
            aria-label="Выйти"
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
          >
            ↪
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="workspace-header__eyebrow">
              Файловый менеджер
            </p>
            <h1>{currentFolder?.name ?? 'Мои файлы'}</h1>
          </div>

          <button
            className="primary-button"
            type="button"
            onClick={handleOpenCreateDialog}
            disabled={isCreating}
          >
            <span aria-hidden="true">＋</span>
            {isCreating ? 'Создаём…' : 'Новая папка'}
          </button>
        </header>

        <nav className="breadcrumbs" aria-label="Путь к папке">
          <button
            type="button"
            className={
              breadcrumbs.length === 0
                ? 'breadcrumbs__item breadcrumbs__item--current'
                : 'breadcrumbs__item'
            }
            onClick={handleOpenRoot}
          >
            Мои файлы
          </button>

          {breadcrumbs.map((breadcrumb, index) => (
            <span
              className="breadcrumbs__segment"
              key={breadcrumb.id}
            >
              <span className="breadcrumbs__separator">/</span>
              <button
                type="button"
                className={
                  index === breadcrumbs.length - 1
                    ? 'breadcrumbs__item breadcrumbs__item--current'
                    : 'breadcrumbs__item'
                }
                onClick={() =>
                  handleOpenBreadcrumb(index)
                }
              >
                {breadcrumb.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="content-heading">
          <div>
            <h2>Папки</h2>
            {!isLoading && (
              <span>{folderCountLabel(folders.length)}</span>
            )}
          </div>

          <button
            className="refresh-button"
            type="button"
            onClick={() =>
              setReloadVersion((version) => version + 1)
            }
            disabled={isLoading}
          >
            Обновить
          </button>
        </div>

        {error && (
          <div className="workspace-error" role="alert">
            <div>
              <strong>Не удалось выполнить операцию</strong>
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                setReloadVersion((version) => version + 1)
              }
            >
              Повторить
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="folder-grid" aria-label="Загрузка папок">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="folder-skeleton" key={index}>
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : folders.length > 0 ? (
          <div className="folder-grid">
            {folders.map((folder) => (
  <article className="folder-card" key={folder.id}>
    <button
      className="folder-card__open"
      type="button"
      onClick={() => handleOpenFolder(folder)}
    >
      <span className="folder-card__icon">
        <FolderIcon />
      </span>

      <span className="folder-card__content">
        <strong>{folder.name}</strong>
        <span>Открыть папку</span>
      </span>
    </button>

    <div className="folder-card__actions">
      <button
        className="folder-card__menu-button"
        type="button"
        aria-label={`Действия с папкой ${folder.name}`}
        aria-expanded={activeMenuId === folder.id}
        onClick={() =>
          setActiveMenuId((currentId) =>
            currentId === folder.id ? null : folder.id,
          )
        }
      >
        ⋯
      </button>

      {activeMenuId === folder.id && (
        <div className="folder-card__menu">
          <button
            type="button"
            onClick={() => handleOpenRenameDialog(folder)}
          >
            Переименовать
          </button>

          <button
            type="button"
            onClick={() => handleOpenMoveDialog(folder)}
          >
            Переместить
          </button>

          <button
          className="folder-card__delete-action"
          type="button"
          onClick={() => handleOpenDeleteDialog(folder)}
        >
          Удалить
        </button>
        </div>
      )}
    </div>
  </article>
))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state__icon">
              <FolderIcon />
            </div>
            <h2>Здесь пока пусто</h2>
            <p>
              Создайте папку, чтобы начать организовывать
              свои файлы.
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={handleOpenCreateDialog}
              disabled={isCreating}
            >
              ＋ Новая папка
            </button>
          </div>
        )}
      </section>
        {isCreateDialogOpen && (
    <FolderNameDialog
      title="Новая папка"
      submitLabel="Создать"
      isSubmitting={isCreating}
      error={dialogError}
      onClose={() => setIsCreateDialogOpen(false)}
      onSubmit={handleCreateFolder}
    />
  )}

  {folderToRename && (
  <FolderNameDialog
    title="Переименовать папку"
    initialName={folderToRename.name}
    submitLabel="Сохранить"
    isSubmitting={isRenaming}
    error={renameError}
    onClose={() => {
      if (!isRenaming) {
        setFolderToRename(null);
        setRenameError(null);
      }
    }}
    onSubmit={handleRenameFolder}
  />
)}

  {folderToDelete && (
    <DeleteFolderDialog
      folderName={folderToDelete.name}
      isSubmitting={isDeleting}
      error={deleteError}
      onClose={() => {
        if (!isDeleting) {
          setFolderToDelete(null);
          setDeleteError(null);
        }
      }}
      onConfirm={handleDeleteFolder}
    />
  )}

  {folderToMove && (
    <MoveFolderDialog
      folder={folderToMove}
      isSubmitting={isMoving}
      error={moveError}
      onClose={() => {
        if (!isMoving) {
          setFolderToMove(null);
          setMoveError(null);
        }
      }}
      onMove={handleMoveFolder}
    />
  )}
    </main>
  );
}

export default DashboardPage;