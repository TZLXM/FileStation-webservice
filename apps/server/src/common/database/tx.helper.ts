import { QueryRunner } from 'typeorm';

/**
 * BEGIN IMMEDIATE 并发安全启动（SQLite 单写者）：
 * 并发写事务时后者报 "cannot start a transaction within a transaction" / "database is locked"，
 * busy_timeout 不覆盖 BEGIN 升级场景。此处短退避重试，serialize 并发写者。
 */
export async function beginImmediate(queryRunner: QueryRunner, retries = 12): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await queryRunner.query('BEGIN IMMEDIATE');
      return;
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (msg.includes('cannot start a transaction') || msg.includes('database is locked') || msg.includes('SQLITE_BUSY')) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** ROLLBACK 守卫：事务未激活（已被 COMMIT/ROLLBACK 或从未开始）时静默忽略 */
export async function safeRollback(queryRunner: QueryRunner): Promise<void> {
  try {
    await queryRunner.query('ROLLBACK');
  } catch {
    // no transaction is active
  }
}
