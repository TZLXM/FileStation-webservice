import { HttpException } from '@nestjs/common';

export class RangeNotSatisfiableException extends HttpException {
  constructor(public readonly fileSize: number) {
    super(
      {
        code: 'RANGE_NOT_SATISFIABLE',
        message: 'Requested range not satisfiable',
        file_size: fileSize,
      },
      416,
    );
  }
}
