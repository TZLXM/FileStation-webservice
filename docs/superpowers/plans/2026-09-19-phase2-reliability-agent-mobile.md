# FileStation Phase 2 实施计划 v1.2（可靠性 + Agent 接入 + 移动端适配）

> v1.2：吸收外部复审（2026-09-24）新发现 4 项（A/B/C/D），修订映射见文末"v1.2 修订记录"。关键变更：`upload_init` 缺省 chunk_size 服务端 8MB 硬钳（开工前门槛项）、ADR-0005 决策 7 事实订正（192 bit / 直接按 hash 查询）、`@RequireScopes()` 空参兜底、SDK `.tool()` 废弃迁移路径成文。
>
> v1.1：吸收外部评审（2026-09-23）全部 20 项 + 5 决策点，修订映射见文末"v1.1 修订记录"。关键变更：e2e 命令修正、MCP SDK 锁定 1.30 + zod 3、MCP 上传拆三件套、scope 检查内置 JwtAuthGuard、恢复码熵修正、totp_active 剥离落库。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **范围说明**：Phase 2 在原"可靠性"基础上扩展为三条主线，经用户确认（2026-09-19）：
> - **A. Agent 接入（最高优先级）**：API Token（scopes）→ 审计日志 → **MCP 服务内嵌主应用**（设置页开关，不做独立 MCP 包）
> - **B. 移动端 UI 适配**：基于移动端视口实测确认的问题清单（见 Task 6）
> - **C/D. 认证加固与稳定性**：TOTP、恢复码、断点续传 UI、并发压测
>
> 执行顺序即任务编号顺序。Phase 1 初始迁移已建好 `api_tokens`/`recovery_codes`/`login_challenges`/`authenticators`/`audit_logs` 五张表，**本阶段无需 schema 迁移**。

**Goal:** 让 Agent 可通过 API Token + 内嵌 MCP 安全操作 FileStation（传文件、建分享），全部操作可审计；管理端与分享页移动端可用；登录支持 TOTP 与恢复码；上传支持断点续传 UI。

**Architecture:** 沿用 NestJS 10 + TypeORM + SQLite（WAL）+ React 18 + Vite + Tailwind。新增 `api-tokens`、`audit`、`mcp` 三个后端模块；JWT 负载扩展 `principal_type/scopes/token_id`；MCP 以 Streamable HTTP 挂载于 `/api/v1/mcp`，复用现有 Services 而非另开数据通路。

**Tech Stack:** NestJS 10, TypeORM 0.3, SQLite 3, React 18, Tailwind 3, otplib, qrcode, argon2, @modelcontextprotocol/sdk (+zod), Jest

## Global Constraints

- Node.js >= 20.0.0；SQLite WAL + busy_timeout=5000；禁用 `SELECT ... FOR UPDATE`；并发抢占一律条件 UPDATE
- 写事务中禁止文件 I/O / 网络请求 / bcrypt / argon2（哈希均在事务外）
- 时间字段：Unix 毫秒 (INTEGER) 入库；API 返回 ISO 8601
- API 版本 `/api/v1/*`（Controller 不含前缀，仅 main.ts 设置 globalPrefix）；MCP 端点因此为 `/api/v1/mcp`
- 全部新 DTO 为 class-validator class（`whitelist + forbidNonWhitelisted` 生效）
- 统一响应包 `ApiResponse<T>`（`{code, message, data, request_id}`）
- **API Token**：明文格式 `fs_api_<48 hex>`；仅存 SHA-256 哈希；scopes 签发后不可被 JWT 放大；`principal_type: api_token` 的 JWT 有效期 1 小时；API Token 永远不能访问 settings/accounts/api-tokens/audit/TOTP/recovery 端点
- **审计日志脱敏**：禁止记录密码、TOTP 码、完整 Token、临时码 secret、恢复码明文；IPv4 按 /24 匿名化（末段置 0），IPv6 保留前 3 段；保留期 90 天，每日 Cron 清理
- **MCP**：默认关闭（`agent.mcp_enabled=false`）；仅接受 `Authorization: Bearer fs_api_*`；逐工具检查 scope；上传走与 Web 完全相同的 UploadsService 三阶段路径（`upload_init`/`upload_part`/`complete_upload` 三个工具，单分块 base64）；**分块大小硬不变量 ≤8MB**（upload_init 代码内 `min(8MB, 全局默认)` 兜住，不依赖设置默认值）；单文件总大小上限 `agent.mcp_max_upload_mb`（默认 32）；`/api/v1/mcp` 路由 JSON body 上限 16MB（main.ts 路由级 parser，其余路由仍默认 100KB）
- **依赖锁定**：`@modelcontextprotocol/sdk@^1.30.0` + `zod@^3.25.76`（npm 上本包最新 1.30.1，无 v2——v2 线是新包名 `@modelcontextprotocol/server@2.0.0-alpha`，不装；zod latest 4.6.5 与 SDK 1.30 类型已知不兼容，锁 3.x。SDK 会带一份嵌套 express 5，应用本体 express 4，`handleRequest` 只消费 Node req/res，兼容无需处理）
- **E2E 测试**：命令一律 `npm run test:e2e --workspace=@filestation/server -- <name>`（单元测试 jest.config.json `rootDir: src` 跑不到 test/ 目录）；公共环境 helpers 统一放 `apps/server/test/helpers.ts`，禁止第三份复制
- **scope 校验内置于 JwtAuthGuard**（super.canActivate 通过后 req.user 已就位时执行）：新控制器挂 JwtAuthGuard 即自动获得"api_token 默认拒绝"；管理端点另挂 AdminOnlyGuard
- **不配 `trust proxy`**（防 X-Forwarded-For 伪造绕过 IP 限速）；Nginx 模式下审计/限速的 IP 记为代理地址属已知限制，Phase 3 多入口时统一解决
- **TOTP**：secret 用 AES-256-GCM 加密入库（key = SHA-256(JWT_SECRET)）；login_challenge 5 分钟有效、单次使用、绑定账户
- **恢复码**：Argon2id 哈希；一次性；生成后 24 小时有效（设计文档 v2.2 §6.1）；验证成功即吊销该账户全部会话
- **移动端断点**：以 Tailwind `md`（768px）为界；触屏不依赖 hover
- 前端 fetch 一律走 `api.ts`（不覆盖调用方 Authorization 头）
- Commit 信息用中文 conventional 格式，末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## File Structure

**后端新增：**
```
apps/server/src/
  api-tokens/
    api-tokens.module.ts        # Controller+Service；import SecurityModule（守卫）
    api-tokens.service.ts       # 签发/校验/吊销/列表；SHA-256 哈希
    api-tokens.controller.ts    # /api-tokens CRUD（AdminOnly）
    entities/api-token.entity.ts
    dto/create-api-token.dto.ts
  audit/
    audit.module.ts             # 导出 AuditService（被 Auth/ApiTokens/Files/Shares/Settings/Mcp 注入）
    audit.service.ts            # record() + IP 匿名化 + findAll + @Cron 90 天清理
    audit.controller.ts         # GET /audit-logs（AdminOnly）
    entities/audit-log.entity.ts
  mcp/
    mcp.module.ts
    mcp.controller.ts           # POST /mcp（globalPrefix 后 = /api/v1/mcp）
    mcp.service.ts              # buildServer(principal, absoluteBase)：注册 11 个工具
  security/
    scope-rules.ts              # 新增：scope 判定纯函数（默认拒绝）
    guards/admin-only.guard.ts  # 新增：拒绝 principal_type != admin
    guards/jwt-auth.guard.ts    # 修改：认证通过后追加 scope 检查
    strategies/jwt.strategy.ts  # 修改：接受 api_token 主体（scopes 以 DB 为准）
  auth/
    entities/authenticator.entity.ts   # 新增（表已存在）
    entities/recovery-code.entity.ts   # 新增（表已存在）
    totp.service.ts / recovery.service.ts  # 新增
    dto/totp.dto.ts / dto/recovery.dto.ts  # 新增
  common/crypto/totp-secret-cipher.ts  # AES-256-GCM 加解密
```

**前端新增/修改：**
```
apps/web/src/
  components/AppLayout.tsx           # 新增：全局头部 + 导航（文件/审计/设置）+ 移动端抽屉
  components/FileList.tsx            # 改：桌面表格 + 移动卡片双渲染
  components/FolderTree.tsx          # 改：触屏可达操作
  components/FileUpload.tsx          # 改：断点续传（localStorage + 恢复横幅）
  pages/AuditPage.tsx                # 新增
  pages/settings/TotpSection.tsx     # 新增
  pages/settings/RecoverySection.tsx # 新增
  pages/settings/ApiTokensSection.tsx# 新增
  pages/settings/AgentSection.tsx    # 新增（MCP 开关 + 端点信息）
```

---

## Task 1: 新实体与 shared 类型扩展

**Files:**
- Create: `apps/server/src/api-tokens/entities/api-token.entity.ts`
- Create: `apps/server/src/auth/entities/authenticator.entity.ts`
- Create: `apps/server/src/auth/entities/recovery-code.entity.ts`
- Create: `apps/server/src/audit/entities/audit-log.entity.ts`
- Modify: `packages/shared/src/types.ts`
- Test: `apps/server/src/database/entities-alignment.spec.ts`

**Interfaces:**
- Produces（后续任务全部依赖）:
  - `ApiToken` 实体：`id, accountId, name, tokenPrefix, tokenHash, scopes(JSON string), expiresAt:number|null, createdAt, lastUsedAt:number|null, lastUsedIp:string|null, revokedAt:number|null`
  - `Authenticator` 实体：`id, accountId, type:'totp'|'webauthn', name, totpSecretEncrypted:string|null, credentialId:string|null, publicKey:string|null, signCount, transports:string|null, createdAt, lastUsedAt:number|null, isActive:number`
  - `RecoveryCode` 实体：`id, accountId, codeHash, usedAt:number|null, createdAt, expiresAt:number`
  - `AuditLog` 实体：`id, accountId:string|null, action, resourceType:string|null, resourceId:string|null, details:string|null, ipAddress:string|null, userAgent:string|null, createdAt`
  - shared：`API_TOKEN_SCOPES`、`ApiTokenScope`、`ApiTokenInfo`、`LoginResponseData`、`JwtPayload` 增加 `scopes?: string[]; token_id?: string`

- [ ] **Step 1: 写失败测试** `apps/server/src/database/entities-alignment.spec.ts`

用**真实初始迁移**建库（`migrationsRun: true`），并加 PRAGMA 逐列对比——实体与既有 DDL 漂移时立即失败，不靠手写 CREATE TABLE 自证：

```typescript
import { DataSource } from 'typeorm';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, rm } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { ApiToken } from '../api-tokens/entities/api-token.entity';
import { Authenticator } from '../auth/entities/authenticator.entity';
import { RecoveryCode } from '../auth/entities/recovery-code.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { InitialSchema1700000000000 } from '../database/migrations/1700000000000-initial-schema';

// 真实迁移建库（synchronize: false + migrationsRun）：
// 迁移 DDL 是权威 schema，实体必须贴合它
describe('Phase 2 entities alignment (real migration)', () => {
  let dir: string;
  let ds: DataSource;

  beforeAll(async () => {
    dir = join(tmpdir(), `fs-align-${uuidv4()}`);
    await mkdir(dir, { recursive: true });
    ds = new DataSource({
      type: 'sqlite',
      database: join(dir, 'test.db'),
      entities: [ApiToken, Authenticator, RecoveryCode, AuditLog],
      migrations: [InitialSchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    });
    await ds.initialize();
    // 只测实体-表对齐，不插 admin_accounts 行：建库后关掉外键检查
    // （TypeORM 0.3 sqlite 无 foreignKeys 连接选项，且驱动建连时无条件 PRAGMA foreign_keys = ON）
    await ds.query('PRAGMA foreign_keys = OFF');
  });

  afterAll(async () => {
    await ds.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it('实体列名与迁移 DDL 逐列吻合（防漂移）', async () => {
    const cases: Array<[any, string]> = [
      [ApiToken, 'api_tokens'],
      [Authenticator, 'authenticators'],
      [RecoveryCode, 'recovery_codes'],
      [AuditLog, 'audit_logs'],
    ];
    for (const [entity, table] of cases) {
      const metaCols = ds.getMetadata(entity).columns.map((c) => c.databaseName).sort();
      const dbCols = (await ds.query(`PRAGMA table_info(${table})`)).map((c: any) => c.name).sort();
      expect(metaCols).toEqual(dbCols);
    }
  });

  it('ApiToken 实体可读写迁移表', async () => {
    await ds.getRepository(ApiToken).save({
      id: 't1', accountId: 'a1', name: 'cli', tokenPrefix: 'fs_api_ab12',
      tokenHash: 'x'.repeat(64), scopes: '["files:read"]', expiresAt: null,
      createdAt: Date.now(), lastUsedAt: null, lastUsedIp: null, revokedAt: null,
    });
    const row = await ds.getRepository(ApiToken).findOneBy({ id: 't1' });
    expect(row?.tokenPrefix).toBe('fs_api_ab12');
  });

  it('Authenticator/RecoveryCode/AuditLog 实体可读写迁移表', async () => {
    await ds.getRepository(Authenticator).save({
      id: 'au1', accountId: 'a1', type: 'totp', name: 'TOTP',
      totpSecretEncrypted: 'v1.x.y.z', credentialId: null, publicKey: null,
      signCount: 0, transports: null, createdAt: Date.now(), lastUsedAt: null, isActive: 1,
    });
    await ds.getRepository(RecoveryCode).save({
      id: 'r1', accountId: 'a1', codeHash: 'argon2...', usedAt: null,
      createdAt: Date.now(), expiresAt: Date.now() + 86400_000,
    });
    await ds.getRepository(AuditLog).save({
      id: 'l1', accountId: 'a1', action: 'auth.login', resourceType: null,
      resourceId: null, details: null, ipAddress: '192.168.1.0',
      userAgent: 'jest', createdAt: Date.now(),
    });
    expect(await ds.getRepository(AuditLog).count()).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test --workspace=@filestation/server -- entities-alignment`
Expected: FAIL（实体文件不存在，编译错误）

- [ ] **Step 3: 实现四个实体**

`apps/server/src/api-tokens/entities/api-token.entity.ts`：

```typescript
import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('api_tokens')
export class ApiToken {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column()
  name!: string;

  @Column({ name: 'token_prefix' })
  tokenPrefix!: string;

  @Column({ name: 'token_hash' })
  tokenHash!: string;

  /** JSON string，元素为 ApiTokenScope */
  @Column({ type: 'text' })
  scopes!: string;

  @Column({ name: 'expires_at', type: 'integer', nullable: true })
  expiresAt!: number | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'last_used_at', type: 'integer', nullable: true })
  lastUsedAt!: number | null;

  @Column({ name: 'last_used_ip', type: 'text', nullable: true })
  lastUsedIp!: string | null;

  @Column({ name: 'revoked_at', type: 'integer', nullable: true })
  revokedAt!: number | null;
}
```

`apps/server/src/auth/entities/authenticator.entity.ts`：

```typescript
import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('authenticators')
export class Authenticator {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column()
  type!: 'totp' | 'webauthn';

  @Column()
  name!: string;

  @Column({ name: 'totp_secret_encrypted', type: 'text', nullable: true })
  totpSecretEncrypted!: string | null;

  @Column({ name: 'credential_id', type: 'text', nullable: true })
  credentialId!: string | null;

  @Column({ name: 'public_key', type: 'text', nullable: true })
  publicKey!: string | null;

  @Column({ name: 'sign_count', type: 'integer', default: 0 })
  signCount!: number;

  @Column({ type: 'text', nullable: true })
  transports!: string | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'last_used_at', type: 'integer', nullable: true })
  lastUsedAt!: number | null;

  @Column({ name: 'is_active', type: 'integer', default: 1 })
  isActive!: number;
}
```

`apps/server/src/auth/entities/recovery-code.entity.ts`：

```typescript
import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('recovery_codes')
export class RecoveryCode {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id' })
  accountId!: string;

  @Column({ name: 'code_hash' })
  codeHash!: string;

  @Column({ name: 'used_at', type: 'integer', nullable: true })
  usedAt!: number | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;

  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;
}
```

`apps/server/src/audit/entities/audit-log.entity.ts`：

```typescript
import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryColumn('text')
  id!: string;

  @Column({ name: 'account_id', type: 'text', nullable: true })
  accountId!: string | null;

  @Column()
  action!: string;

  @Column({ name: 'resource_type', type: 'text', nullable: true })
  resourceType!: string | null;

  @Column({ name: 'resource_id', type: 'text', nullable: true })
  resourceId!: string | null;

  /** JSON string；禁止含密码/TOTP/完整 Token/恢复码明文 */
  @Column({ type: 'text', nullable: true })
  details!: string | null;

  @Column({ name: 'ip_address', type: 'text', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'created_at', type: 'integer' })
  createdAt!: number;
}
```

- [ ] **Step 4: shared 类型扩展**（追加到 `packages/shared/src/types.ts`）

```typescript
// ---- Phase 2: API Token ----
export const API_TOKEN_SCOPES = [
  'files:read', 'files:write',
  'shares:read', 'shares:write',
  'folders:read', 'folders:write',
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export interface ApiTokenInfo {
  id: string;
  name: string;
  token_prefix: string;
  scopes: ApiTokenScope[];
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
}

/** 仅签发时返回一次 */
export interface CreatedApiToken extends ApiTokenInfo {
  token: string;
}

// ---- Phase 2: 登录两步 ----
export type LoginResponseData =
  | { access_token: string; expires_in: number }
  | { requires_second_factor: true; login_challenge: string; available_methods: string[] };

// ---- Phase 2: 审计日志 ----
export interface AuditLogEntry {
  id: string;
  account_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}
```

并修改既有类型（**增量**，不整段重写）：

```typescript
// JwtPayload 只追加一个字段（principal_type/scopes 已存在，iat/exp 保持必填，不动）：
export interface JwtPayload {
  sub: string;
  username: string;
  principal_type: 'admin' | 'api_token';
  scopes?: string[];
  token_id?: string;      // 新增：api_token 主体必有（吊销检查用）
  iat: number;
  exp: number;
}

// 删除旧的 LoginResponse interface（前端无人使用，已被上面的判别联合取代）
// —— types.ts 中 requires_second_factor/login_challenge/available_methods/access_token/expires_in
//    那段 optional 堆叠 interface 整个删除
```

- [ ] **Step 5: 运行测试通过 + 构建 shared**

Run: `npm run build:shared && npm run test --workspace=@filestation/server -- entities-alignment`
Expected: PASS（以实际运行结果为准）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api-tokens apps/server/src/auth/entities apps/server/src/audit packages/shared/src/types.ts apps/server/src/database/entities-alignment.spec.ts
git commit -m "feat(server): Phase 2 实体补全（ApiToken/Authenticator/RecoveryCode/AuditLog）+ shared 类型扩展

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: API Token 签发与管理端点

**Files:**
- Create: `apps/server/src/api-tokens/api-tokens.service.ts`
- Create: `apps/server/src/api-tokens/api-tokens.controller.ts`
- Create: `apps/server/src/api-tokens/dto/create-api-token.dto.ts`
- Create: `apps/server/src/api-tokens/api-tokens.module.ts`
- Modify: `apps/server/src/app.module.ts`（注册 ApiTokensModule）
- Test: `apps/server/src/api-tokens/api-tokens.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `ApiToken` 实体、`API_TOKEN_SCOPES`、`ApiTokenScope`、`ApiTokenInfo`、`CreatedApiToken`
- Produces:
  - `ApiTokensService.createToken(accountId: string, name: string, scopes: ApiTokenScope[], expiresInDays: number | null): Promise<{ record: ApiTokenInfo; plaintext: string }>`
  - `ApiTokensService.listTokens(accountId: string): Promise<ApiTokenInfo[]>`
  - `ApiTokensService.revokeToken(accountId: string, tokenId: string): Promise<void>`
  - `ApiTokensService.validatePlaintext(raw: string): Promise<ApiToken | null>`（Task 3/5 消费）
  - `ApiTokensService.touchLastUsed(tokenId: string, ip: string): Promise<void>`（Task 3/5 消费）
  - 端点：`POST /api-tokens`、`GET /api-tokens`、`DELETE /api-tokens/:id`（全部 JwtAuthGuard + AdminOnlyGuard——AdminOnlyGuard 在 Task 3 落地，本任务先用 JwtAuthGuard，Task 3 补挂）

- [ ] **Step 1: 写失败测试** `apps/server/src/api-tokens/api-tokens.service.spec.ts`

```typescript
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { ApiTokensService } from './api-tokens.service';
import { ApiToken } from './entities/api-token.entity';

const mockRepo = () => ({ save: jest.fn(), find: jest.fn(), findOne: jest.fn(), update: jest.fn() });

