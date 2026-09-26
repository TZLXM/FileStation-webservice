import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
import { createApp, initAndLogin, setupEnv, teardownEnv, type TestEnv, uploadSmallFile } from './helpers';
import { UploadsService } from '../src/files/uploads.service';
import { StorageService } from '../src/files/storage.service';

function createBarrier(expected: number) {
  let resolveArrivals!: () => void;
  let releaseArrivals!: () => void;
  let arrivalCount = 0;
  const arrivals = new Promise<void>((resolve) => { resolveArrivals = resolve; });
  const released = new Promise<void>((resolve) => { releaseArrivals = resolve; });

  return {
    get count() { return arrivalCount; },
    async arrive(): Promise<void> {
      arrivalCount += 1;
      if (arrivalCount > expected) throw new Error(`Barrier received more than ${expected} participants`);
      if (arrivalCount === expected) resolveArrivals();
      await released;
    },
    async waitForAll(timeoutMs = 10_000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          arrivals,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Barrier reached ${arrivalCount}/${expected} participants`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    release(): void { releaseArrivals(); },
  };
}

type HttpBarrier = ReturnType<typeof createBarrier> & { matches(method: string, path: string): boolean };

async function waitForCondition(condition: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('Concurrency (Phase 2, HTTP E2E)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let accessToken: string;
  let activeHttpBarrier: HttpBarrier | null = null;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp((testApp) => {
      testApp.use((req: any, _res: any, next: (error?: unknown) => void) => {
        const barrier = activeHttpBarrier;
        if (!barrier || !barrier.matches(req.method, req.path)) {
          next();
          return;
        }
        void barrier.arrive().then(() => next(), next);
      });
    });
    accessToken = await initAndLogin(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownEnv(env);
  });

  function httpBarrier(expected: number, matches: (method: string, path: string) => boolean): HttpBarrier {
    return Object.assign(createBarrier(expected), { matches });
  }

  function startBehindHttpBarrier<T>(barrier: HttpBarrier, operation: () => Promise<T>) {
    activeHttpBarrier = barrier;
    const result = Promise.resolve().then(operation);
    void result.catch(() => {});
    const arrivals = barrier.waitForAll().finally(() => {
      barrier.release();
      if (activeHttpBarrier === barrier) activeHttpBarrier = null;
    });
    return { arrivals, result };
  }

  function installStorageGate(expected: number) {
    const storage = app.get(StorageService);
    const gate = createBarrier(expected);
    const original = storage.writePartToTemp.bind(storage);
    const spy = jest.spyOn(storage, 'writePartToTemp').mockImplementation(async (...args) => {
      await gate.arrive();
      return original(...args);
    });
    return { gate, restore: () => spy.mockRestore() };
  }

  function installCombineGate(expected: number) {
    const storage = app.get(StorageService);
    const gate = createBarrier(expected);
    const original = storage.combineParts.bind(storage);
    const spy = jest.spyOn(storage, 'combineParts').mockImplementation(async (...args) => {
      await gate.arrive();
      return original(...args);
    });
    return { gate, restore: () => spy.mockRestore() };
  }

  it('concurrent downloads claim exactly the configured share quota', async () => {
    const server = app.getHttpServer();
    const fileId = await uploadSmallFile(server, accessToken, 'quota.txt', Buffer.from('quota test'));
    const shareRes = await request(server)
      .post('/api/v1/shares')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ file_id: fileId, protection: 'none', max_downloads: 2 })
      .expect(201);
    const shareId = shareRes.body.data.share_id as string;

    // Prepare separate sessions/tickets first so all ten requests reach the same quota boundary.
    const ticketUrls: string[] = [];
    for (let i = 0; i < 10; i++) {
      const access = await request(server).post(`/api/v1/shares/${shareId}/access`).send({}).expect(200);
      const ticket = await request(server)
        .post(`/api/v1/shares/${shareId}/download-ticket`)
        .set('Authorization', `Bearer ${access.body.data.download_token}`)
        .send({})
        .expect(200);
      ticketUrls.push(ticket.body.data.ticket_url);
    }

    const gate = httpBarrier(10, (method, path) => method === 'GET' && path.startsWith('/api/v1/downloads/'));
    const { arrivals, result: statusesPromise } = startBehindHttpBarrier(gate, () => Promise.all(
      ticketUrls.map((ticketUrl) => request(server).get(ticketUrl).then((download) => download.status)),
    ));
    await arrivals;
    expect(gate.count).toBe(10);
    const statuses = await statusesPromise;

    expect(statuses.every((status) => status < 500)).toBe(true);
    expect(statuses).toHaveLength(10);
    expect(statuses.filter((status) => status === 200)).toHaveLength(2);
    expect(statuses.filter((status) => status === 410)).toHaveLength(8);

    const shares = await request(server)
      .get(`/api/v1/shares?file_id=${fileId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const share = shares.body.data.find((item: { id: string }) => item.id === shareId);
    expect(share?.used_downloads).toBe(2);
  });

  it('concurrent complete calls all return the same completed file', async () => {
    const server = app.getHttpServer();
    const content = Buffer.from('concurrent complete content');
    const init = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'race-complete.bin', size: content.length })
      .expect(201);
    const { upload_id: uploadId, upload_token: uploadToken } = init.body.data;
    const checksum = createHash('sha256').update(content).digest('hex');

    await request(server)
      .put(`/api/v1/uploads/${uploadId}/parts/0`)
      .set('X-Upload-Token', uploadToken)
      .set('X-Part-Checksum', checksum)
      .set('Content-Type', 'application/octet-stream')
      .send(content)
      .expect(200);

    const httpGate = httpBarrier(5, (method, path) => method === 'POST' && path === `/api/v1/uploads/${uploadId}/complete`);
    const combineGate = installCombineGate(1);
    const { arrivals, result: resultsPromise } = startBehindHttpBarrier(httpGate, () => Promise.all(
      Array.from({ length: 5 }, () =>
        request(server)
          .post(`/api/v1/uploads/${uploadId}/complete`)
          .set('X-Upload-Token', uploadToken)
          .send({}),
      ),
    ));
    let waitError: unknown;
    try {
      await arrivals;
      expect(httpGate.count).toBe(5);
      await combineGate.gate.waitForAll();
      expect(combineGate.gate.count).toBe(1);
      const service = app.get(UploadsService) as any;
      await waitForCondition(
        () => service.finalizationObservers?.get(uploadId)?.waiters === 4,
        'four same-upload callers to join one finalization observer',
      );
    } catch (error) {
      waitError = error;
    } finally {
      combineGate.gate.release();
      combineGate.restore();
    }
    const results = await resultsPromise;
    if (waitError) throw waitError;
    expect(results.map((result) => result.status)).toEqual([201, 201, 201, 201, 201]);

    const fileIds = results.map((result) => result.body?.data?.file_id);
    expect(fileIds.every(Boolean)).toBe(true);
    expect(new Set(fileIds).size).toBe(1);

    const files = await request(server)
      .get('/api/v1/files?page_size=100')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const matchingFiles = files.body.data.items.filter(
      (file: { filename: string }) => file.filename === 'race-complete.bin',
    );
    expect(matchingFiles).toHaveLength(1);
    expect(matchingFiles[0].id).toBe(fileIds[0]);
  });

  it('disconnecting a complete loser cancels only its shared-observer wait', async () => {
    const server = app.getHttpServer();
    const content = Buffer.from('abort one finalization observer waiter');
    const init = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'abort-finalize-waiter.bin', size: content.length })
      .expect(201);
    const { upload_id: uploadId, upload_token: uploadToken } = init.body.data;
    const checksum = createHash('sha256').update(content).digest('hex');
    await request(server)
      .put(`/api/v1/uploads/${uploadId}/parts/0`)
      .set('X-Upload-Token', uploadToken)
      .set('X-Part-Checksum', checksum)
      .set('Content-Type', 'application/octet-stream')
      .send(content)
      .expect(200);

    const combineGate = installCombineGate(1);
    const ownerRequest = request(server)
      .post(`/api/v1/uploads/${uploadId}/complete`)
      .set('X-Upload-Token', uploadToken)
      .send({});
    const ownerResultPromise = ownerRequest.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let ownerSettled = false;
    void ownerResultPromise.then(() => { ownerSettled = true; });
    let released = false;
    try {
      await combineGate.gate.waitForAll();
      expect(combineGate.gate.count).toBe(1);

      const loserRequest = request(server)
        .post(`/api/v1/uploads/${uploadId}/complete`)
        .set('X-Upload-Token', uploadToken)
        .send({});
      const loserResultPromise = loserRequest.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const service = app.get(UploadsService) as any;
      await waitForCondition(
        () => service.finalizationObservers?.get(uploadId)?.waiters === 1,
        'disconnected request to join the finalization observer',
      );

      loserRequest.abort();
      const loserOutcome = await loserResultPromise;
      expect('error' in loserOutcome).toBe(true);
      await waitForCondition(
        () => !service.finalizationObservers?.has(uploadId),
        'aborted waiter to leave and cancel its observer',
      );
      expect(ownerSettled).toBe(false);
    } finally {
      combineGate.gate.release();
      combineGate.restore();
      released = true;
    }

    const ownerOutcome = await ownerResultPromise;
    expect(ownerSettled).toBe(true);
    if ('error' in ownerOutcome) throw ownerOutcome.error;
    expect(ownerOutcome.result.status).toBe(201);
    expect(released).toBe(true);
  });

  it('conflicting concurrent part writes have one winner whose bytes are finalized', async () => {
    const server = app.getHttpServer();
    const partA = Buffer.from('AAAA-part-zero-content');
    const partB = Buffer.from('BBBB-part-zero-content');
    expect(partA.length).toBe(partB.length);

    const init = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'race-part.bin', size: partA.length })
      .expect(201);
    const { upload_id: uploadId, upload_token: uploadToken } = init.body.data;
    const putPart = (content: Buffer) =>
      request(server)
        .put(`/api/v1/uploads/${uploadId}/parts/0`)
        .set('X-Upload-Token', uploadToken)
        .set('X-Part-Checksum', createHash('sha256').update(content).digest('hex'))
        .set('Content-Type', 'application/octet-stream')
        .send(content);

    const httpGate = httpBarrier(2, (method, path) => method === 'PUT' && path === `/api/v1/uploads/${uploadId}/parts/0`);
    const writeGate = installStorageGate(1);
    let requestA!: Promise<request.Response>;
    let requestB!: Promise<request.Response>;
    const { arrivals, result: resultsPromise } = startBehindHttpBarrier(httpGate, () => {
      requestA = putPart(partA).then((result) => result);
      requestB = putPart(partB).then((result) => result);
      return Promise.all([requestA, requestB]);
    });
    let winnerHeld = false;
    let earlyResponse: request.Response | undefined;
    try {
      await arrivals;
      expect(httpGate.count).toBe(2);
      await writeGate.gate.waitForAll();
      expect(writeGate.gate.count).toBe(1);
      winnerHeld = true;
      earlyResponse = await Promise.race([requestA, requestB]);
      expect(earlyResponse.status).toBe(409);
    } finally {
      writeGate.gate.release();
      writeGate.restore();
    }
    const [resultA, resultB] = await resultsPromise;
    if (!winnerHeld) throw new Error('The part winner did not reach the held file-write stage');
    expect([resultA.status, resultB.status].sort()).toEqual([200, 409]);

    const completed = await request(server)
      .post(`/api/v1/uploads/${uploadId}/complete`)
      .set('X-Upload-Token', uploadToken)
      .send({})
      .expect(201);
    const fileId = completed.body.data.file_id as string;

    const contentRes = await request(server)
      .get(`/api/v1/files/${fileId}/content`)
      .set('Authorization', `Bearer ${accessToken}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const winner = resultA.status === 200 ? partA : partB;
    expect(Buffer.compare(contentRes.body as Buffer, winner)).toBe(0);
  });

  it('parallel part claims and finalization across different upload sessions remain isolated', async () => {
    const server = app.getHttpServer();
    const uploads: Array<{ id: string; token: string; content: Buffer; filename: string }> = [];

    for (let index = 0; index < 5; index++) {
      const filename = `parallel-${index}.bin`;
      const content = Buffer.from(`parallel upload content ${index}`);
      const init = await request(server)
        .post('/api/v1/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename, size: content.length })
        .expect(201);
      uploads.push({ id: init.body.data.upload_id, token: init.body.data.upload_token, content, filename });
    }

    const partGate = installStorageGate(5);
    const partResultsPromise = Promise.all(uploads.map(({ id, token, content }) =>
      request(server)
        .put(`/api/v1/uploads/${id}/parts/0`)
        .set('X-Upload-Token', token)
        .set('X-Part-Checksum', createHash('sha256').update(content).digest('hex'))
        .set('Content-Type', 'application/octet-stream')
        .send(content)
        .then((result) => result),
    ));
    let partGateError: unknown;
    try {
      await partGate.gate.waitForAll();
      expect(partGate.gate.count).toBe(5);
    } catch (error) {
      partGateError = error;
    } finally {
      partGate.gate.release();
      partGate.restore();
    }
    const partResults = await partResultsPromise;
    if (partGateError) throw partGateError;
    expect(partResults.map((result) => result.status)).toEqual([200, 200, 200, 200, 200]);

    const combineGate = installCombineGate(5);
    const completeResultsPromise = Promise.all(uploads.map(({ id, token }) =>
      request(server)
        .post(`/api/v1/uploads/${id}/complete`)
        .set('X-Upload-Token', token)
        .send({})
        .then((result) => result),
    ));
    let combineGateError: unknown;
    try {
      await combineGate.gate.waitForAll();
      expect(combineGate.gate.count).toBe(5);
    } catch (error) {
      combineGateError = error;
    } finally {
      combineGate.gate.release();
      combineGate.restore();
    }
    const completeResults = await completeResultsPromise;
    if (combineGateError) throw combineGateError;
    expect(completeResults.map((result) => result.status)).toEqual([201, 201, 201, 201, 201]);
    const fileIds = completeResults.map((result) => result.body?.data?.file_id);
    expect(fileIds.every(Boolean)).toBe(true);
    expect(new Set(fileIds).size).toBe(5);

    const files = await request(server)
      .get('/api/v1/files?page_size=100')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    for (const upload of uploads) {
      expect(files.body.data.items.filter((file: { filename: string }) => file.filename === upload.filename)).toHaveLength(1);
    }
  });
});
