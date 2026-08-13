import { useEffect } from 'react';

interface DeleteFolderDialogProps {
  itemName: string;
  itemType?: 'folder' | 'file';
  isSubmitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function DeleteFolderDialog({
  itemName,
  itemType = 'folder',
  isSubmitting,
  error,
  onClose,
  onConfirm,
}: DeleteFolderDialogProps) {
  const isFile = itemType === 'file';
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

  return (
    <div
      className="delete-dialog-backdrop"
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
        className="delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
      >
        <div className="delete-dialog__icon" aria-hidden="true">
          !
        </div>

        <h2 id="delete-dialog-title">
  {isFile ? 'Удалить файл?' : 'Удалить папку?'}
</h2>

<p>
  {isFile ? (
    <>
      Файл <strong>«{itemName}»</strong> будет безвозвратно
      удалён из хранилища.
    </>
  ) : (
    <>
      Папка <strong>«{itemName}»</strong> будет удалена.
      Удалить можно только пустую папку.
    </>
  )}
</p>

        {error && (
          <div className="delete-dialog__error" role="alert">
            {error}
          </div>
        )}

        <div className="delete-dialog__actions">
          <button
            type="button"
            className="delete-dialog__cancel"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Отмена
          </button>

          <button
            type="button"
            className="delete-dialog__confirm"
            onClick={() => void onConfirm()}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Удаляем…' : 'Удалить'}
          </button>
        </div>
      </section>
    </div>
  );
}