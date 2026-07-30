/** 通用 QueryRunner mock 工厂：按 SQL 子串匹配返回值的 raw SQL 路由器 */
function createMockQueryRunner(routes: Array<{ match: string; params?: any[]; result: any }>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const queryRunner = {
    calls,
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockImplementation(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/^BEGIN/.test(sql)) return undefined;
      if (/^(COMMIT|ROLLBACK)/.test(sql)) return undefined;
      const route = routes.find((r) => sql.includes(r.match));
      if (!route) throw new Error(`Unmocked SQL: ${sql}`);
      if (route.params) expect(params).toEqual(route.params);
      return typeof route.result === 'function' ? route.result() : route.result;
    }),
  };
  return queryRunner;
}

describe('FoldersService', () => {
  describe('move', () => {
    it('should reject moving to a deleted target folder', async () => { /* findOne → null → NotFoundException */ });
    it('should reject moving to itself', async () => {});
    it('should reject moving to a descendant', async () => {});
    it('should move to root when newParentId is null', async () => {});
    it('should throw NotFound when conditional update affects 0 rows (concurrent delete)', async () => {});
  });

  describe('delete (atomic transaction)', () => {
    it('should commit when folder is empty（计数重查在 BEGIN 后、UPDATE 前）', async () => {
      // 断言 SQL 序列：BEGIN → SELECT folder → SELECT COUNT folders → SELECT COUNT files → UPDATE → COMMIT
    });
    it('should rollback when folder has subfolders（无 UPDATE 发出）', async () => {});
    it('should rollback when folder has non-deleted files', async () => {});
    it('should throw Conflict when conditional UPDATE affects 0 rows', async () => {});
  });
});
