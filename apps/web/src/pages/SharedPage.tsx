import {
  useEffect,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import '../App.css';
import { ApiError } from '../auth/auth-api';
import { useAuth } from '../auth/useAuth';
import {
  listSharedFiles,
  listSharedFolders,
  type SharedFile,
  type SharedFolder,
  type ShareRole,
} from '../access/sharing-api';
import { createFileDownload } from '../files/files-api';

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

function FileIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 48"
      width="48"
      height="48"
    >
      <path
        d="M11 5h17l9 9v27a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
        fill="currentColor"
      />
      <path
        d="M28 5v9h9"
        fill="rgb(255 255 255 / 45%)"
      />
      <path
        d="M16 25h14M16 31h14"
        fill="none"
        stroke="white"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function roleLabel(role: ShareRole): string {
  return role === 'EDITOR'
    ? 'Редактирование'
    : 'Просмотр';
}

function formatFileSize(
  size: string | null,
): string {
  if (size === null) {
    return 'Размер неизвестен';
  }

  const bytes = Number(size);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Размер неизвестен';
  }

  if (bytes < 1024) {
    return `${bytes} Б`;
  }

  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} КиБ`;
  }

  return `${(bytes / 1024 ** 2).toFixed(1)} МиБ`;
}

export function SharedPage() {
  const {
    user,
    logout,
    authFetch,
  } = useAuth();

  const navigate = useNavigate();

  const [folders, setFolders] =
    useState<SharedFolder[]>([]);
  const [files, setFiles] =
    useState<SharedFile[]>([]);

  const [isLoading, setIsLoading] =
    useState(true);
  const [isLoggingOut, setIsLoggingOut] =
    useState(false);
  const [downloadingFileId, setDownloadingFileId] =
    useState<string | null>(null);

  const [reloadVersion, setReloadVersion] =
    useState(0);
  const [error, setError] =
    useState<string | null>(null);

  const userLabel =
    user?.displayName ||
    user?.email ||
    'Пользователь';

  const userInitial =
    userLabel.charAt(0).toUpperCase();

  useEffect(() => {
    let active = true;

    setIsLoading(true);
    setError(null);

    void Promise.all([
      listSharedFolders(authFetch),
      listSharedFiles(authFetch),
    ])
      .then(
        ([
          loadedFolders,
          loadedFiles,
        ]) => {
          if (!active) {
            return;
          }

          setFolders(loadedFolders);
          setFiles(loadedFiles);
        },
      )
      .catch((requestError: unknown) => {
        if (!active) {
          return;
        }

        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Не удалось загрузить доступные ресурсы',
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
    reloadVersion,
  ]);

  const handleDownload = async (
    file: SharedFile,
  ) => {
    setDownloadingFileId(file.id);
    setError(null);

    try {
      const download =
        await createFileDownload(
          authFetch,
          file.id,
        );

      const link =
        document.createElement('a');

      link.href = download.url;
      link.rel = 'noopener noreferrer';

      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (requestError: unknown) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Не удалось скачать файл',
      );
    } finally {
      setDownloadingFileId(null);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setError(null);

    try {
  await logout();

  navigate('/login', {
    replace: true,
  });
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

  return (
    <main className="file-manager">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">
            C
          </div>

          <div>
            <strong>
              Cloud Storage
            </strong>
            <span>
              Личное пространство
            </span>
          </div>
        </div>

        <nav
          className="sidebar-nav"
          aria-label="Основная навигация"
        >
          <button
            className="sidebar-nav__item"
            type="button"
            onClick={() => navigate('/')}
          >
            <span className="sidebar-nav__icon">
              ▰
            </span>
            Мои файлы
          </button>

          <button
            className="sidebar-nav__item sidebar-nav__item--active"
            type="button"
          >
            <span className="sidebar-nav__icon">
              ◈
            </span>
            Доступные мне
          </button>
        </nav>

        <div className="sidebar__spacer" />

        <div className="sidebar-account">
          <div className="avatar">
            {userInitial}
          </div>

          <div className="sidebar-account__identity">
            <strong>
              {userLabel}
            </strong>
            <span>
              {user?.email}
            </span>
          </div>

          <button
            className="icon-button"
            type="button"
            title="Выйти"
            aria-label="Выйти"
            disabled={isLoggingOut}
            onClick={() =>
              void handleLogout()
            }
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

            <h1>
              Доступные мне
            </h1>
          </div>
        </header>

        <div className="content-heading">
          <div>
            <h2>Папки</h2>

            {!isLoading && (
              <span>
                {folders.length}
              </span>
            )}
          </div>

          <button
            className="refresh-button"
            type="button"
            disabled={isLoading}
            onClick={() =>
              setReloadVersion(
                (version) =>
                  version + 1,
              )
            }
          >
            Обновить
          </button>
        </div>

        {error && (
          <div
            className="workspace-error"
            role="alert"
          >
            <div>
              <strong>
                Не удалось выполнить операцию
              </strong>
              <span>{error}</span>
            </div>
          </div>
        )}

        {isLoading ? (
          <div
            className="folder-grid"
            aria-label="Загрузка папок"
          >
            {Array.from(
              { length: 4 },
              (_, index) => (
                <div
                  className="folder-skeleton"
                  key={index}
                >
                  <span />
                  <span />
                </div>
              ),
            )}
          </div>
        ) : folders.length > 0 ? (
          <div className="folder-grid">
            {folders.map((folder) => (
              <article
                className="folder-card"
                key={folder.id}
              >
                <button
                  className="folder-card__open"
                  type="button"
                  onClick={() =>
                    navigate(
                      `/shared/folders/${encodeURIComponent(
                        folder.id,
                      )}`,
                    )
                  }
                >
                  <span className="folder-card__icon">
                    <FolderIcon />
                  </span>

                  <span className="folder-card__content">
                    <strong>
                      {folder.name}
                    </strong>

                    <span>
                      {roleLabel(
                        folder.role,
                      )}
                    </span>
                  </span>
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state__icon">
              <FolderIcon />
            </div>

            <h2>
              Нет доступных папок
            </h2>

            <p>
              Папки, которыми с вами
              поделятся другие пользователи,
              появятся здесь.
            </p>
          </div>
        )}

        {!isLoading && files.length > 0 && (
          <>
            <div className="content-heading content-heading--files">
              <div>
                <h2>Файлы</h2>
                <span>
                  {files.length}
                </span>
              </div>
            </div>

            <div className="file-grid">
              {files.map((file) => (
                <article
                  className="file-card"
                  key={file.id}
                >
                  <span className="file-card__icon">
                    <FileIcon />
                  </span>

                  <span className="file-card__content">
                    <strong
                      title={file.name}
                    >
                      {file.name}
                    </strong>

                    <span>
                      {roleLabel(file.role)}
                      {' · '}
                      {formatFileSize(
                        file.size,
                      )}
                    </span>
                  </span>

                  <div className="folder-card__actions">
                    <button
                      className="folder-card__menu-button"
                      type="button"
                      title="Скачать"
                      aria-label={`Скачать ${file.name}`}
                      disabled={
                        file.status !==
                          'READY' ||
                        downloadingFileId ===
                          file.id
                      }
                      onClick={() =>
                        void handleDownload(
                          file,
                        )
                      }
                    >
                      {downloadingFileId ===
                      file.id
                        ? '…'
                        : '↓'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}