describe('ApiTokensService', () => {
  let service: ApiTokensService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    repo = mockRepo();
    const module = await Test.createTestingModule({
      providers: [ApiTokensService, { provide: getRepositoryToken(ApiToken), useValue: repo }],
    }).compile();
    service = module.get(ApiTokensService);
  });

  it('签发：明文仅返回一次，库中只存 SHA-256 哈希与前缀', async () => {
    repo.save.mockImplementation(async (e) => e);
    const { record, plaintext } = await service.createToken('acc1', 'agent', ['files:read', 'shares:write'], 30);
    expect(plaintext).toMatch(/^fs_api_[0-9a-f]{48}$/);
    expect(record.token).toBeUndefined();
    expect(record.token_prefix).toBe(plaintext.substring(0, 12));
    const saved = repo.save.mock.calls[0][0] as ApiToken;
    expect(saved.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.tokenHash).not.toBe(plaintext);
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
  });

  it('签发：scopes 必须是合法子集', async () => {
    await expect(
      service.createToken('acc1', 'bad', ['admin:all' as any], null),
    ).rejects.toThrow();
  });

  it('validatePlaintext：有效/吊销/过期/不存在/前缀错 五分支（mock 按真实 SHA-256 匹配）', async () => {
    const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
    const ok = 'fs_api_' + 'a'.repeat(48);
    const rev = 'fs_api_' + 'b'.repeat(48);
    const exp = 'fs_api_' + 'c'.repeat(48);
    repo.findOne.mockImplementation(async ({ where }: any) => {
      if (where.tokenHash === sha256(ok)) return { id: 't1', revokedAt: null, expiresAt: Date.now() + 60_000 };
      if (where.tokenHash === sha256(rev)) return { id: 't2', revokedAt: Date.now(), expiresAt: null };
      if (where.tokenHash === sha256(exp)) return { id: 't3', revokedAt: null, expiresAt: Date.now() - 1 };
      return null;
    });
    expect((await service.validatePlaintext(ok))?.id).toBe('t1');
    expect(await service.validatePlaintext(rev)).toBeNull();  // 已吊销
    expect(await service.validatePlaintext(exp)).toBeNull();  // 已过期
    expect(await service.validatePlaintext('fs_api_' + 'd'.repeat(48))).toBeNull(); // 不存在
    expect(await service.validatePlaintext('not-a-token')).toBeNull(); // 前缀不符短路
  });

  it('touchLastUsed：距上次不足 60 秒不写库', async () => {
    repo.findOne.mockResolvedValue({ id: 't1', lastUsedAt: Date.now() - 1000 });
    await service.touchLastUsed('t1', '1.2.3.0');
    expect(repo.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test --workspace=@filestation/server -- api-tokens.service`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 Service**

`apps/server/src/api-tokens/api-tokens.service.ts`：

```typescript
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ApiToken } from './entities/api-token.entity';
import { API_TOKEN_SCOPES, ApiTokenScope, ApiTokenInfo } from '@filestation/shared';

@Injectable()
export class ApiTokensService {
  constructor(
    @InjectRepository(ApiToken)
    private tokensRepository: Repository<ApiToken>,
  ) {}

  async createToken(
    accountId: string,
    name: string,
    scopes: ApiTokenScope[],
    expiresInDays: number | null,
  ): Promise<{ record: ApiTokenInfo; plaintext: string }> {
    const invalid = scopes.filter((s) => !API_TOKEN_SCOPES.includes(s));
    if (invalid.length > 0) {
      throw new BadRequestException({ code: 'INVALID_SCOPES', message: `Invalid scopes: ${invalid.join(', ')}` });
    }
    if (scopes.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_SCOPES', message: 'At least one scope is required' });
    }

    const plaintext = `fs_api_${randomBytes(24).toString('hex')}`; // 192 bit
    const now = Date.now();
    const entity = await this.tokensRepository.save({
      id: uuidv4(),
      accountId,
      name,
      tokenPrefix: plaintext.substring(0, 12),
      tokenHash: this.hash(plaintext),
      scopes: JSON.stringify(scopes),
      expiresAt: expiresInDays ? now + expiresInDays * 86_400_000 : null,
      createdAt: now,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
    });
    return { record: this.toInfo(entity), plaintext };
  }

  async listTokens(accountId: string): Promise<ApiTokenInfo[]> {
    const rows = await this.tokensRepository.find({ where: { accountId }, order: { createdAt: 'DESC' } });
    return rows.map((r) => this.toInfo(r));
  }

  async revokeToken(accountId: string, tokenId: string): Promise<void> {
    const result = await this.tokensRepository.update(
      { id: tokenId, accountId }, // 条件 UPDATE：只能吊销自己的 token
      { revokedAt: Date.now() },
    );
    if (result.affected === 0) throw new NotFoundException('API token not found');
  }

  /** exchange / MCP 鉴权共用：哈希查找 + 吊销/过期检查 */
  async validatePlaintext(raw: string): Promise<ApiToken | null> {
    if (!raw.startsWith('fs_api_')) return null;
    const row = await this.tokensRepository.findOne({ where: { tokenHash: this.hash(raw) } });
    if (!row || row.revokedAt !== null) return null;
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) return null;
    return row;
  }

  /** 使用痕迹；60 秒节流防写放大 */
  async touchLastUsed(tokenId: string, ip: string): Promise<void> {
    const row = await this.tokensRepository.findOne({ where: { id: tokenId } });
    if (!row) return;
    if (row.lastUsedAt && Date.now() - row.lastUsedAt < 60_000) return;
    await this.tokensRepository.update({ id: tokenId }, { lastUsedAt: Date.now(), lastUsedIp: ip });
  }

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private toInfo(e: ApiToken): ApiTokenInfo {
    return {
      id: e.id,
      name: e.name,
      token_prefix: e.tokenPrefix,
      scopes: JSON.parse(e.scopes),
      expires_at: e.expiresAt ? new Date(e.expiresAt).toISOString() : null,
      created_at: new Date(e.createdAt).toISOString(),
      last_used_at: e.lastUsedAt ? new Date(e.lastUsedAt).toISOString() : null,
      last_used_ip: e.lastUsedIp,
      revoked_at: e.revokedAt ? new Date(e.revokedAt).toISOString() : null,
    };
  }
}
```

`apps/server/src/api-tokens/dto/create-api-token.dto.ts`：

```typescript
import { IsString, Length, IsArray, IsIn, IsOptional, IsInt, Min, Max, ArrayNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';
import { API_TOKEN_SCOPES } from '@filestation/shared';

export class CreateApiTokenDto {
  @IsString() @Length(1, 64)
  name!: string;

  @IsArray() @ArrayNotEmpty()
  @IsIn(API_TOKEN_SCOPES as unknown as string[], { each: true })
  scopes!: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  expires_in_days?: number;
}
```

`apps/server/src/api-tokens/api-tokens.controller.ts`：

```typescript
import { Controller, Post, Get, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTokensService } from './api-tokens.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { CreateApiTokenDto } from './dto/create-api-token.dto';
import { ApiResponse, ApiTokenInfo, ApiTokenScope, CreatedApiToken } from '@filestation/shared';
import { Request } from 'express';

@Controller('api-tokens')
@UseGuards(JwtAuthGuard, AdminOnlyGuard) // AdminOnlyGuard Task 3 落地
export class ApiTokensController {
  constructor(private apiTokensService: ApiTokensService) {}

  @Post()
  async create(@Body() body: CreateApiTokenDto, @Req() req: Request): Promise<ApiResponse<CreatedApiToken>> {
    const user = (req as any).user;
    const { record, plaintext } = await this.apiTokensService.createToken(
      user.id, body.name, body.scopes as ApiTokenScope[], body.expires_in_days ?? null,
    );
    return { code: 'OK', message: 'API token created (shown once)', data: { ...record, token: plaintext }, request_id: crypto.randomUUID() };
  }

  @Get()
  async list(@Req() req: Request): Promise<ApiResponse<ApiTokenInfo[]>> {
    const user = (req as any).user;
    return { code: 'OK', message: 'Success', data: await this.apiTokensService.listTokens(user.id), request_id: crypto.randomUUID() };
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @Req() req: Request): Promise<ApiResponse<null>> {
    const user = (req as any).user;
    await this.apiTokensService.revokeToken(user.id, id);
    return { code: 'OK', message: 'API token revoked', data: null, request_id: crypto.randomUUID() };
  }
}
```

`apps/server/src/api-tokens/api-tokens.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiToken } from './entities/api-token.entity';
import { ApiTokensService } from './api-tokens.service';
import { ApiTokensController } from './api-tokens.controller';
import { SecurityModule } from '../security/security.module';

@Module({
  imports: [TypeOrmModule.forFeature([ApiToken]), SecurityModule],
  controllers: [ApiTokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService], // AuthModule(exchange) 与 McpModule 注入
})
export class ApiTokensModule {}
```

`app.module.ts` 的 `imports` 数组追加 `ApiTokensModule`（import 自 `./api-tokens/api-tokens.module`）。

- [ ] **Step 4: 先建 AdminOnlyGuard**（controller 已 import 它——不先建则 Step 5 编译不过）

`apps/server/src/security/guards/admin-only.guard.ts`：

```typescript
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.user?.principalType !== 'admin') {
      throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'This endpoint requires an admin session' });
    }
    return true;
  }
}
```

（实现即完整——它必须挂在 JwtAuthGuard **之后**，依赖 req.user 已就位。Task 3 把它接入 settings/audit 控制器。）

- [ ] **Step 5: 运行测试通过**

Run: `npm run test --workspace=@filestation/server -- api-tokens.service`
Expected: PASS（以实际运行结果为准）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api-tokens apps/server/src/security/guards/admin-only.guard.ts apps/server/src/app.module.ts
git commit -m "feat(server): API Token 签发/列表/吊销端点（SHA-256 哈希存储，明文仅展示一次）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: API Token 换 JWT（exchange）+ scope 检查内嵌 JwtAuthGuard + 控制器接入

**Files:**
- Modify: `apps/server/src/auth/auth.service.ts`（新增 `exchangeApiToken`）
- Modify: `apps/server/src/auth/auth.controller.ts`（新增 `POST /auth/api-token/exchange`）
- Modify: `apps/server/src/auth/auth.module.ts`（imports 增加 ApiTokensModule）
- Modify: `apps/server/src/security/strategies/jwt.strategy.ts`（接受 api_token 主体）
- Modify: `apps/server/src/security/security.module.ts`（`TypeOrmModule.forFeature([ApiToken])`，providers/exports 增加 AdminOnlyGuard）
- Modify: `apps/server/src/security/guards/jwt-auth.guard.ts`（注入 Reflector，认证后内嵌 scope 检查）
- Create: `apps/server/src/security/scope-rules.ts`（纯函数 `assertPrincipalScopes`）
- Create: `apps/server/src/security/decorators/require-scopes.decorator.ts`
- Create: `apps/server/test/helpers.ts`（e2e 公共环境，后续所有新 e2e 的唯一来源）
- Modify: `apps/server/src/files/files.controller.ts`、`apps/server/src/files/uploads.controller.ts`、`apps/server/src/folders/folders.controller.ts`、`apps/server/src/shares/shares.controller.ts`、`apps/server/src/settings/settings.controller.ts`（标注 `@RequireScopes` / AdminOnlyGuard）
- Test: `apps/server/src/security/scope-rules.spec.ts`、`apps/server/test/api-token-exchange.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2 `ApiTokensService.validatePlaintext/touchLastUsed`、Task 2 已建的 `AdminOnlyGuard`
- Produces:
  - `POST /api/v1/auth/api-token/exchange`（`Authorization: Bearer fs_api_*`）→ `data: { access_token, expires_in: 3600 }`
  - JWT(api_token) payload：`{ sub: accountId, username, principal_type: 'api_token', scopes: string[], token_id }`
  - `req.user`：`{ id, username, principalType: 'admin'|'api_token', tokenId?: string, scopes?: string[] }`
  - `@RequireScopes(...scopes: ApiTokenScope[])` 装饰器（`REQUIRED_SCOPES_KEY = 'required_scopes'`）
  - `assertPrincipalScopes(user: PrincipalLike | undefined, required: string[] | undefined): void`（纯函数；ForbiddenException code: NO_PRINCIPAL / ENDPOINT_NOT_SCOPED / INSUFFICIENT_SCOPE）
  - 规则：admin 主体无视 scopes 放行；api_token 主体必须覆盖全部 `@RequireScopes`；**未标 `@RequireScopes` 的端点，api_token 主体一律拒绝**（默认拒绝，防新端点忘标授权）
  - **架构决定（勿改回全局守卫）**：scope 检查内嵌在 `JwtAuthGuard.canActivate` 的 `super.canActivate()` **之后**。原因：(1) Nest 中 APP_GUARD 全局守卫先于控制器守卫执行，passport 尚未写入 `req.user`，全局 ScopesGuard 永远拿不到主体；(2) 独立 ScopesGuard 只在显式挂载处生效，新控制器忘挂即裸奔。内嵌后"过 JWT 必过 scope 检查"，默认拒绝自动覆盖所有受保护端点

- [ ] **Step 1: 写失败测试** `apps/server/src/security/scope-rules.spec.ts`

```typescript
import { ForbiddenException } from '@nestjs/common';
import { assertPrincipalScopes } from './scope-rules';

function expectForbiddenCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as ForbiddenException).getResponse()).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ForbiddenException(${code})`);
}

describe('assertPrincipalScopes', () => {
  it('admin 主体无条件放行（含未标注端点）', () => {
    expect(() => assertPrincipalScopes({ principalType: 'admin' }, ['files:write'])).not.toThrow();
    expect(() => assertPrincipalScopes({ principalType: 'admin' }, undefined)).not.toThrow();
  });

  it('api_token 主体 scope 覆盖全部 required 则放行', () => {
    expect(() =>
      assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read', 'shares:write'] }, ['files:read']),
    ).not.toThrow();
  });

  it('api_token 主体缺 scope → INSUFFICIENT_SCOPE', () => {
    expectForbiddenCode(
      () => assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read'] }, ['files:write']),
      'INSUFFICIENT_SCOPE',
    );
  });

  it('未标注 scopes 的端点拒绝 api_token 主体（ENDPOINT_NOT_SCOPED，默认拒绝）', () => {
    expectForbiddenCode(
      () => assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read'] }, undefined),
      'ENDPOINT_NOT_SCOPED',
    );
  });

  it('@RequireScopes() 空参（元数据为 [] 而非 undefined）同样视为未标注 → ENDPOINT_NOT_SCOPED', () => {
    expectForbiddenCode(
      () => assertPrincipalScopes({ principalType: 'api_token', scopes: ['files:read'] }, []),
      'ENDPOINT_NOT_SCOPED',
    );
  });

  it('无主体 → NO_PRINCIPAL', () => {
    expectForbiddenCode(() => assertPrincipalScopes(undefined, ['files:read']), 'NO_PRINCIPAL');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test --workspace=@filestation/server -- scope-rules`
Expected: FAIL（`./scope-rules` 不存在）

- [ ] **Step 3: 实现装饰器与 scope 判定纯函数**

`apps/server/src/security/decorators/require-scopes.decorator.ts`：

```typescript
import { SetMetadata } from '@nestjs/common';
import { ApiTokenScope } from '@filestation/shared';

export const REQUIRED_SCOPES_KEY = 'required_scopes';
export const RequireScopes = (...scopes: ApiTokenScope[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);
```

`apps/server/src/security/scope-rules.ts`：

```typescript
import { ForbiddenException } from '@nestjs/common';

export interface PrincipalLike {
  principalType: 'admin' | 'api_token';
  scopes?: string[];
}

/**
 * scope 判定纯函数（由 JwtAuthGuard 在认证后内嵌调用；单测直接覆盖全部分支）。
 * 判定顺序固定：无主体 → admin 放行 → 未标注端点默认拒绝 → 缺 scope 拒绝。
 */
export function assertPrincipalScopes(user: PrincipalLike | undefined, required: string[] | undefined): void {
  if (!user) {
    throw new ForbiddenException({ code: 'NO_PRINCIPAL', message: 'No authenticated principal' });
  }
  if (user.principalType === 'admin') return; // admin 会话全权限

  // 默认拒绝：未显式标注 scopes 的端点不向 api_token 开放
  // （@RequireScopes() 空参产生的元数据是 [] 而非 undefined，空数组同样视为未标注——否则空标注反而放行一切）
  if (!required || required.length === 0) {
    throw new ForbiddenException({ code: 'ENDPOINT_NOT_SCOPED', message: 'This endpoint is not available for API tokens' });
  }
  const granted = user.scopes ?? [];
  const missing = required.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    throw new ForbiddenException({ code: 'INSUFFICIENT_SCOPE', message: `Missing scopes: ${missing.join(', ')}` });
  }
}
```

- [ ] **Step 3b: 运行单元测试通过**

Run: `npm run test --workspace=@filestation/server -- scope-rules`
Expected: PASS（6 个用例）

- [ ] **Step 4: JwtStrategy 接受 api_token 主体**

`apps/server/src/security/strategies/jwt.strategy.ts` 全文替换为：

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountsService } from '../../accounts/accounts.service';
import { ApiToken } from '../../api-tokens/entities/api-token.entity';
import { JwtPayload } from '@filestation/shared';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private accountsService: AccountsService,
    @InjectRepository(ApiToken)
    private apiTokensRepository: Repository<ApiToken>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwtSecret') || (() => { throw new Error('JWT_SECRET not configured'); })(),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.principal_type === 'admin') {
      const account = await this.accountsService.findById(payload.sub);
      if (!account) throw new UnauthorizedException('Account not found');
      return { id: account.id, username: account.username, principalType: 'admin' as const };
    }

    if (payload.principal_type === 'api_token') {
      // JWT 有效 ≠ token 未被吊销：每次请求查库（SQLite 读廉价，换取即时吊销语义）
      if (!payload.token_id) throw new UnauthorizedException('Malformed api_token JWT');
      const token = await this.apiTokensRepository.findOne({ where: { id: payload.token_id } });
      if (!token || token.revokedAt !== null) throw new UnauthorizedException('API token revoked');
      if (token.expiresAt !== null && token.expiresAt <= Date.now()) throw new UnauthorizedException('API token expired');
      const account = await this.accountsService.findById(token.accountId);
      if (!account) throw new UnauthorizedException('Account not found');
      return {
        id: account.id,
        username: `api:${token.name}`,
        principalType: 'api_token' as const,
        tokenId: token.id,
        scopes: JSON.parse(token.scopes) as string[], // 以 DB 为准，防 JWT 伪造放大
      };
    }

    throw new UnauthorizedException('Invalid token type');
  }
}
```

`security.module.ts`：`imports` 增加 `TypeOrmModule.forFeature([ApiToken])`（import 自 `@nestjs/typeorm` 与 `../../api-tokens/entities/api-token.entity`），`providers`/`exports` 增加 `AdminOnlyGuard`（JwtAuthGuard 已在 providers/exports 中）。

- [ ] **Step 4b: JwtAuthGuard 内嵌 scope 检查**

`apps/server/src/security/guards/jwt-auth.guard.ts` 全文替换为：

```typescript
import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { REQUIRED_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import { assertPrincipalScopes } from '../scope-rules';

/**
 * JWT 认证 + scope 授权一体：super.canActivate() 由 passport 完成验签并写入 req.user，
 * 之后立即做 scope 检查（admin 放行；api_token 缺标注/缺 scope → 403）。
 * 不可拆成 APP_GUARD 全局守卫——全局守卫先于控制器守卫执行，届时 passport 尚未写 req.user。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    assertPrincipalScopes(context.switchToHttp().getRequest().user, required);
    return ok;
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or expired token');
    }
    return user;
  }
}
```

（Reflector 是 Nest core 全局 provider，任意模块可直接注入，无需在 module 中注册。）

- [ ] **Step 5: exchange 端点**

`auth.service.ts` 追加方法（constructor 增加 `private apiTokensService: ApiTokensService`，auth.module.ts 的 imports 增加 `ApiTokensModule`）：

```typescript
  /** API Token 换短期 JWT（1h）；scopes 直接取自数据库记录，不信任调用方 */
  async exchangeApiToken(rawToken: string, clientIp?: string): Promise<{ accessToken: string; expiresIn: number }> {
    const token = await this.apiTokensService.validatePlaintext(rawToken);
    if (!token) throw new UnauthorizedException('Invalid or expired API token');

    const account = await this.accountsService.findById(token.accountId);
    if (!account) throw new UnauthorizedException('Account not found');

    const scopes = JSON.parse(token.scopes) as string[];
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: account.id,
      username: account.username,
      principal_type: 'api_token',
      scopes,
      token_id: token.id,
    };
    const accessToken = this.jwtService.sign(payload, { expiresIn: 3600 });
    await this.apiTokensService.touchLastUsed(token.id, clientIp ?? 'unknown');
    return { accessToken, expiresIn: 3600 };
  }
```

`auth.controller.ts` 追加：

```typescript
  @Post('api-token/exchange')
  @HttpCode(HttpStatus.OK)
  async exchangeApiToken(
    @Req() req: Request,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<ApiResponse<{ access_token: string; expires_in: number }>> {
    const raw = authorization?.replace(/^Bearer\s+/i, '');
    if (!raw) throw new UnauthorizedException('Missing API token');
    const result = await this.authService.exchangeApiToken(raw, req.ip);
    return {
      code: 'OK', message: 'Token exchanged',
      data: { access_token: result.accessToken, expires_in: result.expiresIn },
      request_id: crypto.randomUUID(),
    };
  }
```

- [ ] **Step 6: 业务控制器标注 scopes**

控制器**保持** `@UseGuards(JwtAuthGuard)` 不变（scope 检查已内嵌其中），只逐端点加 `@RequireScopes(...)` 标注：

- `files.controller.ts`：`GET /files`、`GET /files/:id`、`GET /files/:id/content` → `@RequireScopes('files:read')`；`PATCH /files/:id`、`DELETE /files/:id`、`POST /files/:id/extend` → `@RequireScopes('files:write')`
- `uploads.controller.ts`：`POST /uploads`（initialize）→ `@RequireScopes('files:write')`（parts/complete/resume/abort/status 走 X-Upload-Token 匿名路径，不动）
- `folders.controller.ts`：`GET /folders*` → `folders:read`；`POST/PATCH/DELETE /folders*` → `folders:write`
- `shares.controller.ts`：管理端点（`GET /shares`、`POST /shares`、`DELETE /shares/:id`）→ `shares:read`/`shares:write`/`shares:write`；公开端点（`GET /shares/:id`、`POST /shares/:id/access`、`POST /shares/:id/download-ticket`、`GET /shares/:id/content`）无 JWT 守卫，不动
- `settings.controller.ts`：改为 `@UseGuards(JwtAuthGuard, AdminOnlyGuard)`，不加 `@RequireScopes`——api_token 永不可读写设置（内嵌默认拒绝已会拦，AdminOnlyGuard 使意图显式化）
- Task 2 的 `api-tokens.controller.ts` 已是 `@UseGuards(JwtAuthGuard, AdminOnlyGuard)`，不动；Task 4 的 audit 控制器同样挂 AdminOnlyGuard

import 路径统一：`import { RequireScopes } from '../security/decorators/require-scopes.decorator';`、`import { AdminOnlyGuard } from '../security/guards/admin-only.guard';`（各模块的 module.ts 均已 import SecurityModule，守卫可注入）。

- [ ] **Step 7: 抽公共 e2e helpers** `apps/server/test/helpers.ts`

app.e2e-spec.ts 的 setupEnv/teardownEnv/createApp/initAndLogin 是文件私有函数，Task 13 也需要同一套环境——此处建唯一公共副本，后续所有新 e2e 文件一律 import，禁止第三份复制。与 app.e2e-spec.ts 的唯一差异：不开 `enableCors`（supertest 不经过浏览器，Origin 校验不参与，保持测试基础设施最小）。

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, rm } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { RangeNotSatisfiableFilter } from '../src/common/http/range-not-satisfiable.filter';

export interface TestEnv { dir: string; dbPath: string; storagePath: string; tempPath: string; }

export async function setupEnv(): Promise<TestEnv> {
  const dir = join(tmpdir(), `filestation-e2e-${uuidv4()}`);
  const env: TestEnv = { dir, dbPath: join(dir, 'test.db'), storagePath: join(dir, 'storage'), tempPath: join(dir, 'temp') };
  await mkdir(env.storagePath, { recursive: true });
  await mkdir(env.tempPath, { recursive: true });
  process.env.FILESTATION_DB_PATH = env.dbPath;
  process.env.FILESTATION_STORAGE_PATH = env.storagePath;
  process.env.FILESTATION_TEMP_PATH = env.tempPath;
  process.env.JWT_SECRET = 'e2e-test-secret';
  process.env.NODE_ENV = 'test';
  return env;
}

export async function teardownEnv(env: TestEnv): Promise<void> {
  delete process.env.FILESTATION_DB_PATH;
  delete process.env.FILESTATION_STORAGE_PATH;
  delete process.env.FILESTATION_TEMP_PATH;
  await rm(env.dir, { recursive: true, force: true });
}

export async function createApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new RangeNotSatisfiableFilter());
  await app.init();
  return app;
}

export async function initAndLogin(app: INestApplication): Promise<string> {
  const initToken = await app.get(AuthService).generateInitToken();
  await request(app.getHttpServer()).post('/api/v1/auth/init')
    .set('X-Init-Token', initToken)
    .send({ username: 'admin', password: 'StrongP@ssw0rd' }).expect(201);
  const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login')
    .send({ username: 'admin', password: 'StrongP@ssw0rd' }).expect(200);
  return loginRes.body.data.access_token;
}

/** 上传一个单分块小文件（initialize → PUT part → complete 全流程），返回 fileId */
export async function uploadSmallFile(server: any, accessToken: string, filename: string, content: Buffer): Promise<string> {
  const initRes = await request(server).post('/api/v1/uploads')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ filename, size: content.length }).expect(201);
  const { upload_id, upload_token } = initRes.body.data;
  const checksum = createHash('sha256').update(content).digest('hex');
  await request(server).put(`/api/v1/uploads/${upload_id}/parts/0`)
    .set('X-Upload-Token', upload_token)
    .set('X-Part-Checksum', checksum)
    .set('Content-Type', 'application/octet-stream')
    .send(content).expect(200);
  const completeRes = await request(server).post(`/api/v1/uploads/${upload_id}/complete`)
    .set('X-Upload-Token', upload_token).send({}).expect(201);
  return completeRes.body.data.file_id;
}
```

- [ ] **Step 8: E2E 验证** `apps/server/test/api-token-exchange.e2e-spec.ts`

```typescript
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { setupEnv, teardownEnv, createApp, initAndLogin, TestEnv } from './helpers';

