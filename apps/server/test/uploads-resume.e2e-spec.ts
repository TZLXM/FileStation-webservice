import request from 'supertest';
import { createHash } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { createApp, initAndLogin, setupEnv, teardownEnv, type TestEnv } from './helpers';

describe('Uploads resume contract (e2e)', () => {
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

  it('uses the upload token for status/resume and reports the authoritative received parts', async () => {
    const server = app.getHttpServer();
    const chunkSize = 64 * 1024;
    const content = Buffer.alloc(chunkSize + 9, 0x41);
    const init = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'resume.bin', size: content.length, chunk_size: chunkSize })
      .expect(201);
    const { upload_id: uploadId, upload_token: uploadToken } = init.body.data;

    await request(server).get(`/api/v1/uploads/${uploadId}`).expect(400);
    await request(server).get(`/api/v1/uploads/${uploadId}`).set('X-Upload-Token', 'wrong-token').expect(404);
    const statusBefore = await request(server)
      .get(`/api/v1/uploads/${uploadId}`)
      .set('X-Upload-Token', uploadToken)
      .expect(200);
    expect(statusBefore.body.data).toMatchObject({
      id: uploadId,
      status: 'initiated',
      received_parts: [],
      received_size: 0,
      total_parts: 2,
      expected_size: content.length,
    });

    const resumeBefore = await request(server)
      .post(`/api/v1/uploads/${uploadId}/resume`)
      .set('X-Upload-Token', uploadToken)
      .send({})
      .expect(201);
    expect(resumeBefore.body.data).toEqual({ received_parts: [], chunk_size: chunkSize });

    const firstPart = content.subarray(0, chunkSize);
    await request(server)
      .put(`/api/v1/uploads/${uploadId}/parts/0`)
      .set('X-Upload-Token', uploadToken)
      .set('X-Part-Checksum', createHash('sha256').update(firstPart).digest('hex'))
      .set('Content-Type', 'application/octet-stream')
      .send(firstPart)
      .expect(200);

    const statusAfter = await request(server)
      .get(`/api/v1/uploads/${uploadId}`)
      .set('X-Upload-Token', uploadToken)
      .expect(200);
    expect(statusAfter.body.data).toMatchObject({ status: 'uploading', received_parts: [0], received_size: chunkSize });

    const resumeAfter = await request(server)
      .post(`/api/v1/uploads/${uploadId}/resume`)
      .set('X-Upload-Token', uploadToken)
      .send({})
      .expect(201);
    expect(resumeAfter.body.data).toEqual({ received_parts: [0], chunk_size: chunkSize });
  });

  it('returns terminal status after abort and rejects later resume/abort with explicit state', async () => {
    const server = app.getHttpServer();
    const init = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'abort.bin', size: 0 })
      .expect(201);
    const { upload_id: uploadId, upload_token: uploadToken } = init.body.data;

    await request(server).delete(`/api/v1/uploads/${uploadId}`).set('X-Upload-Token', uploadToken).expect(200);
    const status = await request(server)
      .get(`/api/v1/uploads/${uploadId}`)
      .set('X-Upload-Token', uploadToken)
      .expect(200);
    expect(status.body.data.status).toBe('aborted');

    const resumeError = await request(server)
      .post(`/api/v1/uploads/${uploadId}/resume`)
      .set('X-Upload-Token', uploadToken)
      .send({})
      .expect(400);
    expect(resumeError.body).toMatchObject({ code: 'INVALID_UPLOAD_STATE', current: 'aborted' });

    const repeatAbortError = await request(server)
      .delete(`/api/v1/uploads/${uploadId}`)
      .set('X-Upload-Token', uploadToken)
      .expect(400);
    expect(repeatAbortError.body).toMatchObject({ code: 'INVALID_UPLOAD_STATE', current: 'aborted' });
  });

  it('reports completed sessions as terminal and accepts zero-byte completion without parts', async () => {
    const server = app.getHttpServer();
    const init = await request(server)
      .post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'empty.bin', size: 0 })
      .expect(201);
    const { upload_id: uploadId, upload_token: uploadToken } = init.body.data;

    const completed = await request(server)
      .post(`/api/v1/uploads/${uploadId}/complete`)
      .set('X-Upload-Token', uploadToken)
      .send({})
      .expect(201);
    expect(completed.body.data.file_id).toBeTruthy();

    const status = await request(server)
      .get(`/api/v1/uploads/${uploadId}`)
      .set('X-Upload-Token', uploadToken)
      .expect(200);
    expect(status.body.data).toMatchObject({ status: 'completed', received_parts: [], total_parts: 0, expected_size: 0 });

    const abortError = await request(server)
      .delete(`/api/v1/uploads/${uploadId}`)
      .set('X-Upload-Token', uploadToken)
      .expect(400);
    expect(abortError.body).toMatchObject({ code: 'INVALID_UPLOAD_STATE', current: 'completed' });
  });
});
