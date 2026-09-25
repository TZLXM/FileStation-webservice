import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';

interface RecoveryGenerateResponse {
  codes: string[];
}

interface RecoveryGenerationContextValue {
  codes: string[] | null;
  generating: boolean;
  error: string;
  notice: string;
  generate: (password: string, totpCode: string, totpActive: boolean) => Promise<boolean>;
  clearCodes: () => void;
  clearFeedback: () => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}

const RecoveryGenerationContext = createContext<RecoveryGenerationContextValue | null>(null);

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function RecoveryGenerationProvider({ children }: { children: React.ReactNode }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestInFlight = useRef(false);

  useEffect(() => {
    if (!generating) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [generating]);

  const clearCodes = useCallback(() => setCodes(null), []);
  const clearFeedback = useCallback(() => {
    setError('');
    setNotice('');
  }, []);

  const generate = useCallback(async (password: string, totpCode: string, totpActive: boolean) => {
    if (requestInFlight.current) return false;
    requestInFlight.current = true;
    setGenerating(true);
    setError('');
    setNotice('');

    try {
      const response = await api.post<RecoveryGenerateResponse>('/auth/recovery/generate', {
        password,
        ...(totpActive ? { totp_code: totpCode } : {}),
      });
      const generatedCodes = response.data?.codes;
      if (!Array.isArray(generatedCodes) || generatedCodes.length !== 10
        || generatedCodes.some((code) => typeof code !== 'string' || code.length === 0)) {
        throw new Error('服务返回的恢复码不完整，请重试生成。');
      }

      setCodes([...generatedCodes]);
      setNotice('恢复码只会展示一次，请立即保存；关闭后无法再次查看。');
      return true;
    } catch (requestError) {
      setError(getErrorMessage(requestError, '生成恢复码失败，请重试。'));
      return false;
    } finally {
      requestInFlight.current = false;
      setGenerating(false);
    }
  }, []);

  const value = useMemo(() => ({
    codes,
    generating,
    error,
    notice,
    generate,
    clearCodes,
    clearFeedback,
    setError,
    setNotice,
  }), [codes, generating, error, notice, generate, clearCodes, clearFeedback]);

  return <RecoveryGenerationContext.Provider value={value}>{children}</RecoveryGenerationContext.Provider>;
}

export function useRecoveryGeneration(): RecoveryGenerationContextValue {
  const context = useContext(RecoveryGenerationContext);
  if (!context) throw new Error('RecoverySection must be rendered within RecoveryGenerationProvider.');
  return context;
}