describe('API Token exchange (e2e)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let adminJwt: string;
  let plaintext: string;
  let tokenId: string;
  let apiJwt: string;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    adminJwt = await initAndLogin(app);
    const server = app.getHttpServer();
    // 签发只有 files:read 的 token
    const createRes = await request(server).post('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'e2e-agent', scopes: ['files:read'] }).expect(201);
    plaintext = createRes.body.data.token;
    tokenId = createRes.body.data.id;
    // 换 JWT
    const exchRes = await request(server).post('/api/v1/auth/api-token/exchange')
      .set('Authorization', `Bearer ${plaintext}`).expect(200);
    apiJwt = exchRes.body.data.access_token;
    expect(exchRes.body.data.expires_in).toBe(3600);
  }, 60_000);

  afterAll(async () => { await app.close(); await teardownEnv(env); });

  it('列表接口不明文返回 token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/api-tokens')
      .set('Authorization', `Bearer ${adminJwt}`).expect(200);
    expect(res.body.data[0].token).toBeUndefined();
    expect(res.body.data[0].token_prefix).toBe(plaintext.substring(0, 12));
  });

  it('api_token JWT 可访问授权 scope 的端点（GET /files）', async () => {
    await request(app.getHttpServer()).get('/api/v1/files')
      .set('Authorization', `Bearer ${apiJwt}`).expect(200);
  });

  it('scope 不足被拒（POST /uploads 需要 files:write）→ 403', async () => {
    await request(app.getHttpServer()).post('/api/v1/uploads')
      .set('Authorization', `Bearer ${apiJwt}`)
      .send({ filename: 'x.txt', size: 1 }).expect(403);
  });

  it('api_token 永不可访问 settings（默认拒绝 + AdminOnlyGuard 双保险）→ 403', async () => {
    await request(app.getHttpServer()).get('/api/v1/settings')
      .set('Authorization', `Bearer ${apiJwt}`).expect(403);
  });

  it('伪造 JWT 放大 scopes 无效：scopes 以 DB 为准', async () => {
    const forged = app.get(JwtService).sign({
      sub: 'forged', username: 'admin', principal_type: 'api_token',
      scopes: ['files:write'], // 伪造放大
      token_id: tokenId,       // 但指向 DB 中只有 files:read 的 token
    });
    await request(app.getHttpServer()).post('/api/v1/uploads')
      .set('Authorization', `Bearer ${forged}`)
      .send({ filename: 'x.txt', size: 1 }).expect(403);
  });

  it('吊销后既有 JWT 立即失效 → 401', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/api-tokens/${tokenId}`)
      .set('Authorization', `Bearer ${adminJwt}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/files')
      .set('Authorization', `Bearer ${apiJwt}`).expect(401);
  });

  it('吊销后的明文、格式错误的明文 exchange → 401', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/api-token/exchange')
      .set('Authorization', `Bearer ${plaintext}`).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/api-token/exchange')
      .set('Authorization', 'Bearer fs_api_deadbeef').expect(401);
  });
});
```

**硬性规定（防 scope 放大）**：JwtStrategy 中 `scopes` 一律以**数据库记录**为准（`JSON.parse(token.scopes)`），payload.scopes 仅作冗余展示。实现时 strategy 里 `scopes:` 一行固定为：

```typescript
        scopes: JSON.parse(token.scopes) as string[], // 以 DB 为准，防 JWT 伪造放大
```

Run: `npm run test:e2e --workspace=@filestation/server -- api-token-exchange`
Expected: 7 个用例全 PASS（以实际运行结果为准）

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/auth apps/server/src/security apps/server/src/files apps/server/src/folders apps/server/src/shares apps/server/src/settings apps/server/test/helpers.ts apps/server/test/api-token-exchange.e2e-spec.ts
git commit -m "feat(server): API Token exchange 换短期 JWT + scope 检查内嵌 JwtAuthGuard（默认拒绝）+ JwtStrategy 支持 api_token 主体（scopes 以 DB 为准）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 审计日志模块与埋点

**Files:**
- Create: `apps/server/src/audit/audit.service.ts`
- Create: `apps/server/src/audit/audit.controller.ts`
- Create: `apps/server/src/audit/audit.module.ts`
- Create: `apps/server/src/audit/dto/list-audit-logs.dto.ts`
- Modify: `apps/server/src/app.module.ts`（注册 AuditModule）
- Modify: `apps/server/src/auth/auth.service.ts`（登录成功/失败/exchange 埋点）
- Modify: `apps/server/src/api-tokens/api-tokens.controller.ts`（签发/吊销埋点）
- Modify: `apps/server/src/files/files.controller.ts`（删除埋点）、`apps/server/src/files/uploads.controller.ts`（init/complete 埋点）
- Modify: `apps/server/src/shares/shares.controller.ts`（创建/吊销埋点）
- Modify: `apps/server/src/settings/settings.controller.ts`（更新埋点）
- Test: `apps/server/src/audit/audit.service.spec.ts`

**Interfaces:**
- Produces:
  - `AuditService.record(entry: { accountId: string | null; action: string; resourceType?: string; resourceId?: string; details?: Record<string, unknown>; ip?: string; userAgent?: string }): Promise<void>`（**永不抛异常**——审计失败不阻断业务，内部 catch + Logger.warn）
  - `AuditService.findAll(page: number, pageSize: number, action?: string): Promise<PaginatedResponse<AuditLogEntry>>`（返回 shared 的 5 字段分页结构 {items, total, page, page_size, total_pages}，与控制器声明一致）
  - `AuditService.purgeExpired(): Promise<number>`（@Cron 每日 04:00，删 90 天前）
  - `GET /api/v1/audit-logs?page=&page_size=&action=`（JwtAuthGuard + AdminOnlyGuard）
  - action 常量（字符串）：`auth.login / auth.login_failed / auth.api_token_exchanged / api_token.created / api_token.revoked / upload.initiated / upload.completed / file.deleted / share.created / share.revoked / settings.updated / mcp.tool_called / auth.totp_enabled / auth.totp_disabled / auth.totp_failed / recovery.generated / recovery.used`

- [ ] **Step 1: 写失败测试** `apps/server/src/audit/audit.service.spec.ts`

```typescript
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from './audit.service';
import { AuditLog } from './entities/audit-log.entity';

describe('AuditService', () => {
  let service: AuditService;
  let repo: { save: jest.Mock; findAndCount: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    repo = { save: jest.fn(async (e) => e), findAndCount: jest.fn(async () => [[], 0]), delete: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [AuditService, { provide: getRepositoryToken(AuditLog), useValue: repo }],
    }).compile();
    service = module.get(AuditService);
  });

  it('IPv4 按 /24 匿名化', async () => {
    await service.record({ accountId: 'a1', action: 'auth.login', ip: '203.0.113.87' });
    expect(repo.save.mock.calls[0][0].ipAddress).toBe('203.0.113.0');
  });

  it('IPv6 保留前 3 段', async () => {
    await service.record({ accountId: 'a1', action: 'auth.login', ip: '2001:db8:85a3::8a2e:370:7334' });
    expect(repo.save.mock.calls[0][0].ipAddress).toBe('2001:db8:85a3::');
  });

  it('record 内部异常不抛出（审计不阻断业务）', async () => {
    repo.save.mockRejectedValue(new Error('db locked'));
    await expect(service.record({ accountId: null, action: 'auth.login' })).resolves.toBeUndefined();
  });

  it('purgeExpired 删除 90 天前记录', async () => {
    await service.purgeExpired();
    expect(repo.delete).toHaveBeenCalled();
    const arg = repo.delete.mock.calls[0][0];
    expect(JSON.stringify(arg)).toContain('createdAt');
  });

  it('findAll 返回 PaginatedResponse 五字段（与 shared 类型契约一致）', async () => {
    repo.findAndCount.mockResolvedValue([[], 0]);
    const res = await service.findAll(2, 20);
    expect(res).toEqual({ items: [], total: 0, page: 2, page_size: 20, total_pages: 1 });
    expect(repo.findAndCount.mock.calls[0][0].skip).toBe(20);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test --workspace=@filestation/server -- audit.service`
Expected: FAIL

- [ ] **Step 3: 实现**

`apps/server/src/audit/audit.service.ts`：

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { AuditLog } from './entities/audit-log.entity';
import { AuditLogEntry, PaginatedResponse } from '@filestation/shared';

export interface AuditEntry {
  accountId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 天（设计 v2.2 §6.5）

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private auditRepository: Repository<AuditLog>,
  ) {}

  /** 审计写入永不阻断业务：内部吞异常 */
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
        userAgent: entry.userAgent ? entry.userAgent.substring(0, 256) : null,
        createdAt: Date.now(),
      });
    } catch (err) {
      this.logger.warn(`audit record failed: ${(err as Error).message}`);
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
      items: rows.map((r) => this.toEntry(r)),
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

  /** IPv4 /24（末段置 0）；IPv6 保留前 3 段 */
  private anonymizeIp(ip: string): string {
    if (ip.includes('.')) {
      const parts = ip.split('.');
      if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
      return ip;
    }
    if (ip.includes(':')) {
      const head = ip.split(':').filter(Boolean).slice(0, 3).join(':');
      return `${head}::`;
    }
    return ip;
  }

  private toEntry(r: AuditLog): AuditLogEntry {
    return {
      id: r.id,
      account_id: r.accountId,
      action: r.action,
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      details: r.details ? JSON.parse(r.details) : null,
      ip_address: r.ipAddress,
      user_agent: r.userAgent,
      created_at: new Date(r.createdAt).toISOString(),
    };
  }
}
```

`apps/server/src/audit/dto/list-audit-logs.dto.ts`：

```typescript
import { IsOptional, IsInt, Min, Max, IsString, Length } from 'class-validator';
import { Type } from 'class-transformer';

export class ListAuditLogsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  page_size?: number = 20;

  @IsOptional() @IsString() @Length(1, 64)
  action?: string;
}
```

`apps/server/src/audit/audit.controller.ts`：

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';
import { ApiResponse, AuditLogEntry, PaginatedResponse } from '@filestation/shared';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get()
  async list(@Query() query: ListAuditLogsDto): Promise<ApiResponse<PaginatedResponse<AuditLogEntry>>> {
    const result = await this.auditService.findAll(query.page ?? 1, query.page_size ?? 20, query.action);
    return { code: 'OK', message: 'Success', data: result, request_id: crypto.randomUUID() };
  }
}
```

`apps/server/src/audit/audit.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { SecurityModule } from '../security/security.module';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog]), SecurityModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

`app.module.ts` imports 追加 `AuditModule`。

- [ ] **Step 4: 埋点接入**

埋点统一模式（controller 层有 req.ip / UA，service 层没有——全部在 controller 或已持有 ip 的 auth.service 中调用）：

- `auth.service.ts login()`：成功处 `await this.auditService.record({ accountId: account.id, action: 'auth.login', ip: clientIp })`；失败处 `action: 'auth.login_failed'`，details `{ username: loginDto.username }`（**不记密码**）。`exchangeApiToken()` 成功处 `action: 'auth.api_token_exchanged'`，resourceType `'api_token'`，resourceId `token.id`。AuthModule imports 追加 `AuditModule`。
- `api-tokens.controller.ts`：create → `api_token.created`（details `{ name, scopes }`）；revoke → `api_token.revoked`。ApiTokensModule imports 追加 `AuditModule`。
- `uploads.controller.ts`：initialize → `upload.initiated`（resourceId = upload_id）；complete → `upload.completed`（details `{ filename, size }` 取自结果）。FilesModule imports 追加 `AuditModule`。
- `files.controller.ts`：delete → `file.deleted`（resourceId = file id）。
- `shares.controller.ts`：create → `share.created`（details `{ protection, max_downloads }`——**不记 password**）；revoke → `share.revoked`。SharesModule imports 追加 `AuditModule`。
- `settings.controller.ts`：update → `settings.updated`，details 为**变更的 key 列表**（如 `{ sections: ['security'] }`——不记值，防密码类值入日志）。SettingsModule imports 追加 `AuditModule`。

每处注入：`constructor(..., private auditService: AuditService)`；req 取 `req.ip` 与 `req.headers['user-agent']`。

- [ ] **Step 5: 运行测试 + 既有测试回归**

Run: `npm run test --workspace=@filestation/server`
Expected: 全部 PASS（既有 spec 的模块 mock 若缺 AuditService provider 会编译失败——在对应 spec 的 TestingModule providers 里补 `{ provide: AuditService, useValue: { record: jest.fn() } }`）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/audit apps/server/src/auth apps/server/src/api-tokens apps/server/src/files apps/server/src/shares apps/server/src/settings apps/server/src/app.module.ts
git commit -m "feat(server): 审计日志模块（/24 匿名化、90 天保留、写失败不阻断业务）+ 关键操作埋点

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: MCP 服务内嵌（设置开关 + Streamable HTTP + 11 个工具）

**Files:**
- Modify: `apps/server/package.json`（deps 锁定：`@modelcontextprotocol/sdk@^1.30.0`、`zod@^3.25.76`）
- Modify: `apps/server/src/main.ts`（`/api/v1/mcp` 路由级 JSON body 上限 16MB）
- Modify: `apps/server/src/settings/settings.service.ts`（新增 `AgentSettings` + `getAgentSettings`）
- Modify: `apps/server/src/settings/dto/update-settings.dto.ts`（新增 `AgentSettingsDto` + UpdateSettingsDto.agent）
- Modify: `apps/server/src/settings/settings.controller.ts`（GET/PUT 合并 agent 段）
- Create: `apps/server/src/mcp/mcp.module.ts`
- Create: `apps/server/src/mcp/mcp.controller.ts`
- Create: `apps/server/src/mcp/mcp.service.ts`
- Modify: `apps/server/src/app.module.ts`（注册 McpModule）
- Modify: `apps/server/src/files/files.module.ts`、`apps/server/src/folders/folders.module.ts`、`apps/server/src/shares/shares.module.ts`（exports 补 Services）
- Modify: `apps/server/src/shares/shares.service.ts`（新增 `findAll`）
- Test: `apps/server/src/mcp/mcp.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 `ApiTokensService.validatePlaintext/touchLastUsed`；Task 4 `AuditService.record`；`UploadsService.initializeUpload/uploadPart/completeUpload`
- Produces:
  - `AgentSettings = { mcp_enabled: boolean; mcp_max_upload_mb: number }`，settings key `'agent'`，默认 `{ mcp_enabled: false, mcp_max_upload_mb: 32 }`
  - `POST /api/v1/mcp`：MCP Streamable HTTP（无状态模式：每请求新建 server+transport，`sessionIdGenerator: undefined`）；GET/DELETE → 404（与开关关闭同语义，不暴露功能存在性）
  - 鉴权：`Authorization: Bearer fs_api_*` 直接验证（**不走 exchange**——MCP 客户端持长期 token）；开关关闭 → 404
  - 工具（11 个，scope 需求）：`server_info`(任意有效 token)、`list_files`(files:read)、`list_folders`(folders:read)、`create_folder`(folders:write)、`upload_init`/`upload_part`/`complete_upload`(files:write)、`delete_file`(files:write)、`create_share`(shares:write)、`list_shares`(shares:read)、`revoke_share`(shares:write)
  - **上传拆三工具的原因**：Express 默认 JSON body 上限 100KB，整文件 base64 会 413；拆开后 `upload_part` 单分块 ≤ chunk_size（≤8MB 原始 ≈ 10.7MB base64），main.ts 仅对 `/api/v1/mcp` 放宽到 16MB，其余路由保持 100KB。`mcp_max_upload_mb` 语义为**单文件总大小上限**，在 `upload_init` 检查（FILE_TOO_LARGE 快速失败，不必等分块传完）

- [ ] **Step 1: 装依赖（锁定版本）+ 立即类型验证**

```bash
npm install @modelcontextprotocol/sdk@^1.30.0 zod@^3.25.76 --workspace=@filestation/server
npm run typecheck --workspace=@filestation/server
```

锁版本原因：MCP SDK 迭代快且跨大版本删过 API。npm 上本包最新 1.30.x，无 v2——v2 线是新包名 `@modelcontextprotocol/server@2.0.0-alpha`，不装。本计划工具注册用 variadic `server.tool(name, desc, schema, handler)`：1.30.x 中已标注 `@deprecated Use registerTool instead`，但全部重载可用、锁定版本内行为确定；未来升级 v2 线时统一迁移 `registerTool`（改动机械）。SDK 依赖会带入一份嵌套 express 5（应用本体 express 4）——`handleRequest` 只消费 Node req/res，二者并存兼容，知悉即可无需处理。`zod@^3.25.76` 取 SDK peer 范围（`^3.25 || ^4.0`）的 3.x 一侧——zod 4.x 的泛型签名与 SDK 1.30 类型推导不兼容（`server.tool()` 回调参数会退化成 unknown）。typecheck 装完必须即绿；若依赖解析出意外结果，停在 1.30.x/3.25.x 排查，不要升级硬闯。

- [ ] **Step 2: 写失败测试** `apps/server/src/mcp/mcp.service.spec.ts`

```typescript
import { McpService, McpPrincipal } from './mcp.service';

