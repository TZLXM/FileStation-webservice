import { parseRangeHeader } from './range-parser';

describe('parseRangeHeader（全矩阵）', () => {
  const SIZE = 1000;

  // full
  it('无 Range 头 → full', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ status: 'full' });
    expect(parseRangeHeader(null, SIZE)).toEqual({ status: 'full' });
    expect(parseRangeHeader('', SIZE)).toEqual({ status: 'full' });
    expect(parseRangeHeader('   ', SIZE)).toEqual({ status: 'full' });
  });

  // partial: bytes=0-499
  it('bytes=0-499 → partial [0,499]', () => {
    expect(parseRangeHeader('bytes=0-499', SIZE)).toEqual({ status: 'partial', start: 0, end: 499 });
  });
  it('end 越界按 RFC 截断到 size-1', () => {
    expect(parseRangeHeader('bytes=0-9999', SIZE)).toEqual({ status: 'partial', start: 0, end: 999 });
  });
  it('bytes=999-999（最后 1 字节）', () => {
    expect(parseRangeHeader('bytes=999-999', SIZE)).toEqual({ status: 'partial', start: 999, end: 999 });
  });

  // partial: bytes=500-（开放）
  it('bytes=500- → partial [500,999]', () => {
    expect(parseRangeHeader('bytes=500-', SIZE)).toEqual({ status: 'partial', start: 500, end: 999 });
  });

  // partial: bytes=-500（后缀）
  it('bytes=-500 → partial [500,999]', () => {
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({ status: 'partial', start: 500, end: 999 });
  });
  it('bytes=-2000（后缀超 size）→ 从 0 开始', () => {
    expect(parseRangeHeader('bytes=-2000', SIZE)).toEqual({ status: 'partial', start: 0, end: 999 });
  });

  // unsatisfiable
  it('start >= size → unsatisfiable', () => {
    expect(parseRangeHeader('bytes=1000-', SIZE)).toEqual({ status: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=2000-3000', SIZE)).toEqual({ status: 'unsatisfiable' });
  });
  it('bytes=-0 → unsatisfiable', () => {
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ status: 'unsatisfiable' });
  });

  // invalid
  it('start > end → invalid', () => {
    expect(parseRangeHeader('bytes=500-499', SIZE)).toEqual({ status: 'invalid' });
  });
  it('bytes=-（空）→ invalid', () => {
    expect(parseRangeHeader('bytes=-', SIZE)).toEqual({ status: 'invalid' });
  });
  it('多区间 → invalid', () => {
    expect(parseRangeHeader('bytes=0-1,3-4', SIZE)).toEqual({ status: 'invalid' });
  });
  it('错误 unit → invalid', () => {
    expect(parseRangeHeader('items=0-499', SIZE)).toEqual({ status: 'invalid' });
  });

  // 空文件
  it('空文件 full 合法', () => {
    expect(parseRangeHeader(undefined, 0)).toEqual({ status: 'full' });
  });
  it('空文件任何 Range → unsatisfiable', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ status: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-100', 0)).toEqual({ status: 'unsatisfiable' });
  });

  // 非法 fileSize
  it('fileSize 非法 → invalid', () => {
    expect(parseRangeHeader('bytes=0-1', -1)).toEqual({ status: 'invalid' });
    expect(parseRangeHeader('bytes=0-1', NaN)).toEqual({ status: 'invalid' });
  });
});
