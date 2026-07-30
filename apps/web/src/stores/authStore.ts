import { create } from 'zustand';
import { api } from '../lib/api';

interface AuthState {
  accessToken: string | null;
  isAuthenticated: boolean;
  username: string | null;
  login: (accessToken: string, username: string) => void;
  logout: () => void;
  setAccessToken: (token: string) => void;
  checkAuth: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  isAuthenticated: false,
  username: null,

  login: (accessToken, username) => {
    api.setAccessToken(accessToken);
    set({ accessToken, isAuthenticated: true, username });
  },

  logout: async () => {
    try {
      await api.post('/auth/logout');
    } catch (err) {
      console.error('Logout failed:', err);
    }
    api.setAccessToken(null);
    set({ accessToken: null, isAuthenticated: false, username: null });
  },

  setAccessToken: (token) => {
    api.setAccessToken(token);
    set({ accessToken: token });
  },

  checkAuth: (() => {
    let promise: Promise<boolean> | null = null;

    return async () => {
      // Single-flight：并发调用复用同一 Promise
      if (promise) {
        return promise;
      }

      promise = (async () => {
        try {
          const response = await api.post<{ access_token: string; expires_in: number; username: string }>('/auth/refresh');
          const { access_token, username } = response.data!;
          api.setAccessToken(access_token);
          set({ accessToken: access_token, isAuthenticated: true, username });
          return true;
        } catch {
          return false;
        } finally {
          promise = null;
        }
      })();

      return promise;
    };
  })(),
}));
