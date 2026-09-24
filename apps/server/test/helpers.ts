import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, rm } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { RangeNotSatisfiableFilter } from '../src/common/http/range-not-satisfiable.filter';

export interface TestEnv { dir: string; dbPath: string; storagePath: string; tempPath: string; }

export async function setupEnv(): Promise<TestEnv> {
  const dir = join(tmpdir(), `filestation-e2e-${uuidv4()}`);
  const env: TestEnv = { dir, dbPath: join(dir, 'test.db'), storagePath: join(dir, 'storage'), tempPath: join(dir, 'temp') };
  await mkdir(env.storagePath, { recursive: true });
  await mkdir(env.tempPath, { recursive: true });
  process.env.FILESTATION_DB_PATH = env.dbPath;
  process.env.FILESTATION_STORAGE_PATH = env.storagePath;
  process.env.FILESTATION_TEMP_PATH = env.tempPath;
  process.env.JWT_SECRET = 'e2e-test-secret';
  process.env.NODE_ENV = 'test';
  return env;
}

export async function teardownEnv(env: TestEnv): Promise<void> {
  delete process.env.FILESTATION_DB_PATH;
  delete process.env.FILESTATION_STORAGE_PATH;
  delete process.env.FILESTATION_TEMP_PATH;
  await rm(env.dir, { recursive: true, force: true });
}

export async function createApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new RangeNotSatisfiableFilter());
  await app.init();
  return app;
}

export async function initAndLogin(app: INestApplication): Promise<string> {
  const initToken = await app.get(AuthService).generateInitToken();
  await request(app.getHttpServer()).post('/api/v1/auth/init')
    .set('X-Init-Token', initToken)
    .send({ username: 'admin', password: 'StrongP@ssw0rd' }).expect(201);
  const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login')
    .send({ username: 'admin', password: 'StrongP@ssw0rd' }).expect(200);
  return loginRes.body.data.access_token;
}

/** 上传一个单分块小文件（initialize → PUT part → complete 全流程），返回 fileId */
export async function uploadSmallFile(server: any, accessToken: string, filename: string, content: Buffer): Promise<string> {
  const initRes = await request(server).post('/api/v1/uploads')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ filename, size: content.length }).expect(201);
  const { upload_id, upload_token } = initRes.body.data;
  const checksum = createHash('sha256').update(content).digest('hex');
  await request(server).put(`/api/v1/uploads/${upload_id}/parts/0`)
    .set('X-Upload-Token', upload_token)
    .set('X-Part-Checksum', checksum)
    .set('Content-Type', 'application/octet-stream')
    .send(content).expect(200);
  const completeRes = await request(server).post(`/api/v1/uploads/${upload_id}/complete`)
    .set('X-Upload-Token', upload_token).send({}).expect(201);
  return completeRes.body.data.file_id;
}
