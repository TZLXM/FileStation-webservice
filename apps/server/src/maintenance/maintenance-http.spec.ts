import {
  Controller,
  Get,
  INestApplication,
  Module,
  Res,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import http from 'node:http';
import { once } from 'node:events';
import { Response } from 'express';
import { MaintenanceModule } from './maintenance.module';
import { MaintenanceAllowed } from './maintenance-allowed.decorator';
import { WriteBarrierService } from './write-barrier.service';

@Controller('business')
class BusinessController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true };
  }

  @Get('stream')
  stream(@Res() response: Response): void {
    response.status(200);
    response.write('a');
    setTimeout(() => response.end('b'), 50);
  }

  @Get('async-close')
  async asyncClose(@Res() response: Response): Promise<void> {
    response.status(200);
    response.flushHeaders();
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!response.destroyed) response.end('finished');
  }
}

@Controller('update-status')
class UpdateStatusController {
  @Get()
  @MaintenanceAllowed()
  read(): { phase: string } {
    return { phase: 'MAINTENANCE' };
  }
}

@Module({
  imports: [MaintenanceModule],
  controllers: [BusinessController, UpdateStatusController],
})
class FixtureModule {}

describe('maintenance HTTP admission', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FixtureModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects business routes with a stable maintenance response', async () => {
    app.get(WriteBarrierService).enterMaintenance({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: 'C:\\fixture\\install',
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    const response = await request(app.getHttpServer()).get('/business');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'UPDATE_MAINTENANCE',
      message: 'FileStation is temporarily unavailable while an update is prepared',
    });
    expect(response.headers['retry-after']).toBe('5');
  });

  it('allows only explicitly side-effect-free maintenance routes', async () => {
    app.get(WriteBarrierService).enterMaintenance({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: 'C:\\fixture\\install',
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await request(app.getHttpServer())
      .get('/update-status')
      .expect(200, { phase: 'MAINTENANCE' });
  });

  it('holds the lease through the response finish rather than handler completion', async () => {
    const address = app.getHttpServer().address() as {
      port: number;
    };
    const responsePromise = new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const request = http.get(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/business/stream',
          },
          resolve,
        );
        request.once('error', reject);
      },
    );

    const response = await responsePromise;
    expect(app.get(WriteBarrierService).activeLeaseCount).toBe(1);
    response.resume();
    await once(response, 'end');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.get(WriteBarrierService).activeLeaseCount).toBe(0);
  });

  it('keeps the lease until a surviving handler finishes after the client closes', async () => {
    const address = app.getHttpServer().address() as {
      port: number;
    };
    const closed = new Promise<void>((resolve, reject) => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/business/async-close',
        },
        (response) => {
          response.once('error', () => undefined);
          request.destroy();
          resolve();
        },
      );
      request.once('error', reject);
    });
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.get(WriteBarrierService).activeLeaseCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(app.get(WriteBarrierService).activeLeaseCount).toBe(0);
  });
});
