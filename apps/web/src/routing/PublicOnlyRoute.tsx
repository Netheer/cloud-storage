import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../auth/useAuth';

export function PublicOnlyRoute() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <main className="route-loading" aria-live="polite">
        Восстанавливаем сессию…
      </main>
    );
  }

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}