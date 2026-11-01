import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateAuditIdempotency1800000000000
  implements MigrationInterface
{
  name = 'UpdateAuditIdempotency1800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE audit_logs ADD COLUMN update_attempt_id TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE audit_logs ADD COLUMN update_event TEXT`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_audit_update_event
         ON audit_logs(update_attempt_id, update_event)
       WHERE update_attempt_id IS NOT NULL AND update_event IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_audit_update_event`);
    await queryRunner.query(
      `ALTER TABLE audit_logs DROP COLUMN update_event`,
    );
    await queryRunner.query(
      `ALTER TABLE audit_logs DROP COLUMN update_attempt_id`,
    );
  }
}