describe('McpService scope enforcement', () => {
  const principal: McpPrincipal = {
    accountId: 'a1', tokenId: 't1', scopes: ['files:read'], ip: '10.0.0.0',
  };

  it('scope 不足的工具调用抛出带 MISSING_SCOPE 的错误', () => {
    const service = new McpService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(() => service.assertScope(principal, 'files:write')).toThrow(/MISSING_SCOPE/);
  });

  it('scope 足够不抛', () => {
    const service = new McpService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    expect(() => service.assertScope(principal, 'files:read')).not.toThrow();
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm run test --workspace=@filestation/server -- mcp.service`
Expected: FAIL

- [ ] **Step 4: agent 设置段**

`settings.service.ts` 追加：

```typescript
export interface AgentSettings {
  mcp_enabled: boolean;
  mcp_max_upload_mb: number;
}

  async getAgentSettings(): Promise<AgentSettings> {
    return this.get<AgentSettings>('agent', { mcp_enabled: false, mcp_max_upload_mb: 32 });
  }
```

`update-settings.dto.ts` 追加（并在 `UpdateSettingsDto` 加 `agent?: AgentSettingsDto` 字段）：

```typescript
export class AgentSettingsDto {
  @IsOptional() @IsBoolean()
  mcp_enabled?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(512)
  mcp_max_upload_mb?: number;
}
```

`settings.controller.ts`：GET 的 `Promise.all` 加 `this.settingsService.getAgentSettings()` 并入返回 `data.agent`；PUT 增加：

```typescript
    if (body.agent) {
      const current = await this.settingsService.getAgentSettings();
      await this.settingsService.set('agent', { ...current, ...omitUndefined(body.agent) }, userId);
    }
```

- [ ] **Step 5: McpService（工具注册核心）**

`apps/server/src/mcp/mcp.service.ts`：

```typescript
import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FilesService } from '../files/files.service';
import { UploadsService } from '../files/uploads.service';
import { FoldersService } from '../folders/folders.service';
import { SharesService } from '../shares/shares.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ShareType, ShareProtection } from '../shares/entities/share.entity';
import { createHash } from 'crypto';

export interface McpPrincipal {
  accountId: string;
  tokenId: string;
  scopes: string[];
  ip: string;
}

@Injectable()
export class McpService {
  constructor(
    private filesService: FilesService,
    private uploadsService: UploadsService,
    private foldersService: FoldersService,
    private sharesService: SharesService,
    private settingsService: SettingsService,
    private auditService: AuditService,
  ) {}

  assertScope(principal: McpPrincipal, scope: string): void {
    if (!principal.scopes.includes(scope)) {
      throw new Error(`MISSING_SCOPE: tool requires scope "${scope}"`);
    }
  }

  /** 每请求一个 server 实例（无状态 Streamable HTTP） */
  buildServer(principal: McpPrincipal, baseUrl: string): McpServer {
    const server = new McpServer(
      { name: 'filestation', version: '0.2.0' },
      { capabilities: { tools: {} } },
    );
    const audit = (tool: string, details?: Record<string, unknown>) =>
      this.auditService.record({
        accountId: principal.accountId, action: 'mcp.tool_called',
        resourceType: 'mcp_tool', resourceId: tool, details, ip: principal.ip,
      });
    const text = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

    server.tool('server_info', 'FileStation 站点与能力信息', {}, async () => {
      await audit('server_info');
      const site = await this.settingsService.getSiteSettings();
      const agent = await this.settingsService.getAgentSettings();
      return text({ site_name: site.name, mcp_max_upload_mb: agent.mcp_max_upload_mb, server_time: new Date().toISOString() });
    });

    server.tool('list_files', '列出文件（分页）', {
      page: z.number().int().min(1).default(1),
      page_size: z.number().int().min(1).max(100).default(20),
      folder_id: z.string().optional(),
    }, async ({ page, page_size, folder_id }) => {
      this.assertScope(principal, 'files:read');
      await audit('list_files');
      const { items, total } = await this.filesService.findAll(page, page_size, folder_id);
      return text({ total, items: items.map((f) => ({ id: f.id, filename: f.filename, size: f.size, expires_at: f.expiresAt ? new Date(f.expiresAt).toISOString() : null, download_count: f.downloadCount })) });
    });

    server.tool('list_folders', '列出全部文件夹', {}, async () => {
      this.assertScope(principal, 'folders:read');
      await audit('list_folders');
      const folders = await this.foldersService.findAll();
      return text(folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parentId })));
    });

    server.tool('create_folder', '新建文件夹', {
      name: z.string().min(1).max(128),
      parent_id: z.string().nullable().default(null),
    }, async ({ name, parent_id }) => {
      this.assertScope(principal, 'folders:write');
      const folder = await this.foldersService.create(name, parent_id, principal.accountId);
      await audit('create_folder', { folder_id: folder.id });
      return text({ id: folder.id, name: folder.name });
    });

    // ---- 上传三件套：upload_init → upload_part×N → complete_upload ----
    // （整文件 base64 会撞全局 100KB JSON body 上限；分块 ≤8MB 原始 ≈ 10.7MB base64，走 16MB 路由级上限）
    server.tool('upload_init', '开始上传：校验单文件大小上限，创建上传会话，返回 upload_id/upload_token/分块参数。chunk_size 可省略——服务端取 min(8MB, 全局默认分块)，本路由硬上限 8MB（再大 base64 会撞 16MB body 上限 413）', {
      filename: z.string().min(1).max(255),
      size: z.number().int().min(0),
      folder_id: z.string().optional(),
      chunk_size: z.number().int().min(64 * 1024).max(8 * 1024 * 1024).optional(),
    }, async ({ filename, size, folder_id, chunk_size }) => {
      this.assertScope(principal, 'files:write');
      const agent = await this.settingsService.getAgentSettings();
      const maxBytes = agent.mcp_max_upload_mb * 1024 * 1024;
      if (size > maxBytes) {
        throw new Error(`FILE_TOO_LARGE: ${size} bytes > limit ${maxBytes} (agent.mcp_max_upload_mb)`);
      }
      // chunk_size 缺省时不能原样透传：initializeUpload 会继承全局 default_chunk_size（设置允许到 64MiB），
      // 超过 8MB 则首个 upload_part 的 base64 撞本路由 16MB JSON body 上限 → 413（Express 非 JSON 错误页）。
      const transfer = await this.settingsService.getTransferSettings();
      const effectiveChunkSize = chunk_size ?? Math.min(8 * 1024 * 1024, transfer.default_chunk_size);
      const init = await this.uploadsService.initializeUpload(
        { filename, size, chunk_size: effectiveChunkSize, folder_id }, 'admin', principal.accountId,
      );
      await audit('upload_init', { upload_id: init.upload_id, filename, size });
      return text({
        upload_id: init.upload_id,
        upload_token: init.upload_token,
        chunk_size: init.chunk_size,
        total_chunks: Math.max(1, Math.ceil(size / init.chunk_size)),
        next: '对 part_number ∈ [0, total_chunks) 逐块调 upload_part（content_base64 的原始字节 ≤ chunk_size），全部成功后调 complete_upload',
      });
    });

    server.tool('upload_part', '上传一个分块（content_base64 解码后 ≤ upload_init 返回的 chunk_size，服务端硬上限 8MB）', {
      upload_id: z.string(),
      upload_token: z.string(),
      part_number: z.number().int().min(0),
      content_base64: z.string(),
    }, async ({ upload_id, upload_token, part_number, content_base64 }) => {
      this.assertScope(principal, 'files:write');
      const data = Buffer.from(content_base64, 'base64');
      const checksum = createHash('sha256').update(data).digest('hex');
      await this.uploadsService.uploadPart(upload_id, part_number, data, checksum, upload_token);
      await audit('upload_part', { upload_id, part_number, size: data.length });
      return text({ upload_id, part_number, received_bytes: data.length });
    });

    server.tool('complete_upload', '全部分块就绪后合并为文件，返回 file_id（幂等）', {
      upload_id: z.string(),
      upload_token: z.string(),
    }, async ({ upload_id, upload_token }) => {
      this.assertScope(principal, 'files:write');
      const { file_id } = await this.uploadsService.completeUpload(upload_id, upload_token);
      await audit('complete_upload', { upload_id, file_id });
      return text({ file_id });
    });

    server.tool('delete_file', '删除文件（进入清理队列）', {
      file_id: z.string(),
    }, async ({ file_id }) => {
      this.assertScope(principal, 'files:write');
      await this.filesService.delete(file_id);
      await audit('delete_file', { file_id });
      return text({ deleted: file_id });
    });

    server.tool('create_share', '为文件创建分享链接', {
      file_id: z.string(),
      protection: z.enum(['none', 'password']).default('none'),
      password: z.string().min(4).optional(),
      max_downloads: z.number().int().min(1).optional(),
      expires_in_hours: z.number().int().min(1).optional(),
    }, async ({ file_id, protection, password, max_downloads, expires_in_hours }) => {
      this.assertScope(principal, 'shares:write');
      if (protection === 'password' && !password) throw new Error('PASSWORD_REQUIRED: protection=password 时必须提供 password');
      const share = await this.sharesService.createShare(
        file_id, ShareType.PAGE,
        protection === 'password' ? ShareProtection.PASSWORD : ShareProtection.NONE,
        password ?? null, max_downloads ?? null,
        expires_in_hours ? new Date(Date.now() + expires_in_hours * 3_600_000) : null,
        principal.accountId,
      );
      await audit('create_share', { share_id: share.id, protection });
      // share_url 为规范相对路径（客户端自行拼 host）；share_url_absolute 由请求 Host 推导，
      // 可被伪造、仅作展示便利——权威 public_base_url 设置项属 Phase 3
      return text({ share_id: share.id, share_url: `/s/${share.id}`, share_url_absolute: `${baseUrl}/s/${share.id}` });
    });

    server.tool('list_shares', '列出分享（可按文件过滤）', {
      file_id: z.string().optional(),
    }, async ({ file_id }) => {
      this.assertScope(principal, 'shares:read');
      await audit('list_shares');
      const shares = file_id ? await this.sharesService.findByFile(file_id) : await this.sharesService.findAll();
      return text(shares.map((s) => ({
        share_id: s.id, share_url: `/s/${s.id}`, share_url_absolute: `${baseUrl}/s/${s.id}`, file_id: s.fileId,
        protection: s.protection, status: s.status,
        used_downloads: s.usedDownloads, max_downloads: s.maxDownloads,
        expires_at: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      })));
    });

    server.tool('revoke_share', '吊销分享链接', {
      share_id: z.string(),
    }, async ({ share_id }) => {
      this.assertScope(principal, 'shares:write');
      await this.sharesService.revokeShare(share_id);
      await audit('revoke_share', { share_id });
      return text({ revoked: share_id });
    });

    return server;
  }
}
```

`shares.service.ts` 追加（list_shares 不带 file_id 时用）：

```typescript
  async findAll(): Promise<Share[]> {
    return this.sharesRepository.find({ order: { createdAt: 'DESC' }, take: 200 });
  }
```

- [ ] **Step 6: McpController 与 Module**

`apps/server/src/mcp/mcp.controller.ts`：

```typescript
import { Controller, Post, Get, Delete, Req, Res, UnauthorizedException, NotFoundException, HttpCode, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpService, McpPrincipal } from './mcp.service';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { SettingsService } from '../settings/settings.service';

@Controller('mcp')
export class McpController {
  constructor(
    private mcpService: McpService,
    private apiTokensService: ApiTokensService,
    private settingsService: SettingsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    // 1) 开关关闭 = 端点不存在（不暴露功能存在性）
    const agent = await this.settingsService.getAgentSettings();
    if (!agent.mcp_enabled) throw new NotFoundException('Not found');

    // 2) Bearer fs_api_* 直接验证（MCP 客户端持长期 token，不走 exchange）
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!raw) throw new UnauthorizedException('Missing API token');
    const token = await this.apiTokensService.validatePlaintext(raw);
    if (!token) throw new UnauthorizedException('Invalid or expired API token');

    const principal: McpPrincipal = {
      accountId: token.accountId,
      tokenId: token.id,
      scopes: JSON.parse(token.scopes),
      ip: req.ip ?? 'unknown',
    };
    await this.apiTokensService.touchLastUsed(token.id, principal.ip);

