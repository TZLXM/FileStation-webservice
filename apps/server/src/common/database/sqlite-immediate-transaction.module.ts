import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SqliteImmediateTransactionService } from './sqlite-immediate-transaction.service';

@Module({
  imports: [ConfigModule],
  providers: [SqliteImmediateTransactionService],
  exports: [SqliteImmediateTransactionService],
})
export class SqliteImmediateTransactionModule {}
