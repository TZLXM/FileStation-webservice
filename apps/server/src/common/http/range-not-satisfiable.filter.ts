import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Response } from 'express';
import { RangeNotSatisfiableException } from './range-not-satisfiable.exception';

@Catch(RangeNotSatisfiableException)
export class RangeNotSatisfiableFilter implements ExceptionFilter {
  catch(exception: RangeNotSatisfiableException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res
      .status(416)
      .setHeader('Content-Range', `bytes */${exception.fileSize}`) // RFC 7233 要求
      .setHeader('Content-Type', 'application/json');
    res.json({
      code: 'RANGE_NOT_SATISFIABLE',
      message: 'Requested range not satisfiable',
      data: { file_size: exception.fileSize },
      request_id: crypto.randomUUID(),
    });
  }
}