    // 3) 无状态模式：每请求新建 server + transport
    // baseUrl 仅用于工具返回的 share_url_absolute 展示字段：未开 trust proxy，
    // proto/Host 头均可伪造，它永远只是"尽力而为"，不是权威来源（Phase 3 public_base_url）
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const baseUrl = `${proto}://${req.headers.host}`;
    const server = this.mcpService.buildServer(principal, baseUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  // 无状态模式不支持 SSE 流/会话终止
  @Get() methodNotAllowed(): void { throw new NotFoundException('Not found'); }
  @Delete() methodNotAllowedDelete(): void { throw new NotFoundException('Not found'); }
}
```

`apps/server/src/mcp/mcp.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { FilesModule } from '../files/files.module';
import { FoldersModule } from '../folders/folders.module';
import { SharesModule } from '../shares/shares.module';
import { SettingsModule } from '../settings/settings.module';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [FilesModule, FoldersModule, SharesModule, SettingsModule, ApiTokensModule, AuditModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
```

模块 exports 补全：`files.module.ts` exports 加 `FilesService, UploadsService`；`folders.module.ts` exports 加 `FoldersService`；`shares.module.ts` exports 加 `SharesService`。`app.module.ts` imports 追加 `McpModule`。

- [ ] **Step 6b: main.ts——仅 MCP 路由放宽 JSON body 上限**

`apps/server/src/main.ts` 顶部 import 区加 `import { json } from 'express';`，在 `app.use(cookieParser());` 之前插入：

```typescript
  // MCP upload_part 携带 base64 分块（≤8MB 原始 ≈ 10.7MB base64），仅该路由放宽到 16MB。
  // 这里 app.use 早于 Nest 全局 100KB parser 的注册（后者在 app.init() 时进栈）；
  // 本中间件解析后置 req._body，全局 parser 对 /api/v1/mcp 自动跳过，其余路由仍 100KB。
  app.use('/api/v1/mcp', json({ limit: '16mb' }));
```

位置约束：在 `NestFactory.create(...)` 之后、`await app.init()` 之前（main.ts 阶段 2 内）。Express 的 `app.use(path)` 按前缀匹配，`/api/v1/mcp` 与全局前缀拼出的实际路径一致（app.use 不受 setGlobalPrefix 影响，写完整 URL 路径）。

- [ ] **Step 7: 测试 + 手动冒烟**

Run: `npm run test --workspace=@filestation/server -- mcp.service`
Expected: PASS

手动冒烟（写进任务验收）：
```bash
# 设置页打开 MCP 开关后（或 PUT /settings {"agent":{"mcp_enabled":true}}）
curl -X POST http://localhost:8080/api/v1/mcp \
  -H "Authorization: Bearer fs_api_<刚签发的 token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# 预期返回 11 个工具；关开关后同请求 → 404
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mcp apps/server/src/settings apps/server/src/files/files.module.ts apps/server/src/folders apps/server/src/shares apps/server/src/app.module.ts apps/server/src/main.ts apps/server/package.json package-lock.json
git commit -m "feat(server): MCP 服务内嵌——设置开关 + Streamable HTTP /api/v1/mcp + 11 个工具（上传拆 init/part/complete 三件套，逐工具 scope 校验 + 审计）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: 前端全局导航 + 移动端适配

> 本任务修复实测确认的问题清单（2026-09-19 移动端视口 375×812 实测）：文件表格无横向滚动导致操作列出屏、文件夹操作依赖 hover 触屏不可达、侧栏 256px 常驻挤占一半宽度、长文件名溢出、弹窗贴边、分享页卡片贴边、全站无设置入口。

**Files:**
- Create: `apps/web/src/components/AppLayout.tsx`
- Modify: `apps/web/src/App.tsx`（套布局；/audit 路由在 Task 7 随审计页一起加）
- Modify: `apps/web/src/pages/FilesPage.tsx`（抽屉式侧栏 + AppLayout）
- Modify: `apps/web/src/components/FileList.tsx`（桌面表格 + 移动卡片双渲染）
- Modify: `apps/web/src/components/FolderTree.tsx`（触屏可达操作 + 截断）
- Modify: `apps/web/src/components/ShareCreateDialog.tsx`、`MoveFileDialog.tsx`（弹窗边距）
- Modify: `apps/web/src/pages/SharePage.tsx`（卡片边距 + 长文件名断行）
- Modify: `apps/web/src/pages/SettingsPage.tsx`（套 AppLayout）

**Interfaces:**
- Produces:
  - `AppLayout({ children, onFolderToggle? })`：全局头部（FileStation 标题 + 导航 文件/设置 + 用户名 + 退出；移动端汉堡按钮仅 files 页显示）；审计导航项在 Task 7 加入
  - FilesPage 移动端：侧栏变为 `fixed inset-y-0 left-0 z-40` 抽屉 + 半透明背板；`md:` 起恢复静态侧栏
  - FileList 移动端：卡片列表（文件名 truncate + 大小/过期摘要 + 下载/分享/更多操作）；`md:` 起渲染既有表格

- [ ] **Step 1: AppLayout**

`apps/web/src/components/AppLayout.tsx`：

```tsx
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

interface AppLayoutProps {
  children: React.ReactNode;
  onFolderToggle?: () => void; // 仅文件页传：显示汉堡按钮
}

export default function AppLayout({ children, onFolderToggle }: AppLayoutProps) {
  const logout = useAuthStore((s) => s.logout);
  const username = useAuthStore((s) => s.username);
  const location = useLocation();
  const navigate = useNavigate();

  const navItems = [
    { to: '/', label: '文件' },
    { to: '/settings', label: '设置' },
  ];

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow sticky top-0 z-30">
        <div className="px-4 py-3 flex items-center gap-3">
          {onFolderToggle && (
            <button
              className="md:hidden p-2 -ml-2 text-gray-600"
              aria-label="文件夹"
              onClick={onFolderToggle}
            >
              ☰
            </button>
          )}
          <Link to="/" className="text-xl font-bold">FileStation</Link>
          <nav className="flex items-center gap-1 ml-2">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`px-3 py-2 rounded text-sm ${
                  location.pathname === item.to ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-gray-600 hidden sm:inline">{username}</span>
            <button onClick={handleLogout} className="text-sm text-red-600 hover:text-red-800 py-2">退出</button>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: FilesPage 抽屉化**

`FilesPage.tsx` 改为（要点，保留既有数据逻辑）：

```tsx
// 新增 state: const [drawerOpen, setDrawerOpen] = useState(false);
// 选中文件夹后关抽屉：handleSelectFolder 里加 setDrawerOpen(false)

// 抽屉打开时锁 body 滚动（防背后页面跟着滚），卸载/关闭时还原：
// useEffect(() => {
//   document.body.style.overflow = drawerOpen ? 'hidden' : '';
//   return () => { document.body.style.overflow = ''; };
// }, [drawerOpen]);

<AppLayout onFolderToggle={() => setDrawerOpen(true)}>
  <div className="flex flex-1 overflow-hidden">
    {/* 移动端抽屉 */}
    {drawerOpen && (
      <div className="fixed inset-0 z-40 md:hidden">
        <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
        <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl overflow-y-auto">
          <FolderTree selectedFolderId={selectedFolderId} onSelect={handleSelectFolder} refreshKey={treeRefreshKey} />
        </div>
      </div>
    )}
    {/* 桌面静态侧栏（md 起显示） */}
    <div className="hidden md:block">
      <FolderTree selectedFolderId={selectedFolderId} onSelect={handleSelectFolder} refreshKey={treeRefreshKey} />
    </div>
    <main className="flex-1 p-4 md:p-6 overflow-y-auto">
      <div className="mb-6">
        <FileUpload onUploadComplete={loadFiles} folderId={selectedFolderId === 'root' ? null : selectedFolderId} />
      </div>
      <FileList files={files} total={total} page={page} onPageChange={setPage} onChanged={loadFiles} />
    </main>
  </div>
</AppLayout>
```

同时删除 FilesPage 原有 header 块（并入 AppLayout）。`App.tsx` 中 FilesPage/SettingsPage 无需改动（布局在页面内）；/audit 路由 Task 7 添加。

- [ ] **Step 3: FolderTree 触屏可达**

`FolderTree.tsx` 两处改动：

```tsx
// 1) 操作按钮：移动端常显，桌面 hover 显（原 hidden group-hover:flex）
<span className="flex md:hidden md:group-hover:flex space-x-1 text-xs text-gray-500">

// 2) 根容器宽度：抽屉内自适应，桌面固定 256px
<div className="w-full md:w-64 flex-shrink-0 bg-white border-r border-gray-200 p-2 overflow-y-auto">
```

- [ ] **Step 4: FileList 移动端卡片**

`FileList.tsx` 结构调整（保留既有 handler）：

```tsx
return (
  <div>
    {/* 移动端卡片（md 以下） */}
    <div className="md:hidden space-y-3">
      {files.map((file) => (
        <div key={file.id} className="bg-white shadow rounded-lg p-4">
          <div className="font-medium text-sm truncate" title={file.filename}>{file.filename}</div>
          <div className="text-xs text-gray-500 mt-1">
            {formatSize(file.size)} · {file.expires_at ? new Date(file.expires_at).toLocaleDateString() : '永久'} · {file.download_count} 次下载
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3 text-sm">
            <button onClick={() => handleDownload(file)} className="text-blue-600 py-1">下载</button>
            <button onClick={() => setShareDialogFile(file)} className="text-green-600 py-1">分享</button>
            <button onClick={() => setMoveDialogFile(file)} className="text-gray-600 py-1">移动</button>
            <button onClick={() => handleExtend(file)} className="text-gray-600 py-1">延期</button>
            <button onClick={() => toggleShares(file)} className="text-gray-600 py-1">分享列表</button>
            <button onClick={() => handleDelete(file)} className="text-red-600 py-1">删除</button>
          </div>
          {/* 展开的分享列表：复用现有 JSX（抽为 renderShares(file) 函数，桌面/移动共用） */}
          {expandedShares[file.id] && renderShares(file)}
        </div>
      ))}
    </div>

    {/* 桌面表格（md 起），外包横向滚动容器 */}
    <div className="hidden md:block bg-white shadow rounded-lg overflow-x-auto">
      {/* 既有 <table> 原样保留；文件名单元格加 max-w truncate： */}
      {/* <td className="px-4 py-3 text-sm font-medium max-w-[280px] truncate" title={file.filename}> */}
      {/* 表格内展开行改为调用同一 renderShares(file)；其余表格主体 JSX 原样保留（仓库现有代码，本任务不重抄） */}
    </div>

    {/* 分页条与对话框原样保留 */}
  </div>
);
```

抽共用函数（组件内）：

```tsx
const renderShares = (file: FileMetadata) => (
  expandedShares[file.id]!.length === 0 ? (
    <span className="text-xs text-gray-400">暂无分享</span>
  ) : (
    <ul className="space-y-1 mt-2">
      {expandedShares[file.id]!.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-mono break-all">{window.location.origin}{s.share_url}</span>
          <span>{s.protection === 'password' ? '密码' : '免密'}</span>
          <span>{s.used_downloads}{s.max_downloads !== null ? `/${s.max_downloads}` : ''} 次</span>
          <span>{s.expires_at ? new Date(s.expires_at).toLocaleString() : '永久'}</span>
          {s.status === 'revoked' ? (
            <span className="text-gray-400">已吊销</span>
          ) : (
            <button onClick={() => handleRevokeShare(file.id, s.id)} className="text-red-600">吊销</button>
          )}
        </li>
      ))}
    </ul>
  )
);
```

- [ ] **Step 5: 弹窗与分享页边距**

- `ShareCreateDialog.tsx` / `MoveFileDialog.tsx`：内容容器 `className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md"` → 加 `mx-4`（即 `w-full max-w-md mx-4`）
- `SharePage.tsx`：
  - 外层 `<div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">`
  - 文件名 `<h2 className="text-xl md:text-2xl font-bold mb-4 break-words">`
  - 下载按钮加 `py-3`（更大触控目标）

- [ ] **Step 6: SettingsPage 套布局**

```tsx
// 外层 <div className="min-h-screen bg-gray-50 p-8"> 改为：
<AppLayout>
  <div className="p-4 md:p-8">
    <div className="max-w-4xl mx-auto">
      {/* 原内容 */}
    </div>
  </div>
</AppLayout>
```

- [ ] **Step 7: 移动端视口实测（验收门槛）**

```bash
npm run dev  # 5173
```
浏览器 375×812 视口逐项过：
- 文件页：汉堡开抽屉、选文件夹关抽屉、文件卡片操作全部可点、无横向溢出（`document.documentElement.scrollWidth <= 375`）
- 分享创建弹窗：左右有边距
- 分享页（/s/:id）：卡片不贴边、长无空格文件名不断版
- 设置页：可从导航进入并返回

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 全局导航 + 移动端适配——抽屉式文件夹、卡片式文件列表、触屏可达操作、弹窗/分享页边距

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: 前端设置页扩展（API Token + MCP 开关）+ 审计日志页

**Files:**
- Create: `apps/web/src/pages/settings/ApiTokensSection.tsx`
- Create: `apps/web/src/pages/settings/AgentSection.tsx`
- Create: `apps/web/src/pages/AuditPage.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx`（挂新 section + agent 状态）
- Modify: `apps/web/src/App.tsx`（/audit 路由）
- Modify: `apps/web/src/components/AppLayout.tsx`（导航加"审计"）

**Interfaces:**
- Consumes: Task 2/3 端点（`/api-tokens`）、Task 4 端点（`/audit-logs`）、Task 5 agent 设置段
- Produces: `/audit` 页面（分页表格 + action 过滤输入）；设置页两个新区块

- [ ] **Step 1: ApiTokensSection**

`apps/web/src/pages/settings/ApiTokensSection.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ApiTokenInfo, CreatedApiToken, API_TOKEN_SCOPES } from '@filestation/shared';

export default function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['files:read']);
  const [expiresDays, setExpiresDays] = useState('');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    const res = await api.get<ApiTokenInfo[]>('/api-tokens');
    setTokens(res.data!);
  };
  useEffect(() => { load().catch(() => setError('加载失败')); }, []);

  const toggleScope = (s: string) =>
    setSelectedScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const handleCreate = async () => {
    setError('');
    try {
      const res = await api.post<CreatedApiToken>('/api-tokens', {
        name, scopes: selectedScopes,
        expires_in_days: expiresDays ? parseInt(expiresDays, 10) : undefined,
      });
      setCreated(res.data!);
      setName('');
      await load();
    } catch (err: any) {
      setError(err.message || '创建失败');
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('吊销该 Token？使用它的 Agent 将立即失效。')) return;
    await api.delete(`/api-tokens/${id}`);
    await load();
  };

  return (
    <div className="bg-white shadow rounded-lg p-4 md:p-6 mb-6">
      <h2 className="text-lg font-medium mb-1">API Token</h2>
      <p className="text-sm text-gray-500 mb-4">供脚本 / Agent 调用 API。明文仅在创建时显示一次。</p>

      {created && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded">
          <div className="text-sm text-green-800 mb-1">已创建（请立即复制，关闭后不再显示）：</div>
          <div className="flex gap-2">
            <input readOnly value={created.token} className="flex-1 px-2 py-1 border rounded text-sm font-mono bg-white" onFocus={(e) => e.target.select()} />
            <button onClick={() => { navigator.clipboard.writeText(created.token); }} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">复制</button>
          </div>
          <button onClick={() => setCreated(null)} className="text-xs text-gray-500 mt-2">我已保存，关闭</button>
        </div>
      )}

      <div className="space-y-3 mb-4">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token 名称（如 claude-desktop）"
          className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
        <div className="flex flex-wrap gap-3 text-sm">
          {API_TOKEN_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="checkbox" checked={selectedScopes.includes(s)} onChange={() => toggleScope(s)} />
              <span className="font-mono">{s}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <input value={expiresDays} onChange={(e) => setExpiresDays(e.target.value)} type="number" min={1} max={365}
            placeholder="有效期（天，留空永久）" className="px-3 py-2 border border-gray-300 rounded-md text-sm w-48" />
          <button onClick={handleCreate} disabled={!name.trim() || selectedScopes.length === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50">
            签发 Token
          </button>
        </div>
        {error && <div className="text-red-600 text-sm">{error}</div>}
      </div>

      <ul className="divide-y divide-gray-100 text-sm">
        {tokens.map((t) => (
          <li key={t.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{t.name}</span>
            <span className="font-mono text-gray-400">{t.token_prefix}…</span>
            <span className="text-gray-500 text-xs">{t.scopes.join(', ')}</span>
            <span className="text-gray-400 text-xs">{t.expires_at ? `${new Date(t.expires_at).toLocaleDateString()} 到期` : '永久'}</span>
            {t.revoked_at ? (
              <span className="text-gray-400 text-xs">已吊销</span>
            ) : (
              <button onClick={() => handleRevoke(t.id)} className="text-red-600 text-xs ml-auto">吊销</button>
            )}
          </li>
        ))}
        {tokens.length === 0 && <li className="py-2 text-gray-400">暂无 Token</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: AgentSection**

`apps/web/src/pages/settings/AgentSection.tsx`：

```tsx
import { useState } from 'react';
import { api } from '../../lib/api';

interface AgentSettings { mcp_enabled: boolean; mcp_max_upload_mb: number; }

export default function AgentSection({ agent, onSaved }: { agent: AgentSettings; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(agent.mcp_enabled);
  const [maxMb, setMaxMb] = useState(String(agent.mcp_max_upload_mb));
  const [saving, setSaving] = useState(false);
  const mcpUrl = `${window.location.origin}/api/v1/mcp`;

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/settings', { agent: { mcp_enabled: enabled, mcp_max_upload_mb: parseInt(maxMb, 10) || 32 } });
      onSaved();
      alert('已保存');
    } catch (err: any) {
      alert('保存失败: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white shadow rounded-lg p-4 md:p-6 mb-6">
      <h2 className="text-lg font-medium mb-1">Agent 接入（MCP）</h2>
      <p className="text-sm text-gray-500 mb-4">
        开启后，Agent 客户端（Claude Desktop / Claude Code）可通过 MCP 协议操作本站。鉴权使用上方签发的 API Token。
      </p>

      <label className="flex items-center gap-2 text-sm mb-3">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用 MCP 端点
      </label>

      <div className="text-sm mb-3">
        <label className="block text-gray-700 mb-1">MCP 单文件大小上限（MB）</label>
        <input type="number" min={1} max={512} value={maxMb} onChange={(e) => setMaxMb(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md w-32" />
      </div>

      <div className="text-sm mb-4">
        <label className="block text-gray-700 mb-1">MCP 端点地址</label>
        <code className="block px-3 py-2 bg-gray-50 border rounded text-xs break-all">{mcpUrl}</code>
        <p className="text-xs text-gray-400 mt-1">
          客户端配置示例：URL 填上面地址，HTTP Header 加 Authorization: Bearer fs_api_...
        </p>
      </div>

      <button onClick={handleSave} disabled={saving}
        className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50">
        {saving ? '保存中...' : '保存'}
      </button>
    </div>
  );
}
```

`SettingsPage.tsx`：`Settings` interface 加 `agent: { mcp_enabled: boolean; mcp_max_upload_mb: number }`；渲染 `<ApiTokensSection />` 与 `<AgentSection agent={settings.agent} onSaved={loadSettings} />`（放在安全设置之后）。

- [ ] **Step 3: AuditPage**

`apps/web/src/pages/AuditPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import AppLayout from '../components/AppLayout';
import { AuditLogEntry, PaginatedResponse } from '@filestation/shared';

export default function AuditPage() {
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');

  const load = useCallback(async () => {
    const q = actionFilter ? `&action=${encodeURIComponent(actionFilter)}` : '';
    const res = await api.get<PaginatedResponse<AuditLogEntry>>(`/audit-logs?page=${page}&page_size=20${q}`);
    setItems(res.data!.items);
    setTotal(res.data!.total);
  }, [page, actionFilter]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  return (
    <AppLayout>
      <main className="flex-1 p-4 md:p-6 max-w-6xl mx-auto w-full">
        <h1 className="text-xl font-bold mb-4">审计日志</h1>
        <div className="mb-4 flex gap-2">
          <input value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
            placeholder="按操作过滤，如 mcp.tool_called"
            className="px-3 py-2 border border-gray-300 rounded-md text-sm w-full md:w-72" />
        </div>
        <div className="bg-white shadow rounded-lg overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">时间</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">操作</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">资源</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">IP</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">详情</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-500">{new Date(log.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2 font-mono text-xs">{log.action}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{log.resource_id ?? '-'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{log.ip_address ?? '-'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 max-w-[240px] truncate" title={log.details ? JSON.stringify(log.details) : ''}>
                    {log.details ? JSON.stringify(log.details) : '-'}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">暂无记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex justify-between items-center text-sm text-gray-500">
          <span>共 {total} 条</span>
          <div className="space-x-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40">上一页</button>
            <button disabled={page * 20 >= total} onClick={() => setPage(page + 1)} className="disabled:opacity-40">下一页</button>
          </div>
        </div>
      </main>
    </AppLayout>
  );
}
```

`App.tsx` 加路由（ProtectedRoute 包裹）；`AppLayout.tsx` navItems 加 `{ to: '/audit', label: '审计' }`（插到 文件 与 设置 之间）。

- [ ] **Step 4: 实测验收**

- 设置页签发 Token → 明文仅出现一次，刷新列表不显示明文
- 开启 MCP 开关 → PUT 成功；`/audit` 可见 `settings.updated` 记录
- 吊销 Token → 列表显示"已吊销"

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 设置页 API Token 管理 + MCP 开关区块 + 审计日志页与导航入口

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: TOTP 后端（setup/confirm/disable + login_challenge 登录流程）

**Files:**
- Modify: `apps/server/package.json`（deps: `otplib`、`qrcode`；dev: `@types/qrcode`）
- Create: `apps/server/src/common/crypto/totp-secret-cipher.ts`
- Create: `apps/server/src/auth/totp.service.ts`
- Create: `apps/server/src/auth/dto/totp.dto.ts`
- Modify: `apps/server/src/auth/auth.service.ts`（login 两步化 + verifyTotpLogin）
- Modify: `apps/server/src/auth/auth.controller.ts`（login 响应联合 + 3 个 totp 端点 + login/totp）
- Modify: `apps/server/src/auth/auth.module.ts`（providers + forFeature 加 Authenticator）
- Modify: `apps/server/src/settings/dto/update-settings.dto.ts`（totp_required 解禁）
- Modify: `apps/server/src/settings/settings.service.ts`（写 totp_required=true 前校验已有激活 TOTP）
- Modify: `apps/server/src/settings/settings.module.ts`（forFeature 加 Authenticator）
- Test: `apps/server/src/auth/totp.service.spec.ts`、`apps/server/src/auth/auth.service.spec.ts`（更新 login 用例）

**Interfaces:**
- Produces:
  - `TotpService.setup(accountId): Promise<{ secret: string; otpauth_url: string; qr_code_data_url: string }>`（已激活则 409）
  - `TotpService.confirm(accountId, code): Promise<void>`（验证通过 → is_active=1）
  - `TotpService.disable(accountId, password, code): Promise<void>`
  - `TotpService.hasActiveTotp(accountId): Promise<boolean>`
  - `TotpService.verifyCode(accountId, code): Promise<boolean>`（recovery 生成时复用）
  - `AuthService.login` 返回类型改 `LoginOutcome = { kind: 'tokens'; tokens: TokenPair } | { kind: 'second_factor'; loginChallenge: string; availableMethods: string[] }`
  - `AuthService.verifyTotpLogin(loginChallenge: string, code: string, clientIp?: string): Promise<TokenPair & { username: string }>`
  - 端点：`POST /auth/totp/setup`、`POST /auth/totp/confirm`、`POST /auth/totp/disable`（均 JwtAuthGuard + AdminOnlyGuard）；`POST /auth/login/totp`（公开）

- [ ] **Step 1: 装依赖**

```bash
npm install otplib qrcode --workspace=@filestation/server && npm install -D @types/qrcode --workspace=@filestation/server
```

- [ ] **Step 2: 写失败测试**（`totp.service.spec.ts`，覆盖：setup 生成加密 secret 且原文不落库、confirm 错误码拒绝/正确码激活、重复 setup 409、disable 需密码+码双验）

关键断言示例：

```typescript
it('setup 后数据库不存明文 secret', async () => {
  const { secret } = await service.setup('acc1');
  const saved = await repo.findOneBy({ accountId: 'acc1' });
  expect(saved.totpSecretEncrypted).not.toContain(secret);
  expect(saved.totpSecretEncrypted).toMatch(/^v1\./);
  expect(saved.isActive).toBe(0);
});

it('confirm：正确 TOTP 码激活', async () => {
  const { secret } = await service.setup('acc1');
  const code = authenticator.generate(secret); // otplib 直出当前码
  await service.confirm('acc1', code);
  expect((await repo.findOneBy({ accountId: 'acc1' })).isActive).toBe(1);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm run test --workspace=@filestation/server -- totp.service`
Expected: FAIL

- [ ] **Step 4: 实现加解密助手**

`apps/server/src/common/crypto/totp-secret-cipher.ts`：

```typescript
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';

/** key = SHA-256(JWT_SECRET)：复用既有部署秘密，不引入新环境变量 */
function deriveKey(jwtSecret: string): Buffer {
  return createHash('sha256').update(jwtSecret).digest();
}

export function encryptSecret(plain: string, jwtSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(jwtSecret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

export function decryptSecret(payload: string, jwtSecret: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(jwtSecret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 5: TotpService**

`apps/server/src/auth/totp.service.ts`：

```typescript
import { Injectable, ConflictException, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { Authenticator } from './entities/authenticator.entity';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { encryptSecret, decryptSecret } from '../common/crypto/totp-secret-cipher';

@Injectable()
export class TotpService {
  constructor(
    @InjectRepository(Authenticator)
    private authenticatorsRepository: Repository<Authenticator>,
    private accountsService: AccountsService,
    private configService: ConfigService,
    private auditService: AuditService,
  ) {
    authenticator.options = { window: 1 }; // 容忍 ±30s 时钟偏移
  }

  private jwtSecret(): string {
    const s = this.configService.get<string>('app.jwtSecret');
    if (!s) throw new Error('JWT_SECRET not configured');
    return s;
  }

  async hasActiveTotp(accountId: string): Promise<boolean> {
    return !!(await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 1 },
    }));
  }

  async setup(accountId: string): Promise<{ secret: string; otpauth_url: string; qr_code_data_url: string }> {
    if (await this.hasActiveTotp(accountId)) {
      throw new ConflictException({ code: 'TOTP_ALREADY_ENABLED', message: 'TOTP is already enabled; disable it first' });
    }
    // 清掉历史未激活的半成品
    await this.authenticatorsRepository.delete({ accountId, type: 'totp', isActive: 0 });

    const account = await this.accountsService.findById(accountId);
    if (!account) throw new NotFoundException('Account not found');

    const secret = authenticator.generateSecret();
    await this.authenticatorsRepository.save({
      id: uuidv4(), accountId, type: 'totp', name: 'TOTP',
      totpSecretEncrypted: encryptSecret(secret, this.jwtSecret()),
      credentialId: null, publicKey: null, signCount: 0, transports: null,
      createdAt: Date.now(), lastUsedAt: null, isActive: 0,
    });

    const otpauthUrl = authenticator.keyuri(account.username, 'FileStation', secret);
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
    return { secret, otpauth_url: otpauthUrl, qr_code_data_url: qrDataUrl };
  }

  async confirm(accountId: string, code: string): Promise<void> {
    const pending = await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 0 },
    });
    if (!pending) throw new NotFoundException({ code: 'NO_PENDING_SETUP', message: 'No pending TOTP setup' });
    const secret = decryptSecret(pending.totpSecretEncrypted!, this.jwtSecret());
    if (!authenticator.check(code, secret)) {
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Invalid TOTP code' });
    }
    await this.authenticatorsRepository.update({ id: pending.id }, { isActive: 1, lastUsedAt: Date.now() });
    await this.auditService.record({ accountId, action: 'auth.totp_enabled' });
  }

  async disable(accountId: string, password: string, code: string): Promise<void> {
    const account = await this.accountsService.findById(accountId);
    if (!account || !(await this.accountsService.validatePassword(account, password))) {
      throw new UnauthorizedException('Invalid password');
    }
    if (!(await this.verifyCode(accountId, code))) {
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Invalid TOTP code' });
    }
    await this.authenticatorsRepository.delete({ accountId, type: 'totp' });
    await this.auditService.record({ accountId, action: 'auth.totp_disabled' });
  }

  async verifyCode(accountId: string, code: string): Promise<boolean> {
    const row = await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 1 },
    });
    if (!row) return false;
    const secret = decryptSecret(row.totpSecretEncrypted!, this.jwtSecret());
    const ok = authenticator.check(code, secret);
    if (ok) {
      await this.authenticatorsRepository.update({ id: row.id }, { lastUsedAt: Date.now() });
    }
    return ok;
  }
}
```

`apps/server/src/auth/dto/totp.dto.ts`：

```typescript
import { IsString, Length, Matches } from 'class-validator';

export class TotpCodeDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'TOTP code must be 6 digits' })
  code!: string;
}

export class TotpDisableDto {
  @IsString() @Length(1, 128)
  password!: string;

  @IsString() @Matches(/^\d{6}$/)
  code!: string;
}

export class TotpLoginDto {
  @IsString() @Length(1, 128)
  login_challenge!: string;

  @IsString() @Matches(/^\d{6}$/)
  totp_code!: string;
}
```

- [ ] **Step 6: login 两步化**

`auth.service.ts`：

```typescript
export type LoginOutcome =
  | { kind: 'tokens'; tokens: TokenPair }
  | { kind: 'second_factor'; loginChallenge: string; availableMethods: string[] };
```

`login()` 末尾（`clearLoginFailures/clearIpFailures` 之后、`generateTokens` 之前）插入：

```typescript
    // 两步：已激活 TOTP → 发 login_challenge，不发 token
    if (await this.totpService.hasActiveTotp(account.id)) {
      const challengeId = `ch_${uuidv4()}`;
      await this.challengesRepository.save({
        id: challengeId, accountId: account.id, challengeType: 'totp',
        challengeData: null, createdAt: now, expiresAt: now + 5 * 60 * 1000, usedAt: null,
      });
      return { kind: 'second_factor', loginChallenge: challengeId, availableMethods: ['totp'] };
    }

    return { kind: 'tokens', tokens: await this.generateTokens(account.id, account.username) };
```

（返回值类型同步改为 `Promise<LoginOutcome>`；构造函数注入 `TotpService`。）

新增：

```typescript
  async verifyTotpLogin(loginChallenge: string, code: string, clientIp?: string): Promise<TokenPair & { username: string }> {
    const now = Date.now();
    // 入口先查 IP 维度节流（与 login() 同一防线——challenge 换码不能成为绕过 IP 限流的旁路）
    if (clientIp) await this.checkIpThrottle(clientIp, now);

    // 单次使用 + 未过期：条件 UPDATE 抢占
    const claimed = await this.challengesRepository.update(
      { id: loginChallenge, usedAt: IsNull() },
      { usedAt: now },
    );
    // IsNull 来自 typeorm；affected=0 → 不存在或已使用
    if (claimed.affected === 0) {
      throw new UnauthorizedException({ code: 'INVALID_CHALLENGE', message: 'Challenge is invalid or already used' });
    }
    const challenge = await this.challengesRepository.findOne({ where: { id: loginChallenge } });
    if (!challenge || challenge.expiresAt <= now || challenge.challengeType !== 'totp') {
      throw new UnauthorizedException({ code: 'CHALLENGE_EXPIRED', message: 'Challenge has expired' });
    }

    const ok = await this.totpService.verifyCode(challenge.accountId, code);
    if (!ok) {
      // TOTP 失败计入账户锁定维度（与密码失败同一计数器）+ IP 维度
      const account = await this.accountsService.findById(challenge.accountId);
      if (account) {
        const security = await this.settingsService.getSecuritySettings();
        await this.recordLoginFailure(account.username, security.max_login_attempts, security.lockout_minutes, now);
        await this.auditService.record({ accountId: challenge.accountId, action: 'auth.totp_failed', ip: clientIp });
      }
      if (clientIp) await this.recordIpFailure(clientIp, now);
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Invalid TOTP code; please log in again' });
    }

    const account = await this.accountsService.findById(challenge.accountId);
    if (!account) throw new UnauthorizedException('Account not found');
    // 二步通过 = 登录成功：清账户锁定计数 + IP 失败计数（与 login() 密码成功路径对称）
    await this.clearLoginFailures(account.username);
    if (clientIp) await this.clearIpFailures(clientIp);
    const tokens = await this.generateTokens(account.id, account.username);
    await this.auditService.record({ accountId: account.id, action: 'auth.login', details: { second_factor: 'totp' }, ip: clientIp });
    return { ...tokens, username: account.username };
  }
```

（import 顶部补 `import { IsNull } from 'typeorm';`）

- [ ] **Step 7: Controller**

`auth.controller.ts` 的 `login()` 响应处理改为：

```typescript
    const outcome = await this.authService.login(loginDto, req.ip);

    if (outcome.kind === 'second_factor') {
      // 不设置 refresh cookie——二步未完成不算登录
      return {
        code: 'OK', message: 'Second factor required',
        data: {
          requires_second_factor: true,
          login_challenge: outcome.loginChallenge,
          available_methods: outcome.availableMethods,
        },
        request_id: crypto.randomUUID(),
      };
    }

    res.cookie(REFRESH_COOKIE, outcome.tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
    return {
      code: 'OK', message: 'Login successful',
      data: { access_token: outcome.tokens.accessToken, expires_in: outcome.tokens.expiresIn },
      request_id: crypto.randomUUID(),
    };
```

（返回类型标注改为 `ApiResponse<LoginResponseData>`，import 自 shared。）

追加端点：

```typescript
  @Post('login/totp')
  @HttpCode(HttpStatus.OK)
  async loginTotp(
    @Body() body: TotpLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<{ access_token: string; expires_in: number; username: string }>> {
    const result = await this.authService.verifyTotpLogin(body.login_challenge, body.totp_code, req.ip);
    res.cookie(REFRESH_COOKIE, result.refreshToken, REFRESH_COOKIE_OPTIONS);
    return {
      code: 'OK', message: 'Login successful',
      data: { access_token: result.accessToken, expires_in: result.expiresIn, username: result.username },
      request_id: crypto.randomUUID(),
    };
  }

  @Post('totp/setup')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async totpSetup(@Req() req: Request) {
    const result = await this.authService.totpSetup((req as any).user.id);
    return { code: 'OK', message: 'TOTP setup created', data: result, request_id: crypto.randomUUID() };
  }

  @Post('totp/confirm')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async totpConfirm(@Req() req: Request, @Body() body: TotpCodeDto): Promise<ApiResponse<null>> {
    await this.authService.totpConfirm((req as any).user.id, body.code);
    return { code: 'OK', message: 'TOTP enabled', data: null, request_id: crypto.randomUUID() };
  }

  @Post('totp/disable')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async totpDisable(@Req() req: Request, @Body() body: TotpDisableDto): Promise<ApiResponse<null>> {
    await this.authService.totpDisable((req as any).user.id, body.password, body.code);
    return { code: 'OK', message: 'TOTP disabled', data: null, request_id: crypto.randomUUID() };
  }
```

`AuthService` 增加三个薄委托（`totpSetup/totpConfirm/totpDisable` → `TotpService`）；`auth.module.ts` providers 加 `TotpService`，forFeature 数组加 `Authenticator`；imports 加 `AuditModule`（Task 4 已建）。

- [ ] **Step 8: totp_required 解禁**

`update-settings.dto.ts` 的 `SecuritySettingsDto.totp_required` 改为：

```typescript
  @IsOptional() @IsBoolean()
  totp_required?: boolean;
```

`settings.service.ts` 的 `set('security', ...)` 路径加守卫（settings.controller.ts 的 security 分支改为调用新方法 `setSecuritySettings`）：

```typescript
  async setSecuritySettings(value: SecuritySettings, updatedBy?: string): Promise<void> {
    if (value.totp_required === true) {
      // 防自锁：至少一个激活的 TOTP 才允许强制
      const active = await this.authenticatorsRepository.count({
        where: { type: 'totp', isActive: 1 },
      });
      if (active === 0) {
        throw new BadRequestException({ code: 'TOTP_NOT_ENABLED', message: 'Enable TOTP for your account before requiring it' });
      }
    }
    // totp_active 是读取时计算的派生字段：getSecuritySettings() 的返回带它，
    // 控制器 `{ ...current, ...writable }` 合并时会被带回来——服务边界统一剥离，防落库
    const { totp_active: _derived, ...toStore } = value;
    await this.set('security', toStore, updatedBy);
  }
```

`settings.module.ts` forFeature 加 `Authenticator`（import 自 `../auth/entities/authenticator.entity`——实体无模块依赖，不引入 AuthModule 防循环）。SettingsService 构造函数注入 `@InjectRepository(Authenticator) private authenticatorsRepository: Repository<Authenticator>`。

**派生只读字段 `totp_active`**（前端设置页需要知道"当前是否已激活 TOTP"，此字段不入库、每次读取时计算）：

`settings.service.ts` 的 `SecuritySettings` interface 追加：

```typescript
export interface SecuritySettings {
  // ...既有字段原样保留...
  totp_required: boolean;
  /** 派生只读：当前是否存在激活的 TOTP（读取时计算，不写库） */
  totp_active?: boolean;
}
```

`getSecuritySettings()` 改为（默认值与现有实现完全一致：`totp_required: false, max_login_attempts: 5, lockout_minutes: 15`）：

```typescript
  async getSecuritySettings(): Promise<SecuritySettings> {
    const stored = await this.get<SecuritySettings>('security', {
      totp_required: false,
      max_login_attempts: 5,
      lockout_minutes: 15,
    });
    const active = await this.authenticatorsRepository.count({ where: { type: 'totp', isActive: 1 } });
    return { ...stored, totp_active: active > 0 };
  }
```

`SecuritySettingsDto` 追加放行字段（前端回读回写整个 security 对象时会带上 totp_active；`forbidNonWhitelisted` 不收它就会 400，所以 DTO 放行、合并时显式丢弃）：

```typescript
  @IsOptional() @IsBoolean()
  totp_active?: boolean; // 派生字段：DTO 放行防 400，合并时丢弃（见下）
```

`settings.controller.ts` 的 security 分支改为显式剥离：

```typescript
    if (body.security) {
      const { totp_active: _derivedIgnored, ...writable } = body.security;
      const current = await this.settingsService.getSecuritySettings();
      await this.settingsService.setSecuritySettings({ ...current, ...omitUndefined(writable) }, userId);
    }
```

（即：原 `set('security', ...)` 调用换成 `setSecuritySettings`，并先做上面的解构剥离。双重保护：控制器剥 body 里的 totp_active；`setSecuritySettings` 在服务边界再剥一次——因为合并用的 `current` 来自 getSecuritySettings，本身携带派生字段。）

- [ ] **Step 9: 测试回归 + 新测试通过**

Run: `npm run test --workspace=@filestation/server`
Expected: PASS（`auth.service.spec.ts` 既有 login 用例需更新：返回值从 TokenPair 变 LoginOutcome，且注入 mock 增 TotpService `{ hasActiveTotp: jest.fn().mockResolvedValue(false) }`）

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/auth apps/server/src/common/crypto apps/server/src/settings apps/server/package.json package-lock.json
git commit -m "feat(server): TOTP 两步登录——AES-GCM 加密存储 + login_challenge 单次挑战 + setup/confirm/disable + totp_required 解禁

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: TOTP 前端（登录两步 + 设置页管理）

**Files:**
- Modify: `apps/web/src/pages/LoginPage.tsx`（两步流程）
- Create: `apps/web/src/pages/settings/TotpSection.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx`（挂 TotpSection + totp_required 开关）

**Interfaces:**
- Consumes: Task 8 端点；shared `LoginResponseData`
- Produces: LoginPage 在 `requires_second_factor` 时切换为 TOTP 输入步；TotpSection 提供 启用（QR + 手输 secret + 验证码确认）/ 停用（密码+验证码）

- [ ] **Step 1: LoginPage 两步**

核心改动（保留既有样式风格）：

```tsx
const [secondFactor, setSecondFactor] = useState<{ challenge: string } | null>(null);
const [totpCode, setTotpCode] = useState('');

const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setError('');
  setLoading(true);
  try {
    const response = await api.post<LoginResponseData>('/auth/login', { username, password });
    const data = response.data!;
    if ('requires_second_factor' in data) {
      setSecondFactor({ challenge: data.login_challenge });
      return; // 进入 TOTP 步
    }
    login(data.access_token, username);
    navigate('/');
  } catch (err: any) {
    setError(err.message || '登录失败');
  } finally {
    setLoading(false);
  }
};

const handleTotpSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setError('');
  setLoading(true);
  try {
    const response = await api.post<{ access_token: string; expires_in: number; username: string }>(
      '/auth/login/totp', { login_challenge: secondFactor!.challenge, totp_code: totpCode },
    );
    login(response.data!.access_token, response.data!.username);
    navigate('/');
  } catch (err: any) {
    setError(err.message || '验证失败');
    setSecondFactor(null); // challenge 单次使用，失败回账号密码步
    setPassword('');
  } finally {
    setLoading(false);
  }
};
```

渲染：`secondFactor` 非 null 时渲染 TOTP 表单（6 位数字输入 `inputMode="numeric" autoComplete="one-time-code" autoFocus` + "验证并登录"按钮 + "返回"链接重置 state），否则渲染原表单。

- [ ] **Step 2: TotpSection**

`apps/web/src/pages/settings/TotpSection.tsx`：

```tsx
import { useState } from 'react';
import { api } from '../../lib/api';

interface SetupData { secret: string; otpauth_url: string; qr_code_data_url: string; }

export default function TotpSection({ totpActive, onChanged }: { totpActive: boolean; onChanged: () => void }) {
  const [setup, setSetup] = useState<SetupData | null>(null);
  const [code, setCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const startSetup = async () => {
    setError('');
    try {
      const res = await api.post<SetupData>('/auth/totp/setup', {});
      setSetup(res.data!);
    } catch (err: any) { setError(err.message || '初始化失败'); }
  };

  const confirm = async () => {
    setError('');
    try {
      await api.post('/auth/totp/confirm', { code });
      setSetup(null); setCode('');
      onChanged();
      alert('TOTP 已启用，下次登录需要验证器验证码');
    } catch (err: any) { setError(err.message || '验证码错误'); }
  };

  const disable = async () => {
    setError('');
    try {
      await api.post('/auth/totp/disable', { password, code });
      setDisableOpen(false); setPassword(''); setCode('');
      onChanged();
    } catch (err: any) { setError(err.message || '停用失败'); }
  };

  return (
    <div className="bg-white shadow rounded-lg p-4 md:p-6 mb-6">
      <h2 className="text-lg font-medium mb-1">两步验证（TOTP）</h2>
      <p className="text-sm text-gray-500 mb-4">使用验证器 App（如 Microsoft Authenticator、1Password）扫码。</p>
      {error && <div className="text-red-600 text-sm mb-3">{error}</div>}

      {!totpActive && !setup && (
        <button onClick={startSetup} className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm">启用 TOTP</button>
      )}

      {setup && (
        <div className="space-y-3">
          <img src={setup.qr_code_data_url} alt="TOTP QR" className="w-48 h-48 border rounded" />
          <div className="text-sm">
            <span className="text-gray-500">无法扫码？手输密钥：</span>
            <code className="font-mono text-xs break-all">{setup.secret}</code>
          </div>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入 6 位验证码确认"
              inputMode="numeric" autoComplete="one-time-code"
              className="px-3 py-2 border border-gray-300 rounded-md text-sm w-44" />
            <button onClick={confirm} disabled={!/^\d{6}$/.test(code)}
              className="px-4 py-2 bg-green-600 text-white rounded-md text-sm disabled:opacity-50">确认启用</button>
            <button onClick={() => { setSetup(null); setCode(''); }} className="px-4 py-2 border rounded-md text-sm">取消</button>
          </div>
        </div>
      )}

      {totpActive && !disableOpen && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-green-700">已启用</span>
          <button onClick={() => setDisableOpen(true)} className="text-sm text-red-600">停用…</button>
        </div>
      )}

      {totpActive && disableOpen && (
        <div className="space-y-2">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="当前密码"
            className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="当前 6 位验证码"
            inputMode="numeric" className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <div className="flex gap-2">
            <button onClick={disable} className="px-4 py-2 bg-red-600 text-white rounded-md text-sm">确认停用</button>
            <button onClick={() => setDisableOpen(false)} className="px-4 py-2 border rounded-md text-sm">取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

`SettingsPage.tsx`：`Settings.security` 的 `totp_required` 现在可写——安全设置卡加 checkbox；TOTP 激活状态直接读 `settings.security.totp_active`（Task 8 产出的派生只读字段，GET /settings 自带）。

挂接：

```tsx
<TotpSection totpActive={settings.security.totp_active ?? false} onChanged={loadSettings} />
```

- [ ] **Step 3: 实测验收（移动端 + 桌面各一遍）**

- 启用 TOTP → 退出登录 → 登录弹两步 → 错误码提示并回第一步 → 正确码登录成功
- 停用后登录恢复单步
- `security.totp_required` checkbox 在无激活 TOTP 时保存 → 400 提示；激活后可开

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): TOTP 两步登录流程 + 设置页 TOTP 管理（QR 启用 / 密码+码停用）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: 恢复码后端（generate/verify + 吊销全部会话）

**Files:**
- Modify: `apps/server/package.json`（deps: `argon2`）
- Create: `apps/server/src/auth/recovery.service.ts`
- Create: `apps/server/src/auth/dto/recovery.dto.ts`
- Modify: `apps/server/src/auth/auth.controller.ts`（2 个端点）
- Modify: `apps/server/src/auth/auth.module.ts`（providers + forFeature 加 RecoveryCode）
- Test: `apps/server/src/auth/recovery.service.spec.ts`

**Interfaces:**
- Consumes: Task 8 `TotpService.hasActiveTotp/verifyCode`
- Produces:
  - `RecoveryService.generate(accountId, password, totpCode?): Promise<string[]>`（返回明文码数组，仅此一次；旧未用码作废；24h 有效期）
  - `RecoveryService.verify(username, code, clientIp?): Promise<{ accountId: string }>`（验码 + 账户维度锁定 + 用后吊销全部会话；**不发 token**）
  - `AuthService.recoveryVerify(username, code, clientIp?): Promise<TokenPair & { username: string }>`（IP 节流入口 → RecoveryService.verify → 清 IP 计数 → generateTokens；失败记 IP 计数）
  - 端点：`POST /auth/recovery/generate`（JwtAuthGuard + AdminOnlyGuard）；`POST /auth/recovery/verify`（公开，IP 限速在 AuthService.recoveryVerify 入口 + 账户维度失败计数 5 次锁 15 分钟在 RecoveryService）
  - 码格式：Crockford Base32，10 字符，展示型 `XXXX-XXXX-XX`；验证时归一（去连字符/空格、转大写）

- [ ] **Step 1: 装依赖**

```bash
npm install argon2 --workspace=@filestation/server
```

（Windows 下 argon2 走预编译二进制；若 install 失败需先装 VS Build Tools——失败时把报错贴出来再处理，不要静默降级到 bcrypt：设计文档 §6.1 明确要求 Argon2id。）

- [ ] **Step 2: 写失败测试**（`recovery.service.spec.ts`）

```typescript
// 覆盖：
// 1. generate 返回 10 个码，格式 XXXX-XXXX-XX（正则 /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/）；库中存 argon2id 哈希（$argon2id$ 开头），expires_at = now+24h
// 2. 再次 generate 后旧码 verify 失败（旧未用码已删除）
// 3. verify 成功：码标记 used_at，账户全部会话 revoked_at 非空，返回 { accountId }
// 4. 同一码二次 verify 失败（一次性）
// 5. 连续 5 次错误码 → 第 6 次即使码正确也 401（账户维度锁定，码尝试计入独立计数器 recovery_fail_<username>）
// 6. 已启用 TOTP 的账户 generate 必须带正确 totp_code
// 7. （auth.service.spec.ts）recoveryVerify 的 IP 防线：入口 checkIpThrottle 抛出则直接失败；verify 抛 401 时 recordIpFailure 被调；成功时 clearIpFailures 被调
```

- [ ] **Step 3: 运行确认失败 → 实现**

`apps/server/src/auth/recovery.service.ts`：

```typescript
import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, MoreThan } from 'typeorm';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { RecoveryCode } from './entities/recovery-code.entity';
import { Session } from './entities/session.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { AccountsService } from '../accounts/accounts.service';
import { TotpService } from './totp.service';
import { AuditService } from '../audit/audit.service';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_TTL_MS = 24 * 60 * 60 * 1000; // 设计 v2.2 §6.1：24 小时有效
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

@Injectable()
export class RecoveryService {
  constructor(
    @InjectRepository(RecoveryCode)
    private codesRepository: Repository<RecoveryCode>,
    @InjectRepository(Session)
    private sessionsRepository: Repository<Session>,
    @InjectRepository(SystemMeta)
    private systemMetaRepository: Repository<SystemMeta>,
    private accountsService: AccountsService,
    private totpService: TotpService,
    private auditService: AuditService,
  ) {}

  async generate(accountId: string, password: string, totpCode?: string): Promise<string[]> {
    const account = await this.accountsService.findById(accountId);
    if (!account || !(await this.accountsService.validatePassword(account, password))) {
      throw new UnauthorizedException('Invalid password');
    }
    if (await this.totpService.hasActiveTotp(accountId)) {
      if (!totpCode || !(await this.totpService.verifyCode(accountId, totpCode))) {
        throw new UnauthorizedException({ code: 'TOTP_REQUIRED', message: 'Valid TOTP code is required' });
      }
    }

    // 旧未用码全部作废（一次只有一组有效）
    await this.codesRepository.delete({ accountId, usedAt: IsNull() });

    const now = Date.now();
    const plaintexts: string[] = [];
    const rows: Partial<RecoveryCode>[] = [];
    for (let i = 0; i < 10; i++) {
      const code = this.generateCode();
      plaintexts.push(code);
      rows.push({
        id: uuidv4(), accountId,
        codeHash: await argon2.hash(this.normalize(code), ARGON2_OPTS), // 哈希在事务外（无事务）
        usedAt: null, createdAt: now, expiresAt: now + CODE_TTL_MS,
      });
    }
    await this.codesRepository.save(rows);
    await this.auditService.record({ accountId, action: 'recovery.generated' });
    return plaintexts;
  }

  async verify(username: string, code: string, clientIp?: string): Promise<{ accountId: string }> {
    const now = Date.now();
    await this.checkRecoveryLock(username, now);

    const account = await this.accountsService.findByUsername(username);
    // 账户不存在也走一遍 dummy verify，防账户枚举（时间侧信道）
    const candidates = account
      ? await this.codesRepository.find({ where: { accountId: account.id, usedAt: IsNull(), expiresAt: MoreThan(now) } })
      : [];
    const normalized = this.normalize(code);
    let matched: RecoveryCode | null = null;
    for (const row of candidates) {
      if (await argon2.verify(row.codeHash, normalized)) { matched = row; break; }
    }
    if (!matched && candidates.length === 0) {
      await argon2.verify('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', normalized).catch(() => false);
    }

    if (!account || !matched) {
      await this.recordRecoveryFailure(username, now);
      throw new UnauthorizedException({ code: 'INVALID_RECOVERY_CODE', message: 'Invalid or expired recovery code' });
    }

    // 原子标记使用（防并发复用同一码）
    const claim = await this.codesRepository.update(
      { id: matched.id, usedAt: IsNull() },
      { usedAt: now },
    );
    if (claim.affected === 0) {
      throw new UnauthorizedException({ code: 'INVALID_RECOVERY_CODE', message: 'Recovery code already used' });
    }

    // 设计 v2.2 §6.2：使用恢复码即吊销全部会话（疑似凭据丢失场景）
    await this.sessionsRepository.update(
      { accountId: account.id, revokedAt: IsNull() },
      { revokedAt: now },
    );
    await this.systemMetaRepository.delete({ key: `recovery_fail_${username}` });
    await this.auditService.record({ accountId: account.id, action: 'recovery.used', ip: clientIp });
    return { accountId: account.id };
  }

  /** 展示格式 XXXX-XXXX-XX（10 字符 Crockford Base32 = 50 bit；256 % 32 = 0，取模无偏） */
  private generateCode(): string {
    const bytes = randomBytes(10); // 10 字节 → 恰 10 字符；7 字节只有 35 bit 且第三段会为空（v1.0 草稿在此出错）
    let raw = '';
    for (const b of bytes) raw += CROCKFORD[b % 32];
    return `${raw.substring(0, 4)}-${raw.substring(4, 8)}-${raw.substring(8, 10)}`;
  }

  private normalize(code: string): string {
    return code.replace(/[-\s]/g, '').toUpperCase();
  }

  private async checkRecoveryLock(username: string, now: number): Promise<void> {
    const meta = await this.systemMetaRepository.findOne({ where: { key: `recovery_fail_${username}` } });
    if (!meta) return;
    try {
      const state = JSON.parse(meta.value);
      if (state.locked_until && state.locked_until > now) {
        throw new UnauthorizedException({ code: 'RECOVERY_LOCKED', message: 'Too many failed attempts, retry later' });
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
    }
  }

  private async recordRecoveryFailure(username: string, now: number): Promise<void> {
    const key = `recovery_fail_${username}`;
    const meta = await this.systemMetaRepository.findOne({ where: { key } });
    let state = { failed_count: 0, locked_until: null as number | null };
    if (meta) { try { state = JSON.parse(meta.value); } catch {} }
    state.failed_count += 1;
    if (state.failed_count >= 5) {
      state.locked_until = now + 15 * 60 * 1000;
      state.failed_count = 0;
    }
    await this.systemMetaRepository.save({ key, value: JSON.stringify(state) });
  }
}
```

`apps/server/src/auth/dto/recovery.dto.ts`：

```typescript
import { IsString, Length, IsOptional, Matches } from 'class-validator';

export class RecoveryGenerateDto {
  @IsString() @Length(1, 128)
  password!: string;

  @IsOptional() @Matches(/^\d{6}$/)
  totp_code?: string;
}

export class RecoveryVerifyDto {
  @IsString() @Length(1, 64)
  username!: string;

  @IsString() @Length(1, 32)
  code!: string;
}
```

- [ ] **Step 4: Controller + Module**

`auth.controller.ts` 追加：

```typescript
  @Post('recovery/generate')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async recoveryGenerate(@Req() req: Request, @Body() body: RecoveryGenerateDto) {
    const codes = await this.authService.recoveryGenerate((req as any).user.id, body.password, body.totp_code);
    return { code: 'OK', message: 'Recovery codes generated (shown once)', data: { codes }, request_id: crypto.randomUUID() };
  }

  @Post('recovery/verify')
  @HttpCode(HttpStatus.OK)
  async recoveryVerify(
    @Body() body: RecoveryVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<{ access_token: string; expires_in: number; username: string }>> {
    const result = await this.authService.recoveryVerify(body.username, body.code, req.ip);
    res.cookie(REFRESH_COOKIE, result.refreshToken, REFRESH_COOKIE_OPTIONS);
    return {
      code: 'OK', message: 'Recovery successful',
      data: { access_token: result.accessToken, expires_in: result.expiresIn, username: result.username },
      request_id: crypto.randomUUID(),
    };
  }
```

`AuthService` 追加——`recoveryGenerate` 是纯委托；`recoveryVerify` **不是薄委托**，IP 节流防线在此统一把关（RecoveryService 不管 IP，与 login() 的防线分层一致）：

```typescript
  async recoveryGenerate(accountId: string, password: string, totpCode?: string): Promise<string[]> {
    return this.recoveryService.generate(accountId, password, totpCode);
  }

  /** 恢复码登录：入口 IP 节流 → 验码（RecoveryService 管账户维度）→ 清 IP 计数 → 发新 token */
  async recoveryVerify(username: string, code: string, clientIp?: string): Promise<TokenPair & { username: string }> {
    const now = Date.now();
    if (clientIp) await this.checkIpThrottle(clientIp, now);
    try {
      const { accountId } = await this.recoveryService.verify(username, code, clientIp);
      if (clientIp) await this.clearIpFailures(clientIp);
      const account = await this.accountsService.findById(accountId);
      if (!account) throw new UnauthorizedException('Account not found');
      const tokens = await this.generateTokens(account.id, account.username);
      return { ...tokens, username: account.username };
    } catch (e) {
      if (clientIp && e instanceof UnauthorizedException) await this.recordIpFailure(clientIp, now);
      throw e;
    }
  }
```

（AuthService 构造函数注入 `RecoveryService`。）`auth.module.ts`：providers 加 `RecoveryService`，forFeature 加 `RecoveryCode`。

**注意**：`RecoveryService` 构造需要 `Session`/`SystemMeta` 仓库——auth.module 的 forFeature 已含二者，直接可注入。

- [ ] **Step 5: 测试通过 + 回归**

Run: `npm run test --workspace=@filestation/server`
Expected: PASS（argon2 哈希较慢，相关 spec 加 `jest.setTimeout(30000)`）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth apps/server/package.json package-lock.json
git commit -m "feat(server): 恢复码——Argon2id 哈希 + 一次性 + 24h 有效 + 用后吊销全部会话 + 失败锁定

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: 恢复码前端（生成/展示 + 登录页恢复入口）

**Files:**
- Create: `apps/web/src/pages/settings/RecoverySection.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx`（挂 RecoverySection）
- Modify: `apps/web/src/pages/LoginPage.tsx`（"使用恢复码"入口）

**Interfaces:**
- Consumes: Task 10 端点
- Produces: RecoverySection（密码[+TOTP]确认 → 生成 10 码一次性展示 + 复制/下载）；LoginPage 恢复码表单（用户名 + 码 → 登录）

- [ ] **Step 1: RecoverySection**

```tsx
// apps/web/src/pages/settings/RecoverySection.tsx
import { useState } from 'react';
import { api } from '../../lib/api';

export default function RecoverySection({ totpActive }: { totpActive: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  const generate = async () => {
    setError('');
    try {
      const res = await api.post<{ codes: string[] }>('/auth/recovery/generate', {
        password, totp_code: totpCode || undefined,
      });
      setCodes(res.data!.codes);
      setOpen(false); setPassword(''); setTotpCode('');
    } catch (err: any) { setError(err.message || '生成失败'); }
  };

  return (
    <div className="bg-white shadow rounded-lg p-4 md:p-6 mb-6">
      <h2 className="text-lg font-medium mb-1">恢复码</h2>
      <p className="text-sm text-gray-500 mb-4">
        验证器丢失时的应急登录码（10 个，一次性，生成后 24 小时内有效）。验证成功后所有已登录会话将被强制下线。
      </p>
      {error && <div className="text-red-600 text-sm mb-3">{error}</div>}

      {!open && !codes && (
        <button onClick={() => setOpen(true)} className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm">生成新一组</button>
      )}

      {open && (
        <div className="space-y-2">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="当前密码"
            className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          {totpActive && (
            <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="当前 6 位 TOTP 验证码"
              inputMode="numeric" className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          )}
          <div className="flex gap-2">
            <button onClick={generate} className="px-4 py-2 bg-green-600 text-white rounded-md text-sm">确认生成</button>
            <button onClick={() => setOpen(false)} className="px-4 py-2 border rounded-md text-sm">取消</button>
          </div>
          <p className="text-xs text-gray-400">生成后旧的一组立即作废。</p>
        </div>
      )}

      {codes && (
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
            请立即保存——关闭后不再显示。
          </div>
          <div className="grid grid-cols-2 gap-1 font-mono text-sm">
            {codes.map((c) => <code key={c} className="px-2 py-1 bg-gray-50 border rounded">{c}</code>)}
          </div>
          <div className="flex gap-2">
            <button onClick={() => navigator.clipboard.writeText(codes.join('\n'))}
              className="px-3 py-2 bg-blue-600 text-white rounded text-sm">复制全部</button>
            <button onClick={() => setCodes(null)} className="px-3 py-2 border rounded text-sm">我已保存</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

挂到 SettingsPage：`<RecoverySection totpActive={settings.security.totp_active} />`（TotpSection 之后）。

- [ ] **Step 2: LoginPage 恢复入口**

密码表单下方加：

```tsx
<button type="button" onClick={() => setRecoveryMode(true)} className="text-xs text-gray-400 hover:text-gray-600">
  无法使用验证器？使用恢复码登录
</button>
```

`recoveryMode` 表单：用户名 + 恢复码两个输入 → `POST /auth/recovery/verify` → 成功 `login(access_token, username)` → `navigate('/')`；失败展示 error（错误信息不含"码不存在/账户不存在"区分——后端本就统一 INVALID_RECOVERY_CODE）。

- [ ] **Step 3: 实测验收**

- 生成 → 退出登录 → 恢复码登录成功 → 原会话已吊销（旧 access token 无感，但 refresh cookie 对应 session 已 revoked——刷新会 401）
- 同一码二次使用 → 401
- 错 5 次 → 锁定提示

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 恢复码生成/展示（设置页）+ 登录页恢复码入口

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: 断点续传 UI

> 后端已就绪：`GET /uploads/:id`（返回 `received_parts[]`）与 `POST /uploads/:id/resume` 均走 X-Upload-Token 匿名路径（Phase 1 v1.7）。本任务纯前端：localStorage 持久化上传状态 + 恢复交互。

**Files:**
- Modify: `apps/web/src/components/FileUpload.tsx`
- Create: `apps/web/src/lib/pending-uploads.ts`

**Interfaces:**
- Produces:
  - `pending-uploads.ts`：`savePending(u: PendingUpload)` / `listPending(): PendingUpload[]` / `removePending(uploadId)`；`PendingUpload = { upload_id, upload_token, chunk_size, filename, size, folder_id: string | null, saved_at: number }`；localStorage key 前缀 `fs_upload_`
  - FileUpload：上传 init 后 savePending；完成/中止 removePending；挂载时列出 pending（过滤 24h 前），逐个 `GET /uploads/:id` 探测活性（404/410 → 移除 key），活的显示恢复条
  - 恢复交互：点击"继续"→ 触发文件选择 → 校验 name+size 一致 → `POST /uploads/:id/resume` → 跳过 `received_parts` 续传剩余分块 → complete

- [ ] **Step 1: pending-uploads.ts**

```typescript
// apps/web/src/lib/pending-uploads.ts
export interface PendingUpload {
  upload_id: string;
  upload_token: string;
  chunk_size: number;
  filename: string;
  size: number;
  folder_id: string | null;
  saved_at: number;
}

const PREFIX = 'fs_upload_';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function savePending(u: PendingUpload): void {
  localStorage.setItem(`${PREFIX}${u.upload_id}`, JSON.stringify(u));
}

export function removePending(uploadId: string): void {
  localStorage.removeItem(`${PREFIX}${uploadId}`);
}

export function listPending(): PendingUpload[] {
  const out: PendingUpload[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const u = JSON.parse(localStorage.getItem(key)!) as PendingUpload;
      if (Date.now() - u.saved_at < MAX_AGE_MS) out.push(u);
      else localStorage.removeItem(key);
    } catch {
      localStorage.removeItem(key);
    }
  }
  return out;
}
```

- [ ] **Step 2: FileUpload 改造**

改造要点（在既有组件上扩展，不重写）：

```tsx
// 新增 state
interface ResumableState extends PendingUpload { received_parts: number[]; }
const [resumables, setResumables] = useState<ResumableState[]>([]);
const fileInputRef = useRef<HTMLInputElement>(null);
const resumeTargetRef = useRef<ResumableState | null>(null);

// 挂载时探测
**api.ts 扩展**（getStatus/resume 探测需要 X-Upload-Token 头而非管理员 JWT）：`api.ts` 的 `get` 签名改为 `get<T>(path: string, headers?: Record<string, string>)`（内部透传 `this.request('GET', path, undefined, headers)`）——既有调用无第二参，向后兼容。调用方不传 Authorization 时 api.ts 会自动补管理员 token——上传端点同时收到两种凭证时后端优先读 X-Upload-Token（现状如此，上传/complete 一直这么调的），保持一致即可。

挂载时探测（FileUpload 组件内）：

```typescript
useEffect(() => {
  (async () => {
    const alive: ResumableState[] = [];
    for (const p of listPending()) {
      try {
        const res = await api.get<{ received_parts: number[]; status: string }>(
          `/uploads/${p.upload_id}`, { 'X-Upload-Token': p.upload_token },
        );
        if (res.data!.status === 'initiated' || res.data!.status === 'uploading') {
          alive.push({ ...p, received_parts: res.data!.received_parts });
        } else {
          removePending(p.upload_id); // completed/failed/aborted
        }
      } catch { removePending(p.upload_id); }
    }
    setResumables(alive);
  })();
}, []);
```

上传流程埋点（`onDrop` 内）：

```typescript
// init 成功后：
savePending({ upload_id, upload_token, chunk_size, filename: file.name, size: file.size, folder_id: folderId, saved_at: Date.now() });
// complete 成功后：removePending(upload_id);
// catch 中：保留 pending（这就是续传的意义），alert 提示"可稍后继续"
```

恢复 UI（dropzone 上方渲染）：

```tsx
{resumables.length > 0 && (
  <div className="mb-4 space-y-2">
    {resumables.map((r) => {
      const total = Math.ceil(r.size / r.chunk_size);
      const pct = Math.round((r.received_parts.length / total) * 100);
      return (
        <div key={r.upload_id} className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm">
          <span className="truncate flex-1" title={r.filename}>{r.filename}</span>
          <span className="text-gray-500 shrink-0">{pct}%</span>
          <button onClick={() => { resumeTargetRef.current = r; fileInputRef.current?.click(); }}
            className="text-blue-600 shrink-0 py-1">继续</button>
          <button onClick={() => handleDiscard(r)} className="text-red-600 shrink-0 py-1">放弃</button>
        </div>
      );
    })}
  </div>
)}
{/* 隐藏的文件选择器：浏览器安全模型要求重新选取文件才能拿到内容 */}
<input ref={fileInputRef} type="file" className="hidden" onChange={handleResumeFilePicked} />
```

恢复逻辑：

```typescript
const handleResumeFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  const target = resumeTargetRef.current;
  e.target.value = '';
  if (!file || !target) return;
  if (file.name !== target.filename || file.size !== target.size) {
    alert(`所选文件与待恢复上传不一致（需要 ${target.filename}，${target.size} 字节）`);
    return;
  }
  await uploadChunks(file, target); // 与 onDrop 共用：跳过 received_parts 的分块循环
};

const handleDiscard = async (r: ResumableState) => {
  if (!confirm(`放弃「${r.filename}」的上传？已传分块将被清理。`)) return;
  try { await api.delete(`/uploads/${r.upload_id}`); } catch {} // DELETE 需要 X-Upload-Token → api.delete 也需 headers 扩展
  removePending(r.upload_id);
  setResumables((prev) => prev.filter((x) => x.upload_id !== r.upload_id));
};
```

`api.delete` 同步扩展第二参 `headers?`。

分块循环抽为共用函数 `uploadChunks(file, state: { upload_id, upload_token, chunk_size, skip: Set<number> })`：循环中 `if (skip.has(i)) continue;`，进度按 `(done + skipped) / total` 计算。

- [ ] **Step 3: 实测验收**

- 大文件传到 ~50% → 刷新页面 → 出现恢复条且百分比正确 → 继续 → 选同一文件 → 从断点续传完成（网络面板可见跳过已传分块）
- 选错文件 → 明确提示
- 放弃 → 后端 abort + 恢复条消失 + 刷新不再出现
- 完成上传后刷新 → 无恢复条

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 断点续传 UI——localStorage 状态持久化 + 活性探测 + 恢复/放弃交互

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: 并发/压力测试补全

**Files:**
- Create: `apps/server/test/concurrency.e2e-spec.ts`

（注意：`apps/server/test/folders-concurrency.e2e-spec.ts` 已存在——那是 folders **服务层直接调用**的并发测试；本文件是 **HTTP 层**端到端并发，层面不同、不重复，不要合并也不要动它。）

**Interfaces:**
- Consumes: 全部既有端点；Task 3 建的 `apps/server/test/helpers.ts`
- Produces: 三个并发场景的 E2E 保障

- [ ] **Step 1: 编写并发 E2E** `apps/server/test/concurrency.e2e-spec.ts`

helpers 一律 import 自 `./helpers`（Task 3 建的唯一公共副本，禁止第三份复制）。断言依据已核对的既有实现：下载额度耗尽抛 `GoneException`（410，见 download.service.ts countDownload 条件 UPDATE）；同 part 并发/串行双写均确定性 409（见 uploads.service.ts claimPart）；complete 幂等返回同一 file_id（uploads.service.ts 阶段三 affected=0 重查分支）。

```typescript
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
import { setupEnv, teardownEnv, createApp, initAndLogin, uploadSmallFile, TestEnv } from './helpers';

describe('Concurrency (Phase 2)', () => {
  let env: TestEnv;
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    env = await setupEnv();
    app = await createApp();
    accessToken = await initAndLogin(app);
  }, 60_000);

  afterAll(async () => { await app.close(); await teardownEnv(env); });

  it('并发下载计数：max_downloads=2 时 10 路并发下载恰 2 个 200，其余 410', async () => {
    const server = app.getHttpServer();
    const fileId = await uploadSmallFile(server, accessToken, 'quota.txt', Buffer.from('quota test'));
    const shareRes = await request(server).post('/api/v1/shares')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ file_id: fileId, protection: 'none', max_downloads: 2 }).expect(201);
    const shareId = shareRes.body.data.share_id;

    // 每路独立走完整流程：access → download-ticket → GET 票据 URL
    // 额度抢占发生在实际下载时（download.service countDownload 条件 UPDATE）
    const statuses = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const access = await request(server).post(`/api/v1/shares/${shareId}/access`).send({});
        if (access.status !== 200) return access.status; // 额度耗尽后 access 预检也是 410
        const ticket = await request(server).post(`/api/v1/shares/${shareId}/download-ticket`)
          .set('Authorization', `Bearer ${access.body.data.download_token}`).send({});
        if (ticket.status !== 200) return ticket.status;
        const dl = await request(server).get(ticket.body.data.ticket_url);
        return dl.status;
      }),
    );
    expect(statuses.every((s) => s < 500)).toBe(true); // 并发下出现 5xx = 真实实现缺陷（锁/事务错误），先修后端
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 410)).toHaveLength(8); // SHARE_EXHAUSTED

    const listRes = await request(server).get(`/api/v1/shares?file_id=${fileId}`)
      .set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(listRes.body.data[0].used_downloads).toBe(2);
  });

  it('并发完成同一上传：5 路 complete 全部 201 且返回同一 file_id，files 表仅一行', async () => {
    const server = app.getHttpServer();
    const content = Buffer.from('concurrent complete content');
    const initRes = await request(server).post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'race-complete.bin', size: content.length }).expect(201);
    const { upload_id, upload_token } = initRes.body.data;
    const checksum = createHash('sha256').update(content).digest('hex');
    await request(server).put(`/api/v1/uploads/${upload_id}/parts/0`)
      .set('X-Upload-Token', upload_token).set('X-Part-Checksum', checksum)
      .set('Content-Type', 'application/octet-stream').send(content).expect(200);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(server).post(`/api/v1/uploads/${upload_id}/complete`)
          .set('X-Upload-Token', upload_token).send({}),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true); // 幂等完成
    const fileIds = new Set(results.map((r) => r.body?.data?.file_id));
    expect(fileIds.size).toBe(1);

    const filesRes = await request(server).get('/api/v1/files?page_size=100')
      .set('Authorization', `Bearer ${accessToken}`).expect(200);
    const same = filesRes.body.data.items.filter((f: any) => f.filename === 'race-complete.bin');
    expect(same).toHaveLength(1);
  });

  it('并发分块双写：同 part 不同内容，一路 200 一路 409，完成内容与 200 路一致', async () => {
    const server = app.getHttpServer();
    const partA = Buffer.from('AAAA-part-zero-content');
    const partB = Buffer.from('BBBB-part-zero-content'); // 同长度（22 字节），排除 size 维度干扰
    expect(partA.length).toBe(partB.length);

    const initRes = await request(server).post('/api/v1/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'race-part.bin', size: partA.length }).expect(201);
    const { upload_id, upload_token } = initRes.body.data;

    const putPart = (data: Buffer) =>
      request(server).put(`/api/v1/uploads/${upload_id}/parts/0`)
        .set('X-Upload-Token', upload_token)
        .set('X-Part-Checksum', createHash('sha256').update(data).digest('hex'))
        .set('Content-Type', 'application/octet-stream')
        .send(data);
    const [rA, rB] = await Promise.all([putPart(partA), putPart(partB)]);
    // 确定性 [200, 409]，与时序无关（见 uploads.service.ts claimPart）：
    // 并发撞 receiving+他人 → 409 PART_BEING_RECEIVED；串行撞 ready+不同 checksum → 409 PART_CHECKSUM_MISMATCH
    expect([rA.status, rB.status].sort()).toEqual([200, 409]);

    const completeRes = await request(server).post(`/api/v1/uploads/${upload_id}/complete`)
      .set('X-Upload-Token', upload_token).send({}).expect(201);
    const fileId = completeRes.body.data.file_id;

    // 管理端读回内容，必须与获胜方逐字节一致（checksum 校验兜底防脏写）
    const contentRes = await request(server).get(`/api/v1/files/${fileId}/content`)
      .set('Authorization', `Bearer ${accessToken}`)
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const winner = rA.status === 200 ? partA : partB;
    expect(Buffer.compare(contentRes.body as Buffer, winner)).toBe(0);
  });
});
```

Run: `npm run test:e2e --workspace=@filestation/server -- concurrency`
Expected: 3 场景 PASS（以实际运行结果为准；**若场景 1/2/3 暴露了真实竞态缺陷，停下来修后端再回来跑**——这正是本任务的目的；修复必须遵循 Global Constraints 的条件 UPDATE 模式，禁止 SELECT FOR UPDATE）

- [ ] **Step 3: Commit**

```bash
git add apps/server/test
git commit -m "test(server): 并发场景 E2E——下载计数抢占 / 上传完成幂等 / 分块双写校验

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: 文档收尾（设计文档 v2.3 + ADR-0005 + AGENTS.md + CURRENT-STATE + README）

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-filestation-design.md`（v2.2 → v2.3——重大架构变更，AGENTS.md §9.2 要求升版）
- Create: `docs/adr/0005-mcp-embedded-with-api-token.md`
- Modify: `AGENTS.md`（补 Phase 2 安全硬规则）
- Modify: `docs/CURRENT-STATE.md`
- Modify: `README.md`

（仓库无 CHANGELOG.md——变更日志按惯例写在 CURRENT-STATE.md 内，不新建文件；DOCUMENTATION-GOVERNANCE.md 无需变动，本次不新增文档类型。）

- [ ] **Step 1: 设计文档升 v2.3**

`docs/superpowers/specs/2026-07-28-filestation-design.md`：版本号 v2.2 → v2.3，更新/新增小节（描述以最终实现为准，落笔前与代码同步核对）：
- §5.3 认证：API Token 双轨鉴权（REST 换 1h JWT / MCP 直连长期 token）、6 种 scopes、JWT payload 扩展 `principal_type/scopes/token_id`
- §5.3 认证（API Token 存储）：`token_hash` 零索引/零唯一约束的理由成文——token 192 bit（`randomBytes(24)`）、`validatePlaintext` 按 tokenHash 直接 `findOne`、单管理员全表扫成本可忽略；Phase 3 token 变多再补唯一索引（一个迁移即可）。与 ADR-0005 决策 7 一致
- 新增"Agent 接入"节：MCP 内嵌端点 `/api/v1/mcp`（无状态 Streamable HTTP、默认关闭、GET/DELETE 404）、11 个工具清单与 scope 映射、上传三件套与 16MB 路由级 body 上限、`mcp_max_upload_mb` 单文件上限语义
- §4.8 审计：补全 action 清单（`auth.*` / `api_token.*` / `mcp.tool_called` / `recovery.*` / `share.*` / `file.*`，以最终实现为准）
- §6.1 恢复码：熵 50 bit（Crockford 10 字符）、Argon2id 参数、24h 有效期维持（2026-09-23 评审确认不放宽）
- 两条语义说明：`totp_required` 在单管理员模型下等价于全员强制（当前唯一账户即管理员）；端点路径统一为 `/api/v1/api-tokens`（复数资源、与 /shares /folders 一致）

- [ ] **Step 2: ADR-0005**

```markdown
# ADR-0005: MCP 服务内嵌主应用（API Token 鉴权）

## 状态
已接受（2026-09-19 起草，2026-09-23 外部评审修订，Phase 2）

## 背景
用户要求 Agent（Claude Desktop / Claude Code 等）能操作 FileStation：上传文件、生成分享链接。
独立 MCP 包方案被否：部署两份进程、鉴权割裂、审计分散。

## 决策
1. MCP（Streamable HTTP，无状态模式）内嵌 NestJS 主应用，端点 `/api/v1/mcp`，默认关闭（settings `agent.mcp_enabled`）
2. 鉴权复用 API Token（Bearer fs_api_*，SHA-256 哈希存储），逐工具检查 scope，不做 JWT exchange（MCP 客户端持长期 token）
3. **双轨鉴权**：REST 侧 agent 走 `POST /auth/api-token/exchange` 换 **1 小时** JWT——设计文档未规定此时长，属 Phase 2 新决策（短时效换吊销后最大 1h 残留窗口，与 admin 会话 24h 区分）；MCP 侧持长期 token 直连
4. MCP 工具不另开数据通路：上传走与 Web 相同的 UploadsService 三阶段（`upload_init`/`upload_part`/`complete_upload` 三个工具，单分块 ≤8MB 原始、base64 传输；`/api/v1/mcp` 路由级 JSON body 上限 16MB，其余路由仍默认 100KB）；create_share 走 SharesService.createShare
5. 审计：每次工具调用写 audit_logs（action=mcp.tool_called），API Token 主体的所有 REST 操作同样落审计
6. JWT 负载扩展 principal_type/scopes/token_id；scope 检查**内嵌 JwtAuthGuard**（认证后执行；未标注 @RequireScopes 的端点默认拒绝 api_token 主体——不做 APP_GUARD 全局守卫，全局守卫先于 passport 拿不到 req.user）；JwtStrategy 以数据库 scopes 为准防伪造放大
7. `api_tokens.token_hash` **不加索引/唯一约束**：token 为 192 bit（`randomBytes(24)` hex）高熵随机，冲突概率可忽略；`validatePlaintext` 按 tokenHash 直接 `findOne`（无前缀候选过滤）；不加索引的理由——单管理员、token 数量极少，全表扫成本可忽略；Phase 3 若 token 变多再加唯一索引（一个迁移即可）
8. 依赖锁定 `@modelcontextprotocol/sdk@^1.30.0` + `zod@^3.25.76`（zod 4 与 SDK 1.30 类型推导不兼容）：工具注册用 variadic `server.tool(name, desc, schema, handler)`——1.30.x 中标注 `@deprecated Use registerTool instead` 但重载齐全可用，锁定版本内行为确定；未来升级 v2 线（新包名 `@modelcontextprotocol/server`，目前 alpha）时统一迁移 `registerTool`。SDK 嵌套依赖 express 5 与应用本体 express 4 并存：`handleRequest` 只消费 Node req/res，兼容，无需处理

## 后果
- 部署形态不变（单进程 / Nginx 两模式均兼容）
- 吊销 Token 即时生效（JwtStrategy 每次查库 + MCP 每次 validatePlaintext）
- 已知限制：未开启 `trust proxy`（防 XFF 伪造绕过 IP 限流），Nginx 反代模式下审计日志的 IP 为代理地址；`share_url_absolute` 由请求 Host 推导、可被伪造，仅作展示便利——两者均由 Phase 3 的 `public_base_url` 设置项根治
```

- [ ] **Step 3: AGENTS.md 补 Phase 2 硬规则**

在安全/开发约定相关节追加（措辞对齐 AGENTS.md 现有风格）：
- 受 JWT 保护的端点默认对 api_token 主体拒绝：新增控制器/端点**必须**显式标注 `@RequireScopes(...)` 才对 agent 开放；禁止绕过 JwtAuthGuard 的内嵌检查，禁止把 scope 检查拆回全局守卫（APP_GUARD 先于 passport 执行，拿不到 req.user）
- 纯管理端点（设置、审计、API Token 管理、TOTP/恢复码管理）挂 `@UseGuards(JwtAuthGuard, AdminOnlyGuard)`
- 审计脱敏红线：永不记录密码 / TOTP 明文 / 完整 token / 临时码机密 / 恢复码明文；IP 一律 /24（IPv6 前 3 段）匿名化后落库
- 新 e2e 文件一律 import `apps/server/test/helpers.ts`，禁止复制第三份环境搭建代码；e2e 命令用 `npm run test:e2e --workspace=@filestation/server -- <name>`

- [ ] **Step 4: CURRENT-STATE 更新**

- 状态表：Phase 2 完成（含验证日期）
- Phase 2 checklist 全部勾选；新增"Agent 接入（MCP 内嵌）"条目
- 设计决策摘要补：API Token 双轨鉴权 / scope 检查内嵌 JwtAuthGuard 默认拒绝 / MCP 内嵌 / TOTP AES-GCM 存储 / 恢复码用后吊销全部会话
- 关键约束补：MCP 默认关闭、审计 90 天、IP /24 匿名化
- 已知限制补两条（均注明 Phase 3 `public_base_url` 设置项根治）：Nginx 反代模式下审计 IP 为代理地址（未开 trust proxy 的代价）；`share_url_absolute` 由 Host 头推导、可被伪造仅作展示
- 变更日志追加 Phase 2 条目
- Phase 3/4 待办顺延不变

- [ ] **Step 5: README 补 Agent 接入段**

```markdown
## Agent 接入（MCP）

1. 设置页 → API Token：签发 Token（按需勾选 scopes）
2. 设置页 → Agent 接入（MCP）：启用端点，复制端点地址
3. 客户端配置（Claude Desktop `claude_desktop_config.json` 示例）：

{
  "mcpServers": {
    "filestation": {
      "type": "http",
      "url": "https://your-host/api/v1/mcp",
      "headers": { "Authorization": "Bearer fs_api_..." }
    }
  }
}

工具（11 个）：server_info / list_files / list_folders / create_folder / upload_init /
upload_part / complete_upload / delete_file / create_share / list_shares / revoke_share。
> 上传走 upload_init → upload_part×N → complete_upload（单分块 ≤8MB 原始、base64 传输）；
> 单文件总大小上限见设置页（默认 32MB），更大文件请直接调用 REST 分块上传接口。
```

- [ ] **Step 6: 全量回归 + 浏览器端到端手动验证清单（交给用户）**

```bash
npm run test && npm run typecheck && npm run lint
npm run test:e2e --workspace=@filestation/server
```

手动验证清单（写进 PR/交付说明，等用户确认"没问题"后才算 Phase 2 完成）：
1. 签发 API Token → Claude Desktop 配置 → 让 agent 上传文件并创建分享 → 链接可下载 → 审计页可见全部操作
2. 移动端（375px）：抽屉/卡片/弹窗/分享页全流程
3. TOTP 启用 → 两步登录 → 恢复码登录 → 会话吊销确认
4. 断点续传：中途刷新恢复上传

- [ ] **Step 7: Commit**

```bash
git add docs README.md AGENTS.md
git commit -m "docs: Phase 2 收尾——设计文档 v2.3 + ADR-0005（MCP 内嵌）+ AGENTS.md 硬规则 + CURRENT-STATE/README 更新

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 自检记录（v1.0 起草后）

**Spec 覆盖**（对照设计文档 v2.2 与 2026-09-19 需求确认）：
- API Token exchange + scopes ✅ Task 2/3（§5.3、§6.1）
- 审计日志（表已建、脱敏、90 天）✅ Task 4（§4.8、§6.5）
- TOTP login_challenge ✅ Task 8/9（§5.3、§6.1）
- 恢复码（Argon2id、一次性、24h、吊销全部会话）✅ Task 10/11（§6.1、§6.2）
- 断点续传 UI ✅ Task 12（后端 resume 已就绪，纯前端）
- 并发/压力测试 ✅ Task 13（§6.3 原子计数场景）
- Agent/MCP 内嵌 + 设置开关 ✅ Task 5/7（用户新需求）
- 移动端 UI ✅ Task 6/7（实测问题清单）
- WebAuthn/直链/多入口/临时码/P2P：Phase 3/4，不在本计划

**决策点评审结论**（2026-09-23 外部评审逐条回答，已吸收进对应任务）：
1. 恢复码 24h 有效期：**维持 24h**（设计文档 §6.1 明确语义，不放宽）——设计 v2.3 注明评审确认
2. MCP base64 上限：整文件上传已拆三件套，问题消解；`mcp_max_upload_mb` 变为**单文件总大小上限**在 `upload_init` 检查，默认 32MB 不变
3. 双轨鉴权（REST 换 1h JWT / MCP 直连长期 token）：**可接受**，但 1h 时长是设计文档未覆盖的新决策 → ADR-0005 决策 3 显式记录
4. `totp_active` 派生字段：可行，但必须防落库 → DTO 放行 + 控制器剥离 + `setSecuritySettings` 服务边界再剥（双重保护，Task 8）
5. 移动端断点 `md(768px)`：可，抽屉补 **body 滚动锁**（Task 6 Step 2 useEffect，含卸载清理）
6. 语义备注（评审补充）：`totp_required` 在单管理员模型下等价于"全员强制"——设计文档 v2.3 写明此语义

## v1.1 修订记录（2026-09-23 外部评审吸收，20 项全量映射）

**阻断级（5）**
1. e2e 命令错误（`npm run test` 的 jest.config.json `rootDir: src` 跑不到 `test/`）→ Global Constraints 新增命令规则；Task 3/13 改用 `npm run test:e2e --workspace=@filestation/server -- <name>`
2. MCP SDK/zod 版本风险 → 锁定 `@modelcontextprotocol/sdk@^1.30.0` + `zod@^3.25.76`，装完即 `typecheck`（已核实 npm latest=1.30.0、无 v2 发布；评审"v2 删 variadic .tool()"对发布版不成立——但 `.tool()` 在 1.30.x 已标 `@deprecated`，迁移路径见 Task 5 Step 1 与 ADR-0005 决策 8；zod 4 类型不兼容风险属实，采纳锁版）
3. base64 整文件上传撞 100KB 默认 body 上限（413）→ 拆 `upload_init`/`upload_part`/`complete_upload` 三件套；main.ts 对 `/api/v1/mcp` 路由级放宽 16MB（利用 listen 前 app.use 先于 Nest 全局 parser 进栈 + `req._body` 跳过机制），其余路由保持 100KB
4. `AuditService.findAll` 返回 `{items,total}` 与控制器声明的 `PaginatedResponse`（5 字段）编译冲突 → 改返完整分页结构 + 单测锁定契约
5. `randomBytes(7)` 恢复码只有 35 bit 且第三段为空 → `randomBytes(10)`（10 字符 50 bit，256%32=0 取模无偏）

**高优（8）**
6. Task 2 步骤顺序倒置（测试通过后守卫才存在）→ AdminOnlyGuard 创建提前至运行测试之前
7. ScopesGuard 只在挂载处生效（新端点裸奔）→ 改为纯函数 `assertPrincipalScopes` **内嵌 JwtAuthGuard**（认证后执行）；不用 APP_GUARD——全局守卫先于 passport 拿不到 `req.user`；架构理由写入任务与 ADR 防回改
8. `verifyTotpLogin` 缺 IP 节流与成功清计数 → 入口 `checkIpThrottle`、失败 `recordIpFailure`、成功 `clearLoginFailures`+`clearIpFailures`（与密码路径对称）
9. 恢复码 verify 缺 IP 防线 → `AuthService.recoveryVerify` 包装层统一把关（非薄委托）；RecoveryService 只管账户维度
10. `totp_active` 会随合并落库 → 服务边界 `setSecuritySettings` 统一剥离派生字段（见决策点 4）
11. Task 13 断言脆弱 + 与既有 `folders-concurrency.e2e-spec.ts` 疑似重复 → 场景 1 加"无 5xx"总闸；场景 3 注明确定性依据（并发 PART_BEING_RECEIVED / 串行 PART_CHECKSUM_MISMATCH 均 409）；注明 folders 文件是服务层、不合并
12. 实体-迁移对齐测试自我证明（手写 DDL）→ 改用真实 `InitialSchema1700000000000` 迁移建库 + `PRAGMA table_info` 逐列比对（Task 1）
13. `validatePlaintext` 测试 mock 永不命中（空转）→ mock 键用真实 SHA-256 计算，覆盖 有效/吊销/过期/不存在/前缀不符 5 分支

**建议（7）**
14. 端点路径二选一 → 统一 `/api/v1/api-tokens`（复数资源，与 /shares /folders 一致），设计 v2.3 同步
15. 删除旧 `LoginResponse`（可选字段堆叠、web 未用）→ Task 1 删除，`LoginResponseData` 判别联合替代；`JwtPayload` 仅加 `token_id?: string`，iat/exp 保持必填
16. `token_hash` 零索引理由成文 → ADR-0005 决策 7 + 设计 v2.3
17. Host 头信任 → 不开 `trust proxy`（保 IP 限流不被 XFF 绕过）；`share_url` 相对路径为规范值、`share_url_absolute` 仅展示便利并注释可伪造；Phase 3 `public_base_url` 根治；写入 ADR 后果与 CURRENT-STATE 已知限制
18. CHANGELOG.md 不存在、设计文档应按 §9.2 升版 → Task 14 改为设计文档 v2.3 + AGENTS.md 硬规则，变更日志留在 CURRENT-STATE（不新建 CHANGELOG）
19. 一致性修正包 → 工具数 9→11 全文对齐；`s.maxDownloads`→`s.max_downloads`；AppLayout props 单一定义（`{ children, onFolderToggle? }`）；`RecoveryService.verify` 返回 `{ accountId }`
20. 抽取 `apps/server/test/helpers.ts` → Task 3 建立唯一公共副本（含 uploadSmallFile；不开 enableCors 并注明原因），Task 13 import 复用，AGENTS.md 立规禁止第三份复制

## v1.2 修订记录（2026-09-24 外部复审吸收，4 项全量映射）

复审结论：v1.1 的 20 项修订全部落实（5/5 阻断真修、8/8 高、6.5/7 建议——#16 因 ADR 决策 7 事实错误标 ⚠️，即本版 B 项）。新发现 4 项全部采纳：

- **A【高，开工前门槛项】** `upload_init` 缺省 chunk_size 会把全局 `default_chunk_size`（设置允许到 64MiB）带进会话 → 首个 part 的 base64 撞 `/api/v1/mcp` 16MB 路由上限 → 413 且是 Express 非 JSON 错误页。→ 已修：代码内 `chunk_size ?? Math.min(8 * 1024 * 1024, transfer.default_chunk_size)` 兜底（Task 5），工具说明注明 8MB 硬上限（upload_init/upload_part 描述），Global Constraints 增"分块 ≤8MB 硬不变量"行
- **B【中】** ADR-0005 决策 7 两处与实现不符 → 已订正：token 实为 **192 bit**（`randomBytes(24)` hex，非 256）；`validatePlaintext` 实为**按 tokenHash 直接 `findOne`**（无 token_prefix 候选过滤）；零索引理由重写为"单管理员、token 数量极少、全表扫成本可忽略；Phase 3 若变多再补唯一索引（一个迁移即可）"。设计 v2.3 同步条目一并订正（见 C①）
- **C【低】** ① 设计 v2.3 清单漏 `token_hash` 零索引条目（v1.1 修订记录 16 声称成文但 Task 14 Step 1 未列）→ 已补入 §5.3 认证（API Token 存储）；② `@RequireScopes()` 空参产生的元数据是 `[]` 而非 `undefined`，逃过 `if (!required)` 默认拒绝 → 已修 `if (!required || required.length === 0)` + 新增第 6 个单测（Task 3）
- **D【低】** "无 v2" 措辞不完整 → 已补全：1.30.x 的 variadic `.tool()` 为 `@deprecated` 但重载齐全可用，锁定版本内行为确定；升级 v2 线（新包名 `@modelcontextprotocol/server`，目前 alpha）时迁移 `registerTool`；SDK 嵌套依赖 express 5 与应用 express 4 并存（`handleRequest` 只消费 Node req/res，兼容，知悉即可）。落点：Task 5 Step 1 锁版说明、ADR-0005 新增决策 8、Global Constraints 依赖锁定行

评审边界披露（复审原文）：Task 6/7/9/11/12 按修订项抽查、未逐行重读整段前端代码——执行这些任务时按计划自带验收步骤照常验证。

开工门槛：复审意见"唯一开工前建议先补的是 A（一行代码 + 一句工具说明），其余 B/C/D 属文档措辞与兜底，可在对应任务执行时顺手改"——本版已将 4 项全部提前落实，**无遗留门槛**。
