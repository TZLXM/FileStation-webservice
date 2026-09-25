import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
import { createApp, initAndLogin, setupEnv, teardownEnv, type TestEnv, uploadSmallFile } from './helpers';

describe('Concurrency (Phase 2, HTTP E2E)', () => {
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

    const statuses = await Promise.all(ticketUrls.map(async (ticketUrl) => {
      const download = await request(server).get(ticketUrl);
      return download.status;
    }));

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

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(server)
          .post(`/api/v1/uploads/${uploadId}/complete`)
          .set('X-Upload-Token', uploadToken)
          .send({}),
      ),
    );
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

    const [resultA, resultB] = await Promise.all([putPart(partA), putPart(partB)]);
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

    const partResults = await Promise.all(uploads.map(({ id, token, content }) =>
      request(server)
        .put(`/api/v1/uploads/${id}/parts/0`)
        .set('X-Upload-Token', token)
        .set('X-Part-Checksum', createHash('sha256').update(content).digest('hex'))
        .set('Content-Type', 'application/octet-stream')
        .send(content),
    ));
    expect(partResults.map((result) => result.status)).toEqual([200, 200, 200, 200, 200]);

    const completeResults = await Promise.all(uploads.map(({ id, token }) =>
      request(server)
        .post(`/api/v1/uploads/${id}/complete`)
        .set('X-Upload-Token', token)
        .send({}),
    ));
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
