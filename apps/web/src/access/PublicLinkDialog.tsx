import { useEffect } from 'react';
import { PublicLinkSection } from './PublicLinkSection';
import type { PublicLinkTargetType } from './public-links-api';

type AuthFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

interface PublicLinkDialogProps {
  resourceType: PublicLinkTargetType;
  resourceId: string;
  resourceName: string;
  authFetch: AuthFetch;
  onClose: () => void;
}

export function PublicLinkDialog({
  resourceType,
  resourceId,
  resourceName,
  authFetch,
  onClose,
}: PublicLinkDialogProps) {
  useEffect(() => {
    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
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
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget
        ) {
          onClose();
        }
      }}
    >
      <section
        className="dialog dialog--public-links"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-link-dialog-title"
      >
        <div className="dialog__header">
          <div>
            <p>
              {resourceType === 'folder'
                ? 'Папка'
                : 'Файл'}
            </p>

            <h2 id="public-link-dialog-title">
              Публичный доступ
            </h2>

            <span className="public-links__resource-name">
              {resourceName}
            </span>
          </div>

          <button
            className="dialog__close"
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <PublicLinkSection
          resourceType={resourceType}
          resourceId={resourceId}
          authFetch={authFetch}
        />
      </section>
    </div>
  );
}