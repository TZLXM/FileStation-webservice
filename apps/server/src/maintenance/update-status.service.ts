import { Injectable } from '@nestjs/common';
import { AttemptJournal } from '@filestation/updater';

export interface MaintenanceUpdateStatus {
  phase: string;
  attempt_id?: string;
  fence?: number;
  current_version?: string;
  target_version?: string;
  updated_at?: string;
}

@Injectable()
export class UpdateStatusService {
  async getStatus(): Promise<MaintenanceUpdateStatus> {
    const root = process.env.FILESTATION_INSTALL_ROOT;
    if (!root) return { phase: 'unavailable' };
    try {
      const snapshot = await AttemptJournal.inspect(root);
      if (!snapshot.initialized) return { phase: 'idle' };
      return {
        phase: snapshot.phase ?? 'unknown',
        attempt_id: snapshot.attemptId,
        fence: snapshot.fence,
        current_version: snapshot.currentVersion,
        target_version: snapshot.targetVersion,
        updated_at: snapshot.updatedAt,
      };
    } catch {
      return { phase: 'unavailable' };
    }
  }
}
