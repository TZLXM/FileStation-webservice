import { Injectable, NotFoundException, GoneException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadTicket } from './entities/download-ticket.entity';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';

@Injectable()
export class DownloadTicketService {
  constructor(
    @InjectRepository(DownloadTicket)
    private ticketsRepository: Repository<DownloadTicket>,
  ) {}

  async createTicket(downloadSessionId: string): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('base64url'); // 256 bit
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 分钟

    const ticket = this.ticketsRepository.create({
      id: uuidv4(),
      tokenHash,
      downloadSessionId,
      createdAt: Date.now(),
      expiresAt,
    });
    await this.ticketsRepository.save(ticket);

    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** 验证票据：存在 + 未吊销 + 未过期。加载 downloadSession 关联（file 由 validateAuthorizedDownload 覆盖）。 */
  async validateTicket(token: string): Promise<DownloadTicket> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const ticket = await this.ticketsRepository.findOne({
      where: { tokenHash },
      relations: ['downloadSession'],
    });

    if (!ticket) {
      throw new NotFoundException({ code: 'TICKET_NOT_FOUND', message: 'Download ticket not found' });
    }
    if (ticket.revokedAt) {
      throw new GoneException({ code: 'TICKET_REVOKED', message: 'Download ticket has been revoked' });
    }
    if (ticket.expiresAt < Date.now()) {
      throw new GoneException({ code: 'TICKET_EXPIRED', message: 'Download ticket has expired' });
    }
    return ticket;
  }

  async revokeTicket(token: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.ticketsRepository.update({ tokenHash }, { revokedAt: Date.now() });
  }
}
