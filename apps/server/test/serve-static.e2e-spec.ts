import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import request from 'supertest';
import { applyStaticCacheHeaders } from '../src/app.module';

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
    await writeFile(
      join(webDist, 'assets', 'app-0123456789ab.js'),
      'globalThis.assetSentinel = true;',
    );

    Module({
      imports: [ServeStaticModule.forRoot({
        rootPath: webDist,
        exclude: ['/api/(.*)'],
        serveStaticOptions: {
          cacheControl: false,
          setHeaders: applyStaticCacheHeaders,
        },
      })],
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

  it('revalidates index and SPA fallback while keeping hashed assets immutable', async () => {
    const server = app!.getHttpServer();

    for (const endpoint of ['/', '/index.html', '/files', '/nested/client/route']) {
      const response = await request(server).get(endpoint).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
    }

    const hashed = await request(server)
      .get('/assets/app-0123456789ab.js')
      .expect(200)
      .expect('globalThis.assetSentinel = true;');
    expect(hashed.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );

    const unhashed = await request(server)
      .get('/assets/sentinel.txt')
      .expect(200);
    expect(unhashed.headers['cache-control']).toBe('no-cache');
  });

  it('applies no-store only to root and /fs/ index/fallback in the Nginx fixture', async () => {
    const raw = await readFile(
      resolve(__dirname, '../../../deploy/nginx/filestation.conf'),
      'utf8',
    );
    const configuration = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*#\s?/, ''))
      .join('\n');

    expect(configuration).toContain(
      'root /opt/filestation/current/apps/web/dist-root;',
    );
    expect(configuration).toContain(
      'alias /opt/filestation/current/apps/web/dist-fs/assets/;',
    );
    expect(configuration).toContain(
      'alias /opt/filestation/current/apps/web/dist-fs/index.html;',
    );
    expect(configuration).toContain(
      'alias /opt/filestation/current/apps/web/dist-fs/;',
    );
    expect(configuration.match(/Cache-Control "no-store" always/g)).toHaveLength(4);
    for (const location of ['/', '/fs/']) {
      const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(configuration).toMatch(new RegExp(
        `location\\s+${escaped}\\s*\\{[\\s\\S]*?`
        + 'Cache-Control "no-store" always;[\\s\\S]*?try_files',
      ));
    }
    // Interpret the fixture's status map for both deployment locations, including
    // negative responses. A blanket immutable 'always' or expires must fail here.
    const map = /map\s+\$status\s+\$filestation_asset_cache\s*\{([^}]+)\}/.exec(configuration);
    expect(map).not.toBeNull();
    const policies = new Map(Array.from(map![1].matchAll(/(default|\d+)\s+"([^"]+)"\s*;/g),
      (match) => [match[1], match[2]]));
    for (const location of ['/assets/', '/fs/assets/']) {
      const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const block = new RegExp(`location\\s+${escaped}\\s*\\{([^}]+)\\}`).exec(configuration)![1];
      expect(block).toMatch(/add_header Cache-Control \$filestation_asset_cache always;/);
      expect(block).not.toMatch(/expires\s/);
      for (const status of [200, 206, 304, 403, 404, 500, 503]) {
        const policy = policies.get(String(status)) ?? policies.get('default');
        expect(policy).toBe(status === 200 || status === 206 || status === 304
          ? 'public, max-age=31536000, immutable' : 'no-store');
      }
    }
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
