import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAccount } from './entities/admin-account.entity';
import { AccountsService } from './accounts.service';

@Module({
  imports: [TypeOrmModule.forFeature([AdminAccount])],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
