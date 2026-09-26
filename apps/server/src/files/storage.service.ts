import { Injectable, BadRequestException, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream, createReadStream, promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly storagePath: string;
  private readonly tempPath: string;

  constructor(private configService: ConfigService) {
    this.storagePath = this.configService.get<string>('app.storagePath') || './data/storage';
    this.tempPath = this.configService.get<string>('app.tempPath') || './data/temp';
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureDirectories();
  }

  async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.storagePath, { recursive: true });
    await fs.mkdir(this.tempPath, { recursive: true });
  }

  getTempRoot(): string {
    return this.tempPath;
  }

  getStorageRoot(): string {
    return this.storagePath;
  }

  getUploadTempDir(uploadId: string): string {
    return join(this.tempPath, uploadId);
  }

  getPartPath(uploadId: string, partNumber: number): string {
    return join(this.tempPath, uploadId, `part_${partNumber.toString().padStart(6, '0')}.part`);
  }

  getPartTempPath(uploadId: string, partNumber: number, uniqueId: string): string {
    return join(this.tempPath, uploadId, `part_${partNumber.toString().padStart(6, '0')}.${uniqueId}.part.tmp`);
  }

  getFinalPath(storedName: string): string {
    return join(this.storagePath, storedName);
  }

  /** Each verification owner stages to a distinct path so an obsolete owner cannot unlink its successor's output. */
  getVerificationTempPath(storedName: string, ownerToken: string): string {
    return this.getFinalPath(`${storedName}.verify-${ownerToken}.tmp`);
  }

  async createUploadTempDir(uploadId: string): Promise<void> {
    await fs.mkdir(this.getUploadTempDir(uploadId), { recursive: true });
  }

  /** 写 owner 专属临时文件（write + fsync）并校验 checksum。不做 rename，仅在事务外调用。 */
  async writePartToTemp(uploadId: string, partNumber: number, uniqueId: string, data: Buffer, expectedChecksum: string): Promise<void> {
    const tempPath = this.getPartTempPath(uploadId, partNumber, uniqueId);
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actualChecksum = createHash('sha256').update(data).digest('hex');
    if (actualChecksum !== expectedChecksum) {
      await fs.unlink(tempPath).catch(() => {});
      throw new BadRequestException({
        code: 'CHECKSUM_MISMATCH',
        message: 'Part checksum mismatch',
        expected: expectedChecksum,
        actual: actualChecksum,
      });
    }
  }

  /** 把 owner 的临时文件原子 rename 到正式分块路径。仅在事务外调用。 */
  async renamePart(uploadId: string, partNumber: number, uniqueId: string): Promise<void> {
    await fs.rename(this.getPartTempPath(uploadId, partNumber, uniqueId), this.getPartPath(uploadId, partNumber));
  }

  /** 删除 owner 自己的临时文件（幂等），绝不删正式分块。 */
  async deleteTempPart(uploadId: string, partNumber: number, uniqueId: string): Promise<void> {
    await fs.unlink(this.getPartTempPath(uploadId, partNumber, uniqueId)).catch(() => {});
  }

  /** 删除正式分块（仅供 abort/cleanup 使用，禁止在事务内或 uploadPart 正常路径调用）。 */
  async deletePart(uploadId: string, partNumber: number): Promise<void> {
    await fs.unlink(this.getPartPath(uploadId, partNumber)).catch(() => {});
  }

  async deleteUploadTempDir(uploadId: string): Promise<void> {
    await fs.rm(this.getUploadTempDir(uploadId), { recursive: true, force: true });
  }

  async combineParts(uploadId: string, totalParts: number, finalPath: string, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const writeStream = createWriteStream(finalPath);
    let succeeded = false;
    let writeError: Error | null = null;
    writeStream.on('error', (error) => { writeError = error; });
    try {
      for (let i = 0; i < totalParts; i++) {
        this.throwIfAborted(signal);
        if (writeError) throw writeError;
        const readStream = createReadStream(this.getPartPath(uploadId, i));
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            signal?.removeEventListener('abort', onAbort);
            readStream.removeListener('error', onError);
            writeStream.removeListener('error', onError);
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onAbort = () => {
            const error = this.createAbortError();
            readStream.destroy();
            writeStream.destroy();
            cleanup();
            reject(error);
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          readStream.pipe(writeStream, { end: false });
          readStream.once('end', () => {
            cleanup();
            resolve();
          });
          readStream.once('error', onError);
          writeStream.once('error', onError);
        });
      }
      this.throwIfAborted(signal);
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onError = (error: Error) => {
          cleanup();
          writeStream.removeListener('finish', onFinish);
          reject(error);
        };
        const onFinish = () => {
          cleanup();
          writeStream.removeListener('error', onError);
          resolve();
        };
        const onClose = () => {
          if (signal?.aborted) onError(this.createAbortError());
        };
        const onAbort = () => writeStream.destroy();
        writeStream.once('error', onError);
        writeStream.once('finish', onFinish);
        writeStream.once('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      if (writeError) throw writeError;
      this.throwIfAborted(signal);
      const handle = await fs.open(finalPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.throwIfAborted(signal);
      succeeded = true;
    } finally {
      if (!succeeded) {
        if (!writeStream.closed) {
          await new Promise<void>((resolve) => {
            writeStream.once('close', resolve);
            writeStream.destroy();
          });
        }
        await fs.unlink(finalPath).catch(() => {});
      }
    }
  }

  /** ENOENT 幂等：已被手动删除视为成功（防生命周期任务死循环重试）；其他错误抛出。 */
  async deleteFile(storedName: string): Promise<void> {
    try {
      await fs.unlink(this.getFinalPath(storedName));
    } catch (err: any) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
  }

  /** full 下载不传 start/end（空文件 createReadStream 安全）。 */
  async getFileStream(storedName: string, start?: number, end?: number) {
    const options: any = {};
    if (start !== undefined) options.start = start;
    if (end !== undefined) options.end = end;
    return createReadStream(this.getFinalPath(storedName), options);
  }

  async getFileStats(storedName: string) {
    return fs.stat(this.getFinalPath(storedName));
  }

  async fileExists(storedName: string): Promise<boolean> {
    try {
      await fs.access(this.getFinalPath(storedName));
      return true;
    } catch {
      return false;
    }
  }

  generateStoredName(): string {
    return uuidv4();
  }

  /** 接受绝对路径（calculateFileHash(getFinalPath(storedName))）。 */
  async calculateFileHash(filePath: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(this.createAbortError());
        return;
      }
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => stream.destroy(this.createAbortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => {
        cleanup();
        resolve(hash.digest('hex'));
      });
      stream.on('error', (error) => {
        cleanup();
        reject(error);
      });
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.createAbortError();
  }

  private createAbortError(): Error {
    const error = new Error('File operation was aborted');
    error.name = 'AbortError';
    return error;
  }
}
