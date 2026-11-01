import { Injectable } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class UpdateReauthService {
  constructor(private readonly auth: AuthService) {}

  async verify(
    adminId: string,
    password: string,
    totpCode: string | undefined,
    clientIp: string,
  ): Promise<void> {
    await this.auth.verifyUpdateConfirmation(
      adminId,
      password,
      totpCode,
      clientIp,
    );
  }
}
