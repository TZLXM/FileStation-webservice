import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

interface AppLayoutProps {
  children: React.ReactNode;
  onFolderToggle?: () => void;
}

export default function AppLayout({ children, onFolderToggle }: AppLayoutProps) {
  const logout = useAuthStore((state) => state.logout);
  const username = useAuthStore((state) => state.username);
  const location = useLocation();
  const navigate = useNavigate();

  const navItems = [
    { to: '/', label: '文件' },
    { to: '/audit', label: '审计' },
    { to: '/settings', label: '设置' },
  ];

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      navigate('/login');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow sticky top-0 z-30">
        <div className="px-4 py-2.5 flex items-center gap-2 sm:gap-3">
          {onFolderToggle && (
            <button
              type="button"
              className="md:hidden shrink-0 p-2 -ml-2 text-gray-600 rounded hover:bg-gray-100"
              aria-label="打开文件夹"
              aria-haspopup="dialog"
              onClick={onFolderToggle}
            >
              <span aria-hidden="true">☰</span>
            </button>
          )}
          <Link to="/" className="text-lg sm:text-xl font-bold whitespace-nowrap shrink-0">FileStation</Link>
          <nav aria-label="主导航" className="flex items-center gap-0.5 sm:gap-1">
            {navItems.map((item) => {
              const active = location.pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={`px-2 sm:px-3 py-2 rounded text-sm whitespace-nowrap ${
                    active ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto shrink-0 flex items-center gap-1 sm:gap-3">
            {username && (
              <span className="text-sm text-gray-600 hidden sm:inline max-w-36 truncate">{username}</span>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="text-sm text-red-600 hover:text-red-800 py-2 px-1 whitespace-nowrap"
            >
              退出
            </button>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
