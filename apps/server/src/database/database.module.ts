import { Module, OnApplicationBootstrap, Injectable, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { promises as fs } from 'fs';
import { dirname } from 'path';

@Injectable()
export class DatabaseInitializer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseInitializer.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    // 执行 PRAGMA 配置
    await this.dataSource.query('PRAGMA journal_mode = WAL');
    await this.dataSource.query('PRAGMA busy_timeout = 5000');
    await this.dataSource.query('PRAGMA foreign_keys = ON');

    // 验证配置
    const [journalMode] = await this.dataSource.query('PRAGMA journal_mode');
    const [busyTimeout] = await this.dataSource.query('PRAGMA busy_timeout');
    const [foreignKeys] = await this.dataSource.query('PRAGMA foreign_keys');

    this.logger.log(`SQLite journal_mode: ${journalMode.journal_mode}`);
    this.logger.log(`SQLite busy_timeout: ${busyTimeout.busy_timeout}`);
    this.logger.log(`SQLite foreign_keys: ${foreignKeys.foreign_keys}`);

    if (foreignKeys.foreign_keys !== 1) {
      throw new Error('SQLite foreign keys are disabled');
    }
  }
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const dbPath = configService.get<string>('app.dbPath') || './data/filestation.db';
        // 连接前创建数据库父目录（v1.6：生产环境无预建目录时首次启动失败）
        await fs.mkdir(dirname(dbPath), { recursive: true });
        return {
          type: 'sqlite',
          database: dbPath,
          entities: [__dirname + '/../**/*.entity{.ts,.js}'],
          migrations: [__dirname + '/migrations/*{.ts,.js}'],
          migrationsRun: true,
          synchronize: false,
          logging: configService.get<string>('app.nodeEnv') === 'development',
        };
      },
    }),
  ],
  providers: [DatabaseInitializer],
})
export class DatabaseModule {}
