import { create } from 'zustand';

export interface MaintenanceFailure {
  status: number;
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
  targetVersion?: string;
  attemptId?: string;
}

export interface MaintenanceStatusView {
  phase?: string;
  attempt_id?: string;
  target_version?: string;
  current_version?: string;
  updated_at?: string;
}

export interface MaintenanceState {
  active: boolean;
  status?: number;
  code?: string;
  message?: string;
  retryAfterSeconds: number;
  targetVersion?: string;
  attemptId?: string;
  phase?: string;
  updatedAt?: string;
  pollError?: string;
  authError: boolean;
  activate: (failure: MaintenanceFailure) => void;
  applyStatus: (value: MaintenanceStatusView) => void;
  setPollError: (message: string, authError?: boolean) => void;
  reset: () => void;
}

const DEFAULT_RETRY_SECONDS = 5;
const TERMINAL_PHASES = new Set([
  'COMMITTED',
  'ROLLED_BACK',
  'FAILED',
  'ABORTED',
]);

export function isMaintenanceFailure(
  value: unknown,
): value is MaintenanceFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MaintenanceFailure>;
  return candidate.status === 503 && candidate.code === 'UPDATE_MAINTENANCE';
}

export function isTerminalMaintenancePhase(phase?: string): boolean {
  return Boolean(phase && TERMINAL_PHASES.has(phase));
}

function normalizedRetry(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETRY_SECONDS;
  return Math.max(1, Math.min(60, Math.trunc(value!)));
}

const initialState = {
  active: false,
  status: undefined,
  code: undefined,
  message: undefined,
  retryAfterSeconds: DEFAULT_RETRY_SECONDS,
  targetVersion: undefined,
  attemptId: undefined,
  phase: undefined,
  updatedAt: undefined,
  pollError: undefined,
  authError: false,
} satisfies Omit<MaintenanceState, 'activate' | 'applyStatus' | 'setPollError' | 'reset'>;

export const maintenanceStore = create<MaintenanceState>((set) => ({
  ...initialState,

  activate: (failure) => {
    if (!isMaintenanceFailure(failure)) return;
    set((current) => ({
      active: true,
      status: failure.status,
      code: failure.code,
      message: failure.message,
      retryAfterSeconds: normalizedRetry(failure.retryAfterSeconds),
      targetVersion: failure.targetVersion,
      attemptId: failure.attemptId,
      pollError: undefined,
      authError: current.authError,
    }));
  },

  applyStatus: (value) => {
    if (isTerminalMaintenancePhase(value.phase)) {
      set(initialState);
      return;
    }
    set((current) => ({
      phase: value.phase ?? current.phase,
      targetVersion: value.target_version ?? current.targetVersion,
      attemptId: value.attempt_id ?? current.attemptId,
      updatedAt: value.updated_at ?? current.updatedAt,
      pollError: undefined,
      authError: false,
    }));
  },

  setPollError: (message, authError = false) => {
    set((current) => ({ pollError: message, authError: current.authError || authError }));
  },

  reset: () => set(initialState),
}));
