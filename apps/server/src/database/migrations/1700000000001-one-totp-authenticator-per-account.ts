import { MigrationInterface, QueryRunner } from 'typeorm';

export class OneTotpAuthenticatorPerAccount1700000000001 implements MigrationInterface {
  name = 'OneTotpAuthenticatorPerAccount1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Keep an active row before pending rows; otherwise keep the newest row.
    // This repairs duplicate pending rows that could be created by the prior
    // non-transactional setup implementation before installing the constraint.
    await queryRunner.query(`
      DELETE FROM authenticators
      WHERE type = 'totp'
        AND EXISTS (
          SELECT 1
          FROM authenticators AS preferred
          WHERE preferred.account_id = authenticators.account_id
            AND preferred.type = 'totp'
            AND (
              preferred.is_active > authenticators.is_active
              OR (preferred.is_active = authenticators.is_active AND preferred.created_at > authenticators.created_at)
              OR (preferred.is_active = authenticators.is_active AND preferred.created_at = authenticators.created_at AND preferred.id > authenticators.id)
            )
        )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_authenticators_one_totp_per_account
      ON authenticators(account_id)
      WHERE type = 'totp'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS uq_authenticators_one_totp_per_account');
  }
}
