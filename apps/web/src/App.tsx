import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { useEffect, useState } from 'react';
import LoginPage from './pages/LoginPage';
import InitPage from './pages/InitPage';
import FilesPage from './pages/FilesPage';
import SharePage from './pages/SharePage';
import SettingsPage from './pages/SettingsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, checkAuth } = useAuthStore();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      checkAuth().finally(() => setChecking(false));
    } else {
      setChecking(false);
    }
  }, [isAuthenticated, checkAuth]);

  if (checking) {
    return <div className="min-h-screen flex items-center justify-center">加载中...</div>;
  }

  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/init" element={<InitPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/s/:id" element={<SharePage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <FilesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
