import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { LessThan, Repository } from 'typeorm';
import { isIPv4, isIPv6 } from 'net';
import { v4 as uuidv4 } from 'uuid';
import { AuditLogEntry, PaginatedResponse } from '@filestation/shared';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditEntry {
  accountId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export const AuditAction = {
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_API_TOKEN_EXCHANGED: 'auth.api_token_exchanged',
  API_TOKEN_CREATED: 'api_token.created',
  API_TOKEN_REVOKED: 'api_token.revoked',
  UPLOAD_INITIATED: 'upload.initiated',
  UPLOAD_COMPLETED: 'upload.completed',
  FILE_DELETED: 'file.deleted',
  SHARE_CREATED: 'share.created',
  SHARE_REVOKED: 'share.revoked',
  SETTINGS_UPDATED: 'settings.updated',
  MCP_TOOL_CALLED: 'mcp.tool_called',
  AUTH_TOTP_ENABLED: 'auth.totp_enabled',
  AUTH_TOTP_DISABLED: 'auth.totp_disabled',
  AUTH_TOTP_FAILED: 'auth.totp_failed',
  RECOVERY_GENERATED: 'recovery.generated',
  RECOVERY_USED: 'recovery.used',
} as const;

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
  ) {}

  /** Audit persistence must never change the outcome of a business operation. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.auditRepository.save({
        id: uuidv4(),
        accountId: entry.accountId,
        action: entry.action,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        details: entry.details ? JSON.stringify(entry.details) : null,
        ipAddress: entry.ip ? this.anonymizeIp(entry.ip) : null,
        userAgent: entry.userAgent ? entry.userAgent.slice(0, 256) : null,
        createdAt: Date.now(),
      });
    } catch {
      // Keep the warning generic so an unexpected payload cannot leak into application logs.
      try {
        this.logger.warn('audit record failed');
      } catch {
        // Logging failure must not block the operation either.
      }
    }
  }

  async findAll(page: number, pageSize: number, action?: string): Promise<PaginatedResponse<AuditLogEntry>> {
    const [rows, total] = await this.auditRepository.findAndCount({
      where: action ? { action } : {},
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items: rows.map((row) => this.toEntry(row)),
      total,
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  @Cron('0 4 * * *')
  async purgeExpired(): Promise<number> {
    const result = await this.auditRepository.delete({ createdAt: LessThan(Date.now() - RETENTION_MS) });
    return result.affected ?? 0;
  }

  private anonymizeIp(ip: string): string {
    if (!ip.includes(':')) {
      return isIPv4(ip) ? `${ip.split('.').slice(0, 3).join('.')}.0` : ip;
    }

    const address = ip.split('%')[0];
    if (!isIPv6(address)) return ip;

    const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    if (mappedIpv4 && isIPv4(mappedIpv4)) {
      return `::ffff:${mappedIpv4.split('.').slice(0, 3).join('.')}.0`;
    }

    let normalized = address;
    if (normalized.includes('.')) {
      const lastColon = normalized.lastIndexOf(':');
      const octets = normalized.slice(lastColon + 1).split('.').map(Number);
      const high = ((octets[0] << 8) | octets[1]).toString(16);
      const low = ((octets[2] << 8) | octets[3]).toString(16);
      normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
    }

    const [leftPart, rightPart] = normalized.split('::');
    const left = leftPart ? leftPart.split(':') : [];
    const right = rightPart ? rightPart.split(':') : [];
    const missingSegments = 8 - left.length - right.length;
    const segments = [...left, ...Array(Math.max(0, missingSegments)).fill('0'), ...right];
    const prefix = segments.slice(0, 3).map((segment) => Number.parseInt(segment, 16).toString(16));
    while (prefix[prefix.length - 1] === '0') prefix.pop();
    return prefix.length === 0 ? '::' : `${prefix.join(':')}::`;
  }

  private toEntry(row: AuditLog): AuditLogEntry {
    return {
      id: row.id,
      account_id: row.accountId,
      action: row.action,
      resource_type: row.resourceType,
      resource_id: row.resourceId,
      details: this.parseDetails(row.details),
      ip_address: row.ipAddress,
      user_agent: row.userAgent,
      created_at: new Date(row.createdAt).toISOString(),
    };
  }

  private parseDetails(details: string | null): AuditLogEntry['details'] {
    if (!details) return null;
    try {
      return JSON.parse(details) as AuditLogEntry['details'];
    } catch {
      // Corrupt historical rows should not prevent admins from reading the rest of the page.
      return null;
    }
  }
}
