import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../auth/useAuth';

export function ProtectedRoute() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <main className="route-loading" aria-live="polite">
        Восстанавливаем сессию…
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}