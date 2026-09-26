import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

@Controller('files')
class StaticApiProbeController {
  @Get()
  listFiles() {
    return { source: 'api-controller' };
  }
}

class StaticApiProbeModule {}

describe('ServeStatic (HTTP E2E)', () => {
  let app: INestApplication | undefined;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'filestation-static-e2e-'));
    const webDist = join(fixtureDir, 'web-dist');
    await mkdir(join(webDist, 'assets'), { recursive: true });
    await writeFile(join(webDist, 'index.html'), '<!doctype html><html><body><main>spa-sentinel</main></body></html>');
    await writeFile(join(webDist, 'assets', 'sentinel.txt'), 'asset-sentinel');

    Module({
      imports: [ServeStaticModule.forRoot({ rootPath: webDist, exclude: ['/api/(.*)'] })],
      controllers: [StaticApiProbeController],
    })(StaticApiProbeModule);
    app = await NestFactory.create(StaticApiProbeModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it('serves built assets and the SPA index for client-side routes', async () => {
    const server = app!.getHttpServer();
    await request(server).get('/assets/sentinel.txt').expect(200).expect('asset-sentinel');
    await request(server).get('/files').expect(200).expect(/spa-sentinel/);
  });

  it('excludes API paths from the SPA fallback', async () => {
    const response = await request(app!.getHttpServer())
      .get('/api/v1/files')
      .expect(200)
      .expect('Content-Type', /json/);
    expect(response.body).toEqual({ source: 'api-controller' });
    expect(response.text).not.toContain('spa-sentinel');
  });
});
