import {
  useEffect,
  useState,
} from 'react';
import {
  useNavigate,
  useParams,
} from 'react-router';
import { ApiError } from '../auth/auth-api';
import {
  createPublicFolderFileDownload,
  getPublicFolder,
  type PublicFolderContents,
  type PublicFolderFile,
  type PublicFolderItem,
} from '../access/public-links-api';

function formatFileSize(
  size: string,
): string {
  const bytes = Number(size);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Размер неизвестен';
  }

  if (bytes < 1024) {
    return `${bytes} Б`;
  }

  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(
      1,
    )} КиБ`;
  }

  if (bytes < 1024 ** 3) {
    return `${(
      bytes /
      1024 ** 2
    ).toFixed(1)} МиБ`;
  }

  return `${(
    bytes /
    1024 ** 3
  ).toFixed(1)} ГиБ`;
}

function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 48"
      width="44"
      height="44"
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
      width="40"
      height="40"
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

async function loadBreadcrumbs(
  token: string,
  currentContents: PublicFolderContents,
): Promise<PublicFolderItem[]> {
  const breadcrumbs: PublicFolderItem[] = [
    currentContents.folder,
  ];

  let parentId =
    currentContents.folder.parentId;

  while (parentId !== null) {
    const parentContents =
      await getPublicFolder(
        token,
        parentId,
      );

    breadcrumbs.unshift(
      parentContents.folder,
    );

    parentId =
      parentContents.folder.parentId;
  }

  return breadcrumbs;
}

export function PublicFolderPage() {
  const {
    token,
    folderId,
  } = useParams<{
    token: string;
    folderId?: string;
  }>();

  const navigate = useNavigate();

  const [contents, setContents] =
    useState<PublicFolderContents | null>(
      null,
    );

  const [breadcrumbs, setBreadcrumbs] =
    useState<PublicFolderItem[]>([]);

  const [isLoading, setIsLoading] =
    useState(true);

  const [
    downloadingFileId,
    setDownloadingFileId,
  ] = useState<string | null>(null);

  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!token) {
      setError(
        'Публичная ссылка недействительна',
      );

      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    setContents(null);

    const load = async () => {
      const loadedContents =
        await getPublicFolder(
          token,
          folderId,
        );

      const loadedBreadcrumbs =
        await loadBreadcrumbs(
          token,
          loadedContents,
        );

      if (!active) {
        return;
      }

      setContents(loadedContents);
      setBreadcrumbs(
        loadedBreadcrumbs,
      );
    };

    void load()
      .catch(
        (requestError: unknown) => {
          if (!active) {
            return;
          }

          if (
            requestError instanceof
              ApiError &&
            requestError.status === 404
          ) {
            setError(
              'Ссылка недоступна. Возможно, она истекла или была отозвана.',
            );
          } else {
            setError(
              requestError instanceof
                ApiError
                ? requestError.message
                : 'Не удалось открыть публичную папку',
            );
          }
        },
      )
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [folderId, token]);

  const navigateToFolder = (
    folder: PublicFolderItem,
  ) => {
    if (!token || !contents) {
      return;
    }

    if (
      folder.id ===
      contents.rootFolderId
    ) {
      navigate(
        `/public/folders/${encodeURIComponent(
          token,
        )}`,
      );

      return;
    }

    navigate(
      `/public/folders/${encodeURIComponent(
        token,
      )}/folders/${encodeURIComponent(
        folder.id,
      )}`,
    );
  };

  const handleDownload = async (
    file: PublicFolderFile,
  ) => {
    if (!token) {
      return;
    }

    setDownloadingFileId(file.id);
    setError(null);

    try {
      const download =
        await createPublicFolderFileDownload(
          token,
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
      if (
        requestError instanceof ApiError &&
        requestError.status === 404
      ) {
        setError(
          'Файл или публичная ссылка больше недоступны.',
        );
      } else {
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Не удалось скачать файл',
        );
      }
    } finally {
      setDownloadingFileId(null);
    }
  };

  return (
    <main className="public-page">
      <div className="public-page__brand">
        <div className="brand__mark">
          C
        </div>

        <div>
          <strong>
            Cloud Storage
          </strong>

          <span>
            Публичный доступ
          </span>
        </div>
      </div>

      <section className="public-folder">
        {isLoading ? (
          <div className="public-resource__status">
            <div className="public-resource__loader" />

            <p>
              Загружаем папку…
            </p>
          </div>
        ) : error && !contents ? (
          <div className="public-resource__status">
            <div className="public-resource__icon">
              !
            </div>

            <h1>
              Папка недоступна
            </h1>

            <p>{error}</p>
          </div>
        ) : contents ? (
          <>
            <header className="public-folder__header">
              <div>
                <p className="public-resource__eyebrow">
                  Публичная папка
                </p>

                <h1>
                  {contents.folder.name}
                </h1>
              </div>

              <div className="public-folder__header-icon">
                <FolderIcon />
              </div>
            </header>

            <nav
              className="public-folder__breadcrumbs"
              aria-label="Путь папки"
            >
              {breadcrumbs.map(
                (
                  breadcrumb,
                  index,
                ) => (
                  <span
                    key={
                      breadcrumb.id
                    }
                  >
                    {index > 0 && (
                      <span
                        aria-hidden="true"
                      >
                        /
                      </span>
                    )}

                    {index ===
                    breadcrumbs.length -
                      1 ? (
                      <strong>
                        {
                          breadcrumb.name
                        }
                      </strong>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          navigateToFolder(
                            breadcrumb,
                          )
                        }
                      >
                        {
                          breadcrumb.name
                        }
                      </button>
                    )}
                  </span>
                ),
              )}
            </nav>

            {error && (
              <div
                className="public-resource__error"
                role="alert"
              >
                {error}
              </div>
            )}

            <div className="public-folder__section-heading">
              <h2>Папки</h2>

              <span>
                {
                  contents.folders
                    .length
                }
              </span>
            </div>

            {contents.folders.length >
            0 ? (
              <div className="public-folder__folders">
                {contents.folders.map(
                  (folder) => (
                    <button
                      className="public-folder__folder"
                      type="button"
                      key={folder.id}
                      onClick={() =>
                        navigateToFolder(
                          folder,
                        )
                      }
                    >
                      <span className="public-folder__folder-icon">
                        <FolderIcon />
                      </span>

                      <strong
                        title={
                          folder.name
                        }
                      >
                        {
                          folder.name
                        }
                      </strong>
                    </button>
                  ),
                )}
              </div>
            ) : (
              <p className="public-folder__empty">
                Вложенных папок нет.
              </p>
            )}

            <div className="public-folder__section-heading public-folder__section-heading--files">
              <h2>Файлы</h2>

              <span>
                {contents.files.length}
              </span>
            </div>

            {contents.files.length >
            0 ? (
              <div className="public-folder__files">
                {contents.files.map(
                  (file) => (
                    <article
                      className="public-folder__file"
                      key={file.id}
                    >
                      <span className="public-folder__file-icon">
                        <FileIcon />
                      </span>

                      <div className="public-folder__file-content">
                        <strong
                          title={
                            file.name
                          }
                        >
                          {file.name}
                        </strong>

                        <span>
                          {formatFileSize(
                            file.size,
                          )}

                          {file.mimeType
                            ? ` · ${file.mimeType}`
                            : ''}
                        </span>
                      </div>

                      <button
                        type="button"
                        disabled={
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
                          : 'Скачать'}
                      </button>
                    </article>
                  ),
                )}
              </div>
            ) : (
              <p className="public-folder__empty">
                Файлов в этой папке
                нет.
              </p>
            )}

            <p className="public-folder__note">
              Доступ только для
              просмотра. Изменение,
              загрузка и удаление файлов
              через публичную ссылку
              недоступны.
            </p>
          </>
        ) : null}
      </section>
    </main>
  );
}