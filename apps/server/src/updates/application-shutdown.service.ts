import { INestApplication, Injectable } from '@nestjs/common';

@Injectable()
export class ApplicationShutdownService {
  private application?: INestApplication;
  private closing?: Promise<void>;

  attach(application: INestApplication): void {
    if (this.application && this.application !== application) {
      throw new Error('another Nest application is already attached');
    }
    this.application = application;
  }

  async close(): Promise<void> {
    if (!this.application) {
      throw new Error('Nest application is not attached for shutdown');
    }
    if (!this.closing) {
      this.closing = this.application.close();
    }
    return this.closing;
  }
}
