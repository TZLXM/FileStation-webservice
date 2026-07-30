/**
 * RFC 7233 单区间 Range 解析器（Phase 1 不支持多区间 multipart/byteranges）。
 *
 * 语义约定：
 *  - full：          无 Range 头。调用方不得传 start/end 给 createReadStream
 *                    （空文件 fileSize=0 时 full 合法：Content-Length=0，逻辑区间 start=0/end=-1 仅用于计算长度）
 *  - partial：       闭区间 [start, end]，均已按 fileSize 收敛（end 越界按 RFC 7233 §2.1 截断到 fileSize-1）
 *  - unsatisfiable： 语法合法但不可满足（start >= size、bytes=-0、空文件上的任何 Range）→ 416
 *  - invalid：       语法非法（错误 unit、多区间、bytes=-、start>end、数字溢出）→ 416
 *                    （v1.6 决策：invalid 也返回 416 而非 RFC 允许的"忽略 Range 头返回 200"，以便客户端获得明确错误；
 *                     此偏离需在 API 文档中向客户端明示）
 */
export type RangeParseResult =
  | { status: 'full' }
  | { status: 'partial'; start: number; end: number }
  | { status: 'unsatisfiable' }
  | { status: 'invalid' };

const RANGE_RE = /^bytes=(\d*)-(\d*)$/i;

export function parseRangeHeader(
  rangeHeader: string | undefined | null,
  fileSize: number,
): RangeParseResult {
  if (rangeHeader === undefined || rangeHeader === null || rangeHeader.trim() === '') {
    return { status: 'full' };
  }
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    return { status: 'invalid' };
  }

  const match = RANGE_RE.exec(rangeHeader.trim());
  if (!match) {
    return { status: 'invalid' }; // 多区间/错误 unit/bytes=-
  }

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) {
    return { status: 'invalid' }; // "bytes=-"
  }

  if (fileSize === 0) {
    return { status: 'unsatisfiable' }; // 空文件上任何 Range 都不可满足（416 时 Content-Range: bytes */0）
  }

  let start: number;
  let end: number;

  if (startStr && endStr) {
    // bytes=0-499
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { status: 'invalid' };
    if (start > end) return { status: 'invalid' };
    if (start >= fileSize) return { status: 'unsatisfiable' };
    end = Math.min(end, fileSize - 1);
  } else if (startStr) {
    // bytes=500-（开放范围）
    start = parseInt(startStr, 10);
    if (!Number.isSafeInteger(start)) return { status: 'invalid' };
    if (start >= fileSize) return { status: 'unsatisfiable' };
    end = fileSize - 1;
  } else {
    // bytes=-500（后缀范围）
    const suffixLength = parseInt(endStr, 10);
    if (!Number.isSafeInteger(suffixLength)) return { status: 'invalid' };
    if (suffixLength === 0) return { status: 'unsatisfiable' };
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  }

  return { status: 'partial', start, end };
}
