import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminAccount } from './entities/admin-account.entity';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(AdminAccount)
    private accountsRepository: Repository<AdminAccount>,
  ) {}

  async createAccount(username: string, password: string): Promise<AdminAccount> {
    const existing = await this.accountsRepository.findOne({ where: { username } });
    if (existing) {
      throw new ConflictException('Username already exists');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const now = Date.now();

    const account = this.accountsRepository.create({
      id: uuidv4(),
      username,
      passwordHash,
      passwordChangedAt: now,
      createdAt: now,
      isActive: 1,
    });

    return this.accountsRepository.save(account);
  }

  async findByUsername(username: string): Promise<AdminAccount | null> {
    return this.accountsRepository.findOne({ where: { username, isActive: 1 } });
  }

  async findById(id: string): Promise<AdminAccount | null> {
    return this.accountsRepository.findOne({ where: { id, isActive: 1 } });
  }

  async validatePassword(account: AdminAccount, password: string): Promise<boolean> {
    return bcrypt.compare(password, account.passwordHash);
  }

  async changePassword(accountId: string, newPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.accountsRepository.update(accountId, {
      passwordHash,
      passwordChangedAt: Date.now(),
    });
  }

  async getAccountCount(): Promise<number> {
    return this.accountsRepository.count({ where: { isActive: 1 } });
  }
}
