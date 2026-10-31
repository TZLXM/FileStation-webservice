import { INestApplication } from '@nestjs/common';
import { ApplicationShutdownService } from './application-shutdown.service';

describe('ApplicationShutdownService', () => {
  it('closes the attached Nest application once', async () => {
    const close = jest.fn(async () => undefined);
    const service = new ApplicationShutdownService();
    service.attach({ close } as unknown as INestApplication);

    await Promise.all([service.close(), service.close()]);
    await service.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refuses shutdown when no application was attached', async () => {
    await expect(new ApplicationShutdownService().close()).rejects.toThrow(
      /application/i,
    );
  });
});
