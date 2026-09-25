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
import { PublicFilePage } from './pages/PublicFilePage';
import { PublicFolderPage } from './pages/PublicFolderPage';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<PublicOnlyRoute />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>

        <Route
  path="/public/files/:token"
  element={<PublicFilePage />}
/>
        <Route
  path="/public/folders/:token"
  element={<PublicFolderPage />}
/>

<Route
  path="/public/folders/:token/folders/:folderId"
  element={<PublicFolderPage />}
/>

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