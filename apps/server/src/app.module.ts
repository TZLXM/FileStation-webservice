import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { resolve } from 'path';
import { existsSync } from 'fs';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { SecurityModule } from './security/security.module';
import { FilesModule } from './files/files.module';
import { FoldersModule } from './folders/folders.module';
import { SharesModule } from './shares/shares.module';
import { SettingsModule } from './settings/settings.module';

// Nginx 可选项（v1.8）：FILESTATION_SERVE_STATIC=true 时由本进程托管前端构建产物。
// 条件在此（模块加载时）读取，而不是走 ConfigService——ServeStaticModule.forRoot 的
// 条件注册发生在 ConfigModule 初始化前，无法注入；env 与 configuration.ts 同源，行为一致。
const serveStaticImports =
  process.env.FILESTATION_SERVE_STATIC === 'true'
    ? (() => {
        // 默认路径基于模块位置（apps/server/dist → 仓库根 → apps/web/dist），
        // 与启动目录无关——npm run start（仓库根）和 cd apps/server && node dist/main.js
        // 解析结果一致。FILESTATION_WEB_DIST 可用绝对路径或相对仓库根的路径覆盖。
        const custom = process.env.FILESTATION_WEB_DIST;
        const rootPath = custom
          ? resolve(__dirname, '..', '..', '..', custom)
          : resolve(__dirname, '..', '..', 'web', 'dist');
        if (!existsSync(rootPath)) {
          // 不抛错——API 仍可用，启动日志在 main.ts 里提示前端产物缺失
          console.warn(
            `[ServeStatic] FILESTATION_SERVE_STATIC=true 但未找到前端构建产物: ${rootPath}` +
              `（先运行 npm run build 生成 apps/web/dist）`,
          );
        }
        return [
          ServeStaticModule.forRoot({
            rootPath,
            // setGlobalPrefix('api/v1') 后所有非 /api 路径均不匹配控制器，
            // serve-static 自动将未命中路径回退到 index.html（SPA 路由如 /init、/files）。
            exclude: ['/api/(.*)'],
          }),
        ];
      })()
    : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
    }),
    ScheduleModule.forRoot(), // @Cron 生效前提（FileLifecycleService）
    ...serveStaticImports,
    DatabaseModule,
    SecurityModule,
    AuthModule,
    AccountsModule,
    SettingsModule,
    FilesModule,
    FoldersModule,
    SharesModule,
  ],
})
export class AppModule {}
