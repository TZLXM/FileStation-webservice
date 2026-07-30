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

/** 每个 describe 一套独立临时环境：DB + 存储 + 临时目录 */
interface TestEnv {
  dir: string;
  dbPath: string;
  storagePath: string;
  tempPath: string;
}

async function setupEnv(): Promise<TestEnv> {
  const dir = join(tmpdir(), `filestation-e2e-${uuidv4()}`);
  const env: TestEnv = {
    dir,
    dbPath: join(dir, 'test.db'),
    storagePath: join(dir, 'storage'),
    tempPath: join(dir, 'temp'),
  };
  await mkdir(env.storagePath, { recursive: true });
  await mkdir(env.tempPath, { recursive: true });

  // 关键：必须在 compile() 之前设置（configuration 工厂在 ConfigModule init 时读取）
  process.env.FILESTATION_DB_PATH = env.dbPath;
  process.env.FILESTATION_STORAGE_PATH = env.storagePath;
  process.env.FILESTATION_TEMP_PATH = env.tempPath;
  process.env.JWT_SECRET = 'e2e-test-secret';
  process.env.NODE_ENV = 'test';
  return env;
}

async function teardownEnv(env: TestEnv) {
  delete process.env.FILESTATION_DB_PATH;
  delete process.env.FILESTATION_STORAGE_PATH;
  delete process.env.FILESTATION_TEMP_PATH;
  await rm(env.dir, { recursive: true, force: true }); // 含 -wal/-shm
}

async function createApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  // 与 main.ts 完全一致的配置
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new RangeNotSatisfiableFilter()); // v1.7 高优 10：E2E 注册 416 filter
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true });
  await app.init();
  return app;
}

/** 完成初始化并登录，返回 accessToken */
async function initAndLogin(app: INestApplication): Promise<string> {
  const initToken = await app.get(AuthService).generateInitToken();

  await request(app.getHttpServer())
    .post('/api/v1/auth/init')
    .set('X-Init-Token', initToken) // v1.6：头部传递
    .send({ username: 'admin', password: 'StrongP@ssw0rd' })
    .expect(201);

  const loginRes = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: 'StrongP@ssw0rd' })
    .expect(200);

  return loginRes.body.data.access_token;
}

