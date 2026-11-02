import { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionRefreshRotation1800000000001
  implements MigrationInterface
{
  name = 'SessionRefreshRotation1800000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE sessions ADD COLUMN refresh_family_hash TEXT`,
    );
    await queryRunner.query(
      `ALTER TABLE sessions ADD COLUMN pre_family_refresh_token_hash TEXT`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_sessions_pre_family_refresh_token_hash
       ON sessions(pre_family_refresh_token_hash)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_sessions_pre_family_refresh_token_hash`,
    );
    await queryRunner.query(
      `ALTER TABLE sessions DROP COLUMN pre_family_refresh_token_hash`,
    );
    await queryRunner.query(
      `ALTER TABLE sessions DROP COLUMN refresh_family_hash`,
    );
  }
}
