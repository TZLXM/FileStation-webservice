import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { installNonMcpBodyParsers } from './body-parsers';
import { RangeNotSatisfiableFilter } from './range-not-satisfiable.filter';
import { setupSwagger } from '../swagger/setup-swagger';

/** Shared HTTP pipeline for normal and post-COMMITTED gated service. */
export function setupFullApplication(
  app: INestApplication,
  configService: ConfigService,
): void {
  installNonMcpBodyParsers(app);
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  setupSwagger(app);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new RangeNotSatisfiableFilter());
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
  if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  }
}
