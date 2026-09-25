import {
  useEffect,
  useState,
} from 'react';
import { ApiError } from '../auth/auth-api';
import {
  buildPublicLinkUrl,
  createPublicLink,
  listPublicLinks,
  revokePublicLink,
  type PublicLink,
  type PublicLinkTargetType,
} from './public-links-api';

type AuthFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

interface PublicLinkSectionProps {
  resourceType: PublicLinkTargetType;
  resourceId: string;
  authFetch: AuthFetch;
}

function formatDate(
  value: string | null,
): string {
  if (!value) {
    return 'Без срока действия';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function getLinkStatus(
  link: PublicLink,
): string {
  if (link.revokedAt) {
    return 'Отозвана';
  }

  if (
    link.expiresAt &&
    new Date(link.expiresAt).getTime() <=
      Date.now()
  ) {
    return 'Истекла';
  }

  return 'Активна';
}

export function PublicLinkSection({
  resourceType,
  resourceId,
  authFetch,
}: PublicLinkSectionProps) {
  const [links, setLinks] = useState<
    PublicLink[]
  >([]);

  const [expiresAt, setExpiresAt] =
    useState('');

  const [createdUrl, setCreatedUrl] =
    useState<string | null>(null);

  const [isLoading, setIsLoading] =
    useState(true);

  const [isCreating, setIsCreating] =
    useState(false);

  const [
    revokingLinkId,
    setRevokingLinkId,
  ] = useState<string | null>(null);

  const [copied, setCopied] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const loadLinks = async () => {
    const loadedLinks =
      await listPublicLinks(
        authFetch,
        resourceType,
        resourceId,
      );

    setLinks(loadedLinks);
  };

  useEffect(() => {
    let active = true;

    setIsLoading(true);
    setError(null);

    void listPublicLinks(
      authFetch,
      resourceType,
      resourceId,
    )
      .then((loadedLinks) => {
        if (active) {
          setLinks(loadedLinks);
        }
      })
      .catch((requestError: unknown) => {
        if (!active) {
          return;
        }

        setError(
          requestError instanceof ApiError
            ? requestError.message
            : 'Не удалось загрузить публичные ссылки',
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
    resourceId,
    resourceType,
  ]);

  const handleCreate = async () => {
    setIsCreating(true);
    setError(null);
    setCopied(false);

    try {
      const expiration = expiresAt
        ? new Date(expiresAt).toISOString()
        : null;

      const link = await createPublicLink(
        authFetch,
        resourceType,
        resourceId,
        expiration,
      );

      setCreatedUrl(
        buildPublicLinkUrl(
          resourceType,
          link.token,
        ),
      );

      setExpiresAt('');

      await loadLinks();
    } catch (requestError: unknown) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Не удалось создать публичную ссылку',
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!createdUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        createdUrl,
      );

      setCopied(true);
    } catch {
      setError(
        'Не удалось скопировать ссылку',
      );
    }
  };

  const handleRevoke = async (
    linkId: string,
  ) => {
    setRevokingLinkId(linkId);
    setError(null);

    try {
      await revokePublicLink(
        authFetch,
        resourceType,
        resourceId,
        linkId,
      );

      await loadLinks();
    } catch (requestError: unknown) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Не удалось отозвать ссылку',
      );
    } finally {
      setRevokingLinkId(null);
    }
  };

  return (
    <section className="public-links">
      <div className="public-links__heading">
        <div>
          <h3>Публичная ссылка</h3>

          <p>
            Любой человек со ссылкой сможет
            просматривать ресурс без входа
            в аккаунт.
          </p>
        </div>
      </div>

      <div className="public-links__create">
        <label>
          <span>
            Срок действия
          </span>

          <input
            type="datetime-local"
            value={expiresAt}
            disabled={isCreating}
            onChange={(event) =>
              setExpiresAt(
                event.target.value,
              )
            }
          />
        </label>

        <button
          type="button"
          disabled={isCreating}
          onClick={() =>
            void handleCreate()
          }
        >
          {isCreating
            ? 'Создание…'
            : 'Создать ссылку'}
        </button>
      </div>

      <p className="public-links__hint">
        Оставьте срок пустым, если ссылка
        должна работать без ограничения
        по времени.
      </p>

      {createdUrl && (
        <div className="public-links__created">
          <strong>
            Ссылка создана
          </strong>

          <p>
            Скопируйте её сейчас. После
            закрытия окна полный адрес
            восстановить нельзя.
          </p>

          <div className="public-links__url">
            <input
              type="text"
              readOnly
              value={createdUrl}
            />

            <button
              type="button"
              onClick={() =>
                void handleCopy()
              }
            >
              {copied
                ? 'Скопировано'
                : 'Копировать'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          className="public-links__error"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="public-links__list">
        <strong>
          Созданные ссылки
        </strong>

        {isLoading ? (
          <p>Загрузка…</p>
        ) : links.length === 0 ? (
          <p>
            Публичных ссылок пока нет.
          </p>
        ) : (
          links.map((link) => {
            const status =
              getLinkStatus(link);

            const canRevoke =
              !link.revokedAt &&
              status !== 'Истекла';

            return (
              <div
                className="public-links__item"
                key={link.id}
              >
                <div>
                  <strong>
                    {status}
                  </strong>

                  <span>
                    {formatDate(
                      link.expiresAt,
                    )}
                  </span>

                  <span>
                    Создана:{' '}
                    {formatDate(
                      link.createdAt,
                    )}
                  </span>
                </div>

                {canRevoke && (
                  <button
                    type="button"
                    disabled={
                      revokingLinkId ===
                      link.id
                    }
                    onClick={() =>
                      void handleRevoke(
                        link.id,
                      )
                    }
                  >
                    {revokingLinkId ===
                    link.id
                      ? 'Отзываем…'
                      : 'Отозвать'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}