describe('Full flow (e2e): init -> login -> upload -> share -> download -> revoke', () => {
  let env: TestEnv;
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    accessToken = await initAndLogin(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('completes the entire lifecycle', async () => {
    const server = app.getHttpServer();
    const fileContent = Buffer.from('hello filestation world'); // 24 bytes，单块

    // 1. 初始化上传
    const initRes = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'hello.txt', size: fileContent.length })
      .expect(201);
    const { upload_id, upload_token } = initRes.body.data;

    // 2. 上传唯一分块（part 0）
    const checksum = createHash('sha256').update(fileContent).digest('hex');
    await request(server)
      .put(`/api/v1/uploads/${upload_id}/parts/0`)
      .set('X-Upload-Token', upload_token)
      .set('X-Part-Checksum', checksum)
      .set('Content-Type', 'application/octet-stream')
      .send(fileContent)
      .expect(200);

    // 3. 完成上传
    const completeRes = await request(server)
      .post(`/api/v1/uploads/${upload_id}/complete`)
      .set('X-Upload-Token', upload_token)
      .send({})
      .expect(201);
    const fileId = completeRes.body.data.file_id;
    expect(fileId).toBeTruthy();

    // 4. 创建免密分享
    const shareRes = await request(server)
      .post('/api/v1/shares')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ file_id: fileId, protection: 'none' })
      .expect(201);
    const shareId = shareRes.body.data.share_id;

    // 5. 统一 access 端点（v1.6：POST /shares/:id/access，免密不传 password）
    const accessRes = await request(server)
      .post(`/api/v1/shares/${shareId}/access`)
      .send({})
      .expect(200);
    const downloadToken = accessRes.body.data.download_token;
    expect(downloadToken).toBeTruthy();

    // 6. 创建下载票据
    const ticketRes = await request(server)
      .post(`/api/v1/shares/${shareId}/download-ticket`)
      .set('Authorization', `Bearer ${downloadToken}`)
      .send({})
      .expect(200);
    const ticketUrl = ticketRes.body.data.ticket_url; // /api/v1/downloads/:ticket

    // 7. Range 下载（bytes=0-4 → 206 'hello'）
    const rangeRes = await request(server)
      .get(ticketUrl)
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(rangeRes.headers['content-range']).toBe(`bytes 0-4/${fileContent.length}`);

    // 8. 完整下载（200）
    await request(server).get(ticketUrl).expect(200);

    // 9. 管理员吊销分享
    await request(server)
      .delete(`/api/v1/shares/${shareId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // 10. 吊销后：新 access 410；既有票据/既有 download token 复验失败（410）
    await request(server).post(`/api/v1/shares/${shareId}/access`).send({}).expect(410);
    await request(server).get(ticketUrl).expect(410);
    await request(server)
      .post(`/api/v1/shares/${shareId}/download-ticket`)
      .set('Authorization', `Bearer ${downloadToken}`)
      .send({})
      .expect(410);
  });

  it('password share: access with correct/incorrect password', async () => {
    const server = app.getHttpServer();
    // 上传一个文件
    const fileContent = Buffer.from('password protected content');
    const initRes = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'secret.txt', size: fileContent.length })
      .expect(201);
    const { upload_id, upload_token } = initRes.body.data;
    const checksum = createHash('sha256').update(fileContent).digest('hex');
    await request(server)
      .put(`/api/v1/uploads/${upload_id}/parts/0`)
      .set('X-Upload-Token', upload_token)
      .set('X-Part-Checksum', checksum)
      .send(fileContent)
      .expect(200);
    const completeRes = await request(server)
      .post(`/api/v1/uploads/${upload_id}/complete`)
      .set('X-Upload-Token', upload_token)
      .send({})
      .expect(201);
    const fileId = completeRes.body.data.file_id;

    // 创建密码分享
    const shareRes = await request(server)
      .post('/api/v1/shares')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ file_id: fileId, protection: 'password', password: 'pass1234' })
      .expect(201);
    const shareId = shareRes.body.data.share_id;

    // 无密码 access → 400 PASSWORD_REQUIRED
    await request(server).post(`/api/v1/shares/${shareId}/access`).send({}).expect(400);
    // 错误密码 → 400 INVALID_PASSWORD
    await request(server).post(`/api/v1/shares/${shareId}/access`).send({ password: 'wrong' }).expect(400);
    // 正确密码 → 200
    const accessRes = await request(server)
      .post(`/api/v1/shares/${shareId}/access`)
      .send({ password: 'pass1234' })
      .expect(200);
    expect(accessRes.body.data.download_token).toBeTruthy();
  });
});

describe('Concurrent initialization (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  it('two concurrent init requests: exactly one 201, one 4xx', async () => {
    const initToken = await app.get(AuthService).generateInitToken();
    const server = app.getHttpServer();

    const [r1, r2] = await Promise.all([
      request(server).post('/api/v1/auth/init').set('X-Init-Token', initToken)
        .send({ username: 'admin', password: 'StrongP@ssw0rd' }),
      request(server).post('/api/v1/auth/init').set('X-Init-Token', initToken)
        .send({ username: 'admin', password: 'StrongP@ssw0rd' }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(201);
    expect([400, 401, 409]).toContain(statuses[1]); // BEGIN IMMEDIATE 串行化后事务内重查拒绝

    // 第三次（token 已单次消费）必须失败
    await request(server).post('/api/v1/auth/init').set('X-Init-Token', initToken)
      .send({ username: 'x', password: 'y' }).expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
  });

  it('wrong init token is rejected', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/init')
      .set('X-Init-Token', 'wrong-token')
      .send({ username: 'a', password: 'b' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
