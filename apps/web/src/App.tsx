import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router';
import DashboardPage from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ProtectedRoute } from './routing/ProtectedRoute';
import { PublicOnlyRoute } from './routing/PublicOnlyRoute';
import { SharedPage } from './pages/SharedPage';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<PublicOnlyRoute />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>

        <Route element={<ProtectedRoute />}>
  <Route path="/" element={<DashboardPage />} />
  <Route path="/folders/*" element={<DashboardPage />} />
</Route>
<Route
    path="/shared"
    element={<SharedPage />}
  />

  <Route
    path="/shared/folders/*"
    element={<DashboardPage />}
  />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;