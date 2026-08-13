import {
  useEffect,
  useState,
} from 'react';
import type { FormEvent } from 'react';

interface FolderNameDialogProps {
  title: string;
  initialName?: string;
  entityLabel?: string;
  submitLabel: string;
  isSubmitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

export function FolderNameDialog({
  title,
  entityLabel = 'Папка',
  initialName = '',
  submitLabel,
  isSubmitting,
  error,
  onClose,
  onSubmit,
}: FolderNameDialogProps) {
  const [name, setName] = useState(initialName);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSubmitting, onClose]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedName = name.trim();

    if (!normalizedName) {
      return;
    }

    void onSubmit(normalizedName);
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
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
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-dialog-title"
      >
        <div className="dialog__header">
          <div>
            <p>{entityLabel}</p>
            <h2 id="folder-dialog-title">{title}</h2>
          </div>

          <button
            className="dialog__close"
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={isSubmitting}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label className="dialog__field">
            Название
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={1}
              maxLength={255}
              autoFocus
              required
            />
          </label>

          {error && (
            <div className="dialog__error" role="alert">
              {error}
            </div>
          )}

          <div className="dialog__actions">
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Отмена
            </button>

            <button
              className="primary-button"
              type="submit"
              disabled={isSubmitting || !name.trim()}
            >
              {isSubmitting ? 'Сохраняем…' : submitLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}