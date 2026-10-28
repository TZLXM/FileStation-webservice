import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SqliteImmediateTransactionService } from './sqlite-immediate-transaction.service';
import { MaintenanceModule } from '../../maintenance/maintenance.module';

@Module({
  imports: [ConfigModule, MaintenanceModule],
  providers: [SqliteImmediateTransactionService],
  exports: [SqliteImmediateTransactionService],
})
export class SqliteImmediateTransactionModule {}
