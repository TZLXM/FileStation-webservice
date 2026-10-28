import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { UpdateStatusController } from './update-status.controller';
import { UpdateStatusService } from './update-status.service';

@Module({
  imports: [SecurityModule],
  controllers: [UpdateStatusController],
  providers: [UpdateStatusService],
})
export class UpdateStatusModule {}
