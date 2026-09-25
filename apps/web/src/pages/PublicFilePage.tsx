import {
  useEffect,
  useState,
} from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../auth/auth-api';
import {
  createPublicFileDownload,
  getPublicFile,
  type PublicFile,
} from '../access/public-links-api';

function formatFileSize(size: string): string {
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

  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} МиБ`;
  }

  return `${(bytes / 1024 ** 3).toFixed(1)} ГиБ`;
}

export function PublicFilePage() {
  const { token } = useParams<{
    token: string;
  }>();

  const [file, setFile] =
    useState<PublicFile | null>(null);

  const [isLoading, setIsLoading] =
    useState(true);

  const [isDownloading, setIsDownloading] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!token) {
      setError('Публичная ссылка недействительна');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    void getPublicFile(token)
      .then((loadedFile) => {
        if (active) {
          setFile(loadedFile);
        }
      })
      .catch((requestError: unknown) => {
        if (!active) {
          return;
        }

        if (
          requestError instanceof ApiError &&
          requestError.status === 404
        ) {
          setError(
            'Ссылка недоступна. Возможно, она истекла или была отозвана.',
          );
        } else {
          setError(
            requestError instanceof ApiError
              ? requestError.message
              : 'Не удалось открыть публичный файл',
          );
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const handleDownload = async () => {
    if (!token || !file) {
      return;
    }

    setIsDownloading(true);
    setError(null);

    try {
      const download =
        await createPublicFileDownload(token);

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
          'Ссылка больше недоступна.',
        );
      } else {
        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Не удалось скачать файл',
        );
      }
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <main className="public-page">
      <div className="public-page__brand">
        <div className="brand__mark">
          C
        </div>

        <div>
          <strong>Cloud Storage</strong>
          <span>
            Публичный доступ
          </span>
        </div>
      </div>

      <section className="public-resource">
        {isLoading ? (
          <div className="public-resource__status">
            <div className="public-resource__loader" />
            <p>Загружаем файл…</p>
          </div>
        ) : error && !file ? (
          <div className="public-resource__status">
            <div className="public-resource__icon">
              !
            </div>

            <h1>
              Файл недоступен
            </h1>

            <p>{error}</p>
          </div>
        ) : file ? (
          <>
            <div className="public-resource__file-icon">
              <svg
                aria-hidden="true"
                viewBox="0 0 48 48"
                width="64"
                height="64"
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
            </div>

            <p className="public-resource__eyebrow">
              Публичный файл
            </p>

            <h1 title={file.name}>
              {file.name}
            </h1>

            <div className="public-resource__meta">
              <span>
                {formatFileSize(file.size)}
              </span>

              {file.mimeType && (
                <>
                  <span aria-hidden="true">
                    ·
                  </span>

                  <span>
                    {file.mimeType}
                  </span>
                </>
              )}
            </div>

            {error && (
              <div
                className="public-resource__error"
                role="alert"
              >
                {error}
              </div>
            )}

            <button
              className="public-resource__download"
              type="button"
              disabled={isDownloading}
              onClick={() =>
                void handleDownload()
              }
            >
              {isDownloading
                ? 'Подготавливаем…'
                : 'Скачать файл'}
            </button>

            <p className="public-resource__note">
              Файл опубликован через Cloud Storage.
              Для скачивания вход в аккаунт не нужен.
            </p>
          </>
        ) : null}
      </section>
    </main>
  );
}