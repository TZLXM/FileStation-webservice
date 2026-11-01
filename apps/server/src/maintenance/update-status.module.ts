import { Module } from '@nestjs/common';
import { UpdatesModule } from '../updates/updates.module';

@Module({
  imports: [UpdatesModule],
})
export class UpdateStatusModule {}
