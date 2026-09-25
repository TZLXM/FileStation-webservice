import type { SqliteTransactionConnection } from '../common/database/sqlite-immediate-transaction.service';

const RESERVATION_KEY_PREFIX = 'login_ip_reservation_';
const FAILURE_THRESHOLD = 10;
const FAILURE_DELAY_MS = 30_000;

export const RECOVERY_IP_RESERVATION_TTL_MS = 5 * 60_000;

interface IpFailureState {
  failed_count: number;
  delay_until: number | null;
}

interface ReservationRow {
  key: string;
  value: string;
}

interface RecoveryIpReservation {
  ip: string;
  expires_at: number;
}

function reservationKey(reservationId: string): string {
  return `${RESERVATION_KEY_PREFIX}${reservationId}`;
}

function parseFailureState(value: string | undefined): IpFailureState {
  if (value === undefined) return { failed_count: 0, delay_until: null };
  try {
    const parsed = JSON.parse(value) as Partial<IpFailureState>;
    return {
      failed_count: Number.isSafeInteger(parsed.failed_count) && (parsed.failed_count ?? -1) >= 0
        ? parsed.failed_count!
        : 0,
      delay_until: typeof parsed.delay_until === 'number' && Number.isFinite(parsed.delay_until)
        ? parsed.delay_until
        : null,
    };
  } catch {
    return { failed_count: 0, delay_until: null };
  }
}

async function readIpFailureState(connection: SqliteTransactionConnection, ip: string): Promise<IpFailureState> {
  const row = await connection.get<{ value: string }>(
    'SELECT value FROM system_meta WHERE key = ?',
    [`login_ip_${ip}`],
  );
  return parseFailureState(row?.value);
}

async function writeIpFailureState(
  connection: SqliteTransactionConnection,
  ip: string,
  state: IpFailureState,
): Promise<void> {
  await connection.run(
    'INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [`login_ip_${ip}`, JSON.stringify(state)],
  );
}

async function listReservations(connection: SqliteTransactionConnection): Promise<ReservationRow[]> {
  return connection.all<ReservationRow>(
    "SELECT key, value FROM system_meta WHERE key GLOB 'login_ip_reservation_*'",
  );
}

function parseReservation(value: string): RecoveryIpReservation | null {
  try {
    const parsed = JSON.parse(value) as Partial<RecoveryIpReservation>;
    if (typeof parsed.ip !== 'string' || typeof parsed.expires_at !== 'number' || !Number.isFinite(parsed.expires_at)) {
      return null;
    }
    return { ip: parsed.ip, expires_at: parsed.expires_at };
  } catch {
    return null;
  }
}

export async function hasActiveRecoveryIpReservation(
  connection: SqliteTransactionConnection,
  ip: string,
  reservationId: string,
  now: number,
): Promise<boolean> {
  const row = await connection.get<{ value: string }>(
    'SELECT value FROM system_meta WHERE key = ?',
    [reservationKey(reservationId)],
  );
  const reservation = row ? parseReservation(row.value) : null;
  return reservation?.ip === ip && reservation.expires_at > now;
}

/** Expired in-flight work is settled as failure so crashed requests cannot leak admission slots. */
export async function settleExpiredRecoveryIpReservations(
  connection: SqliteTransactionConnection,
  now: number,
): Promise<void> {
  const rows = await listReservations(connection);
  const expiredByIp = new Map<string, number>();
  for (const row of rows) {
    const reservation = parseReservation(row.value);
    if (!reservation) {
      await connection.run('DELETE FROM system_meta WHERE key = ?', [row.key]);
      continue;
    }
    if (reservation.expires_at <= now) {
      expiredByIp.set(reservation.ip, (expiredByIp.get(reservation.ip) ?? 0) + 1);
      await connection.run('DELETE FROM system_meta WHERE key = ?', [row.key]);
    }
  }

  for (const [ip, expiredCount] of expiredByIp) {
    const state = await readIpFailureState(connection, ip);
    state.failed_count += expiredCount;
    if (state.failed_count >= FAILURE_THRESHOLD) {
      const delay = Math.floor(state.failed_count / FAILURE_THRESHOLD) * FAILURE_DELAY_MS;
      state.delay_until = Math.max(state.delay_until ?? 0, now + delay);
    }
    await writeIpFailureState(connection, ip, state);
  }
}

