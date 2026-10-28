import { SetMetadata } from '@nestjs/common';

export const MAINTENANCE_ALLOWED = 'filestation:maintenance-allowed';

/**
 * Marks a route that must remain readable while the global write barrier is
 * closed. The route must not write to SQLite, storage, the audit log, or any
 * other persistent state.
 */
export const MaintenanceAllowed = () =>
  SetMetadata(MAINTENANCE_ALLOWED, true);
