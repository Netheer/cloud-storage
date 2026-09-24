import {
  useEffect,
  useState,
} from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../auth/auth-api';
import {
  createFileShare,
  createFolderShare,
  deleteFileShare,
  deleteFolderShare,
  listFileShares,
  listFolderShares,
  updateFileShare,
  updateFolderShare,
  type AuthFetch,
  type Share,
  type ShareRole,
} from './sharing-api';

interface ShareDialogProps {
  resourceType: 'folder' | 'file';
  resourceId: string;
  resourceName: string;
  authFetch: AuthFetch;
  onClose: () => void;
}

function getErrorText(
  error: unknown,
  fallback: string,
): string {
  return error instanceof ApiError
    ? error.message
    : fallback;
}

export function ShareDialog({
  resourceType,
  resourceId,
  resourceName,
  authFetch,
  onClose,
}: ShareDialogProps) {
  const [shares, setShares] = useState<Share[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] =
    useState<ShareRole>('VIEWER');

  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingGrantId, setPendingGrantId] =
    useState<string | null>(null);

  const [loadError, setLoadError] =
    useState<string | null>(null);
  const [actionError, setActionError] =
    useState<string | null>(null);

  const isBusy =
    isLoading ||
    isCreating ||
    pendingGrantId !== null;

  useEffect(() => {
    let active = true;

    const load = async () => {
      setIsLoading(true);
      setLoadError(null);

      try {
        const loadedShares =
          resourceType === 'folder'
            ? await listFolderShares(
                authFetch,
                resourceId,
              )
            : await listFileShares(
                authFetch,
                resourceId,
              );

        if (active) {
          setShares(loadedShares);
        }
      } catch (error: unknown) {
        if (active) {
          setLoadError(
            getErrorText(
              error,
              'Не удалось загрузить список пользователей',
            ),
          );
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [
    authFetch,
    resourceId,
    resourceType,
  ]);

  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (
        event.key === 'Escape' &&
        !isBusy
      ) {
        onClose();
      }
    };

    document.addEventListener(
      'keydown',
      handleKeyDown,
    );

    return () => {
      document.removeEventListener(
        'keydown',
        handleKeyDown,
      );
    };
  }, [isBusy, onClose]);

  const handleCreate = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    const normalizedEmail =
      email.trim().toLowerCase();

    if (!normalizedEmail) {
      return;
    }

    setIsCreating(true);
    setActionError(null);

    try {
      const createdShare =
        resourceType === 'folder'
          ? await createFolderShare(
              authFetch,
              resourceId,
              normalizedEmail,
              role,
            )
          : await createFileShare(
              authFetch,
              resourceId,
              normalizedEmail,
              role,
            );

      setShares((current) => [
        ...current,
        createdShare,
      ]);

      setEmail('');
      setRole('VIEWER');
    } catch (error: unknown) {
      setActionError(
        getErrorText(
          error,
          'Не удалось выдать доступ',
        ),
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleRoleChange = async (
    share: Share,
    nextRole: ShareRole,
  ) => {
    if (share.role === nextRole) {
      return;
    }

    setPendingGrantId(share.id);
    setActionError(null);

    try {
      const updatedShare =
        resourceType === 'folder'
          ? await updateFolderShare(
              authFetch,
              resourceId,
              share.id,
              nextRole,
            )
          : await updateFileShare(
              authFetch,
              resourceId,
              share.id,
              nextRole,
            );

      setShares((current) =>
        current.map((item) =>
          item.id === updatedShare.id
            ? updatedShare
            : item,
        ),
      );
    } catch (error: unknown) {
      setActionError(
        getErrorText(
          error,
          'Не удалось изменить роль',
        ),
      );
    } finally {
      setPendingGrantId(null);
    }
  };

  const handleRevoke = async (
    share: Share,
  ) => {
    setPendingGrantId(share.id);
    setActionError(null);

    try {
      if (resourceType === 'folder') {
        await deleteFolderShare(
          authFetch,
          resourceId,
          share.id,
        );
      } else {
        await deleteFileShare(
          authFetch,
          resourceId,
          share.id,
        );
      }

      setShares((current) =>
        current.filter(
          (item) => item.id !== share.id,
        ),
      );
    } catch (error: unknown) {
      setActionError(
        getErrorText(
          error,
          'Не удалось отозвать доступ',
        ),
      );
    } finally {
      setPendingGrantId(null);
    }
  };

  const entityLabel =
    resourceType === 'folder'
      ? 'Папка'
      : 'Файл';

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          !isBusy
        ) {
          onClose();
        }
      }}
    >
      <section
        className="dialog dialog--share"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
      >
        <div className="dialog__header">
          <div>
            <p>{entityLabel}</p>
            <h2 id="share-dialog-title">
              Общий доступ
            </h2>
          </div>

          <button
            className="dialog__close"
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={isBusy}
          >
            ×
          </button>
        </div>

        <p className="share-dialog__resource">
          Доступ к{' '}
          <strong>{resourceName}</strong>
        </p>

        <form
          className="share-dialog__form"
          onSubmit={(event) =>
            void handleCreate(event)
          }
        >
          <label className="dialog__field">
            Email пользователя
            <input
              type="email"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              maxLength={254}
              placeholder="user@example.com"
              disabled={isCreating}
              required
            />
          </label>

          <label className="dialog__field">
            Роль
            <select
              value={role}
              onChange={(event) =>
                setRole(
                  event.target
                    .value as ShareRole,
                )
              }
              disabled={isCreating}
            >
              <option value="VIEWER">
                Просмотр
              </option>
              <option value="EDITOR">
                Редактирование
              </option>
            </select>
          </label>

          <button
            className="primary-button"
            type="submit"
            disabled={
              isCreating ||
              !email.trim()
            }
          >
            {isCreating
              ? 'Добавляем…'
              : 'Добавить'}
          </button>
        </form>

        {actionError && (
          <div
            className="dialog__error"
            role="alert"
          >
            {actionError}
          </div>
        )}

        <div className="share-dialog__section">
          <h3>Пользователи с доступом</h3>

          {isLoading ? (
            <p className="share-dialog__status">
              Загружаем…
            </p>
          ) : loadError ? (
            <div
              className="dialog__error"
              role="alert"
            >
              {loadError}
            </div>
          ) : shares.length === 0 ? (
            <p className="share-dialog__status">
              Доступ пока никому не выдан.
            </p>
          ) : (
            <div className="share-dialog__list">
              {shares.map((share) => {
                const isPending =
                  pendingGrantId === share.id;

                return (
                  <div
                    className="share-dialog__user"
                    key={share.id}
                  >
                    <div className="share-dialog__user-info">
                      <strong>
                        {share.displayName ||
                          share.email}
                      </strong>

                      {share.displayName && (
                        <span>
                          {share.email}
                        </span>
                      )}
                    </div>

                    <select
                      aria-label={`Роль ${share.email}`}
                      value={share.role}
                      disabled={
                        pendingGrantId !== null
                      }
                      onChange={(event) =>
                        void handleRoleChange(
                          share,
                          event.target
                            .value as ShareRole,
                        )
                      }
                    >
                      <option value="VIEWER">
                        Просмотр
                      </option>
                      <option value="EDITOR">
                        Редактирование
                      </option>
                    </select>

                    <button
                      className="share-dialog__revoke"
                      type="button"
                      disabled={
                        pendingGrantId !== null
                      }
                      onClick={() =>
                        void handleRevoke(
                          share,
                        )
                      }
                    >
                      {isPending
                        ? '…'
                        : 'Удалить'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="dialog__actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={isBusy}
          >
            Закрыть
          </button>
        </div>
      </section>
    </div>
  );
}