/** Persist a request-specific slot before account lookup and expensive Argon2 verification. */
export async function reserveRecoveryIpAttempt(
  connection: SqliteTransactionConnection,
  ip: string,
  reservationId: string,
  now: number,
): Promise<number | null> {
  await settleExpiredRecoveryIpReservations(connection, now);
  const state = await readIpFailureState(connection, ip);
  if (state.delay_until && state.delay_until > now) {
    return Math.ceil((state.delay_until - now) / 1000);
  }

  const rows = await listReservations(connection);
  const activeCount = rows.reduce((count, row) => {
    const reservation = parseReservation(row.value);
    return count + Number(reservation?.ip === ip && reservation.expires_at > now);
  }, 0);
  const usedSlots = state.failed_count + activeCount;
  if (usedSlots >= FAILURE_THRESHOLD) {
    const delay = Math.floor(usedSlots / FAILURE_THRESHOLD) * FAILURE_DELAY_MS;
    state.delay_until = Math.max(state.delay_until ?? 0, now + Math.max(FAILURE_DELAY_MS, delay));
    await writeIpFailureState(connection, ip, state);
    return Math.ceil((state.delay_until - now) / 1000);
  }

  await connection.run(
    'INSERT INTO system_meta (key, value) VALUES (?, ?)',
    [reservationKey(reservationId), JSON.stringify({ ip, expires_at: now + RECOVERY_IP_RESERVATION_TTL_MS })],
  );

  if (usedSlots + 1 >= FAILURE_THRESHOLD) {
    state.delay_until = Math.max(state.delay_until ?? 0, now + FAILURE_DELAY_MS);
    await writeIpFailureState(connection, ip, state);
  }
  return null;
}

/** Settle only this failed request; other in-flight reservations remain independently visible. */
export async function settleRecoveryIpFailure(
  connection: SqliteTransactionConnection,
  ip: string,
  reservationId: string,
  now: number,
): Promise<void> {
  await settleExpiredRecoveryIpReservations(connection, now);
  const key = reservationKey(reservationId);
  const row = await connection.get<{ value: string }>('SELECT value FROM system_meta WHERE key = ?', [key]);
  const reservation = row ? parseReservation(row.value) : null;
  if (!reservation || reservation.ip !== ip || reservation.expires_at <= now) return;

  await connection.run('DELETE FROM system_meta WHERE key = ?', [key]);
  const state = await readIpFailureState(connection, ip);
  state.failed_count += 1;
  const activeRows = await listReservations(connection);
  const remaining = activeRows.reduce((count, activeRow) => {
    const activeReservation = parseReservation(activeRow.value);
    return count + Number(activeReservation?.ip === ip && activeReservation.expires_at > now);
  }, 0);
  const usedSlots = state.failed_count + remaining;
  if (usedSlots >= FAILURE_THRESHOLD) {
    const delay = Math.floor(usedSlots / FAILURE_THRESHOLD) * FAILURE_DELAY_MS;
    state.delay_until = Math.max(state.delay_until ?? 0, now + Math.max(FAILURE_DELAY_MS, delay));
  }
  await writeIpFailureState(connection, ip, state);
}

/** In the recovery/session commit, consume this request's reservation and clear only history. */
export async function settleRecoveryIpSuccess(
  connection: SqliteTransactionConnection,
  ip: string,
  reservationId: string,
  now: number,
): Promise<boolean> {
  await settleExpiredRecoveryIpReservations(connection, now);
  const key = reservationKey(reservationId);
  const row = await connection.get<{ value: string }>('SELECT value FROM system_meta WHERE key = ?', [key]);
  const reservation = row ? parseReservation(row.value) : null;
  if (!reservation || reservation.ip !== ip || reservation.expires_at <= now) return false;

  await connection.run('DELETE FROM system_meta WHERE key = ?', [key]);
  await connection.run('DELETE FROM system_meta WHERE key = ?', [`login_ip_${ip}`]);
  return true;
}
