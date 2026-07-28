# FileStation 文件传输站 - 设计文档 v2.0

## 1. 项目概述

私有文件传输站 Web 应用，单管理员模式，支持多传输入口、灵活分享控制、细粒度权限管理。

**核心特性：**
- 多传输入口智能选路（直连 / 多 FRP 地址）
- 文件 URL 直链（免密预览 / 密码保护 / 管理员验证）
- 临时码授权访客上传下载
- 文件自动过期 + 手动延长/永久保留
- 全局限速 + 入口限速 + 角色限速
- 多设备管理员认证（TOTP / API Token / WebAuthn）
- 虚拟文件夹管理
- WebUI 全配置

**v2.0 核心修正：**
- 认证模型：拆分账户/认证器/Token/会话四表
- 传输协议：HTTP 分块上传 + WebSocket 仅用于进度/信令
- 权限模型：文件始终私有，公开访问统一走 shares 表
- 生命周期：明确状态机 uploading→active→expired→deleting→deleted
- 部署架构：Node 只绑 127.0.0.1，FRP→Nginx→Node 信任链
- 开发计划：四阶段交付，P2P 移出 MVP

---

## 2. 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端 | NestJS (Node.js/TypeScript) | 模块化架构 |
| 前端 | React + shadcn/ui + Tailwind CSS | 现代美观 |
| 数据库 | SQLite (TypeORM) | WAL 模式，busy_timeout=5000 |
| 文件存储 | 本地磁盘（能力接口抽象） | createUpload/writePart/completeUpload/openReadStream/readRange/deleteObject |
| 实时通信 | WebSocket (Socket.io) | 仅进度推送、P2P 信令、管理端实时监控 |
| 构建 | Vite | 快速开发 |

---

## 3. 部署架构（信任边界明确）

```
┌─────────────────────────────────────────┐
│  访问者浏览器 / 管理员设备                │
└──────────┬──────────────────────────────┘
           │ HTTPS/WSS
           ▼
┌─────────────────────────────────────────┐
│  Nginx (必需，非可选)                    │
│  - TLS 终结                             │
│  - Host 校验、请求大小限制                │
│  - 安全响应头                            │
│  - 根据 Host 映射入口标识                 │
│  - 反代到 127.0.0.1:8080                │
└──────────┬──────────────────────────────┘
           │ HTTP (本地回环，可信)
           ▼
┌─────────────────────────────────────────┐
│  FileStation Node.js 服务               │
│  - 默认绑定 127.0.0.1:8080               │
│  - 仅信任来自 Nginx 的 X-Entry-Id       │
│  - SQLite WAL 模式 + 本地文件存储         │
└──────────┬──────────────────────────────┘
           │ 用户自行配置 frpc 指向本地 Nginx 端口
           ▼
┌─────────────────────────────────────────┐
│  公网服务器 (frps / 其他 FRP 工具)        │
└─────────────────────────────────────────┘
```

**入口识别机制：**
- 每个 FRP 地址对应独立域名或端口，在 Nginx 中配置 `server_name`
- Nginx 设置 `X-Entry-Id: entry_1` 头，Node 只信任来自 127.0.0.1 的此头
- 客户端不提交入口标识，服务端根据请求来源自动识别

**WebAuthn 要求：**
- 必须 HTTPS 安全上下文
- RP ID 配置为当前访问域名，多域名需分别注册或配置为主域名

---

## 4. 后端模块架构 (NestJS)

```
src/
├── main.ts                    # 全局前缀 /api/v1
├── app.module.ts
├── config/
├── database/                  # TypeORM + SQLite WAL
├── auth/                      # 认证模块
│   ├── strategies/            # JWT / API Token / TOTP / WebAuthn
│   ├── guards/                # AdminGuard / TempCodeGuard / ShareGuard
│   └── auth.controller.ts
├── accounts/                  # 管理员账户（单账户，预留多账户）
│   └── accounts.service.ts    # 初始化和密码管理
├── files/                     # 文件核心
│   ├── files.controller.ts    # CRUD + 内容下载
│   ├── files.service.ts
│   ├── storage.service.ts     # 能力接口抽象
│   ├── cleanup.service.ts     # @Cron 过期清理
│   └── rate-limit.service.ts  # 多层令牌桶
├── folders/
│   └── folders.controller.ts  # 树形 CRUD，防循环移动
├── uploads/                   # 上传会话管理
│   ├── uploads.controller.ts  # HTTP 分块上传
│   └── uploads.service.ts     # 断点续传状态
├── shares/                    # 分享链接
│   ├── shares.controller.ts   # 管理 + 访问
│   └── shares.service.ts
├── temp-codes/
│   └── temp-codes.service.ts
├── transfer/                  # 传输调度
│   ├── transfer.gateway.ts    # WebSocket /ws/transfer
│   ├── entry.service.ts       # 入口探测与选路
│   └── session.service.ts     # transfer_session 管理
├── settings/
│   └── settings.controller.ts
├── stats/                     # 统计
│   └── stats.controller.ts    # 存储/下载/上传统计
└── health/
    └── health.controller.ts   # /api/v1/health
```

---

## 5. 数据库 Schema (SQLite)

**统一规范：**
- 时间字段：Unix 毫秒 (INTEGER)，UTC
- API 返回：ISO 8601 字符串
- 限速单位：bytes_per_second (INTEGER)，NULL=跟随上级，0=不限
- 外键：仅列级声明，启用 `PRAGMA foreign_keys = ON`

### 5.1 认证与账户

```sql
-- 管理员账户（单账户，预留多账户扩展）
CREATE TABLE admin_accounts (
    id TEXT PRIMARY KEY,              -- UUID
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,      -- bcrypt
    password_changed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1
);

-- 认证器（TOTP / WebAuthn）
CREATE TABLE authenticators (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    type TEXT NOT NULL CHECK(type IN ('totp', 'webauthn')),
    name TEXT NOT NULL,               -- "我的手机"
    
    -- TOTP 专用
    totp_secret_encrypted TEXT,       -- AES-256-GCM 加密
    
    -- WebAuthn 专用
    credential_id TEXT UNIQUE,        -- base64url
    public_key TEXT,                  -- COSE 格式
    sign_count INTEGER DEFAULT 0,
    transports TEXT,                  -- JSON array
    
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    is_active INTEGER DEFAULT 1
);

-- API Token（长期凭据）
CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    name TEXT NOT NULL,               -- "CLI 工具"
    token_prefix TEXT NOT NULL,       -- 前8位，用于识别
    token_hash TEXT NOT NULL,         -- SHA-256
    scopes TEXT NOT NULL,             -- JSON: ["files:read", "files:write"]
    expires_at INTEGER,               -- NULL=永不过期
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_used_ip TEXT,
    revoked_at INTEGER
);

-- 登录会话（Refresh Token）
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    refresh_token_hash TEXT NOT NULL, -- SHA-256，轮换
    device_info TEXT,                 -- JSON: {user_agent, ip}
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,      -- 7天
    revoked_at INTEGER,
    
    UNIQUE(refresh_token_hash)
);

-- 初始化标记（确保只初始化一次）
CREATE TABLE system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- key: initialized_at, first_account_id
```

### 5.2 文件与文件夹

```sql
CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    is_deleted INTEGER DEFAULT 0,
    
    UNIQUE(name, parent_id)           -- 同级目录名唯一
);

CREATE TABLE files (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES folders(id),
    filename TEXT NOT NULL,
    stored_name TEXT UNIQUE NOT NULL, -- 磁盘存储名 UUID
    size INTEGER NOT NULL CHECK(size >= 0),
    mime_type TEXT,
    hash_sha256 TEXT,
    
    -- 生命周期
    status TEXT NOT NULL DEFAULT 'uploading' 
        CHECK(status IN ('uploading', 'active', 'expired', 'deleting', 'deleted')),
    expires_at INTEGER,               -- NULL=永久，与 is_permanent 合并
    expired_at INTEGER,               -- 标记过期时间
    deleted_at INTEGER,
    
    -- 来源
    uploaded_by_type TEXT NOT NULL CHECK(uploaded_by_type IN ('admin', 'temp_code')),
    uploaded_by_id TEXT NOT NULL,     -- admin_account_id 或 temp_code_id
    upload_ip TEXT,
    
    -- 统计
    download_count INTEGER DEFAULT 0,
    last_download_at INTEGER,
    
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 索引
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_status_expires ON files(status, expires_at);
CREATE INDEX idx_files_created ON files(created_at);
CREATE INDEX idx_folders_parent ON folders(parent_id);
```

### 5.3 上传会话（断点续传）

```sql
CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY,              -- upload_id
    filename TEXT NOT NULL,
    expected_size INTEGER NOT NULL,
    expected_hash TEXT,               -- 可选，完成后校验
    chunk_size INTEGER NOT NULL,      -- 建议 8MB
    
    -- 状态
    status TEXT NOT NULL DEFAULT 'initiated'
        CHECK(status IN ('initiated', 'uploading', 'verifying', 'completed', 'aborted', 'expired', 'failed')),
    received_size INTEGER DEFAULT 0,
    received_parts TEXT,              -- JSON: [0,1,2,5] 或位图路径
    
    -- 存储
    temp_path TEXT NOT NULL,          -- 临时文件路径
    final_file_id TEXT REFERENCES files(id),  -- 完成后关联
    
    -- 来源
    principal_type TEXT NOT NULL CHECK(principal_type IN ('admin', 'temp_code')),
    principal_id TEXT NOT NULL,
    
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,      -- 会话过期，如24小时
    completed_at INTEGER
);

-- 分块记录（可选，大文件用位图替代）
CREATE TABLE upload_parts (
    upload_id TEXT NOT NULL REFERENCES upload_sessions(id),
    part_number INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    size INTEGER NOT NULL,
    checksum TEXT,                    -- 分块 SHA-256
    received_at INTEGER NOT NULL,
    
    PRIMARY KEY (upload_id, part_number)
);
```

### 5.4 分享与下载会话

```sql
CREATE TABLE shares (
    id TEXT PRIMARY KEY,              -- 短随机码，如 /s/abc123
    file_id TEXT NOT NULL REFERENCES files(id),
    
    -- 类型：page=分享页，direct=直链
    type TEXT NOT NULL CHECK(type IN ('page', 'direct')),
    
    -- 保护方式
    protection TEXT NOT NULL DEFAULT 'none' 
        CHECK(protection IN ('none', 'password', 'admin')),
    password_hash TEXT,               -- protection=password 时
    
    -- 限制
    max_downloads INTEGER,
    used_downloads INTEGER DEFAULT 0,
    
    -- 状态
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'exhausted', 'expired', 'revoked')),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    last_used_at INTEGER
);

-- 下载会话（Range 请求不重复计数）
CREATE TABLE download_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id),
    file_id TEXT NOT NULL REFERENCES files(id),
    
    -- 访问令牌
    token_hash TEXT NOT NULL,         -- 短期令牌，HttpOnly Cookie 或 Header
    
    -- 计数控制
    counted INTEGER DEFAULT 0,        -- 是否已计入下载次数
    counted_at INTEGER,
    
    -- 范围请求跟踪
    first_range_start INTEGER,
    last_range_end INTEGER,
    total_bytes_sent INTEGER DEFAULT 0,
    
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,      -- 短期，如1小时
    
    UNIQUE(token_hash)
);

-- 索引
CREATE INDEX idx_shares_file ON shares(file_id);
CREATE INDEX idx_shares_status ON shares(status, expires_at);
CREATE INDEX idx_download_sessions_share ON download_sessions(share_id);
```

### 5.5 临时码

```sql
CREATE TABLE temp_codes (
    id TEXT PRIMARY KEY,              -- code_id，公开部分
    code_secret_hash TEXT NOT NULL,   -- secret 哈希，验证用
    label TEXT,
    
    -- 权限（JSON Schema 校验）
    permissions TEXT NOT NULL,        -- {"upload":true,"download_file_ids":[],"folder_ids":[],"max_files":10}
    
    -- 限制
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    rate_limit_bps INTEGER,           -- 专属限速
    
    -- 状态
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'exhausted', 'expired', 'revoked')),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

-- 临时码使用记录（一次授权会话）
CREATE TABLE temp_code_sessions (
    id TEXT PRIMARY KEY,
    temp_code_id TEXT NOT NULL REFERENCES temp_codes(id),
    session_token_hash TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    
    UNIQUE(session_token_hash)
);
```

### 5.6 传输入口

```sql
CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('direct', 'frp', 'p2p')),
    name TEXT NOT NULL,               -- "FRP-北京节点"
    
    -- 配置（无重复）
    host TEXT NOT NULL,               -- 公网地址
    port INTEGER NOT NULL,
    entry_id TEXT UNIQUE NOT NULL,    -- Nginx X-Entry-Id 对应值
    
    -- 状态
    is_enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,       -- 选路优先级，唯一存储位置
    
    -- 探测
    last_check_at INTEGER,
    last_latency_ms INTEGER,
    last_throughput_bps INTEGER,      -- 历史吞吐量
    failure_count INTEGER DEFAULT 0,
    
    rate_limit_bps INTEGER            -- 入口专属限速
);
```

### 5.7 系统配置

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,              -- JSON，带 schema version
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES admin_accounts(id)
);

-- 预置键（全局配置，不含入口配置）:
-- site: {name, icon, theme_color}
-- security: {totp_required, max_login_attempts, lockout_minutes}
-- transfer: {p2p_enabled, stun_server, default_chunk_size, 
--            global_upload_limit_bps, global_download_limit_bps,
--            role_limits: {admin:0, temp_code:10485760, public:5242880}}
-- storage: {path, max_size_gb, cleanup_grace_hours, default_expire_hours}
```

---

## 6. 核心协议设计

### 6.1 上传协议（HTTP 分块）

```
1. 初始化
   POST /api/v1/uploads
   {filename, size, hash?, chunk_size?}
   ← {upload_id, chunk_size, expires_at}

2. 上传分块（幂等）
   PUT /api/v1/uploads/:id/parts/:part_number
   Headers: X-Upload-Token, Content-Range
   Body: binary chunk
   ← 200 {received: true} 或 409 {received: false, expected_checksum}

3. 查询状态
   GET /api/v1/uploads/:id
   ← {status, received_parts, received_size}

4. 完成上传
   POST /api/v1/uploads/:id/complete
   {final_hash?}
   ← {file_id, status: 'active'}

5. 中止上传
   DELETE /api/v1/uploads/:id

6. 恢复上传（重新初始化）
   POST /api/v1/uploads/:id/resume
   ← {received_parts, chunk_size}
```

**幂等性保证：**
- 同一 part_number 重复上传，校验 checksum 一致则返回 200
- 不一致则返回 409，客户端需重传
- 分块 checksum 使用 SHA-256

### 6.2 下载协议（Range 支持）

```
1. 获取下载授权
   GET /api/v1/shares/:id/access  (或 POST /verify 后)
   ← {download_token, expires_at, file_info}

2. 下载文件（支持 Range）
   GET /api/v1/shares/:id/content
   Headers: Authorization: Bearer <download_token>, Range: bytes=0-1048575
   ← 206 Partial Content / 200 OK

3. 直链访问（无需 token，分享 type=direct）
   GET /f/:id/:filename
   Headers: Range: bytes=...
   ← 206 / 200，Content-Disposition: inline/attachment
```

**下载计数规则：**
- HEAD 请求不计数
- 返回 401/403/404 不计数
- 首次 200/206 响应时创建 download_session 并计数一次
- 同一会话后续 Range 请求复用 token，不重复计数
- 会话过期（1小时）后重新计数

### 6.3 传输会话与通道切换

```sql
-- 内存中的 transfer_session（不落库，重启后重新协商）
transfer_session = {
    transfer_id: UUID,
    resource_id: file_id 或 upload_id,
    direction: 'upload' | 'download',
    principal: {type, id},
    
    -- 统一块标识
    chunk_size: 8388608,  -- 8MB
    total_chunks: N,
    completed_ranges: [[start, end], ...],
    
    -- 入口授权
    authorized_entries: [entry_id1, entry_id2],
    current_entry: entry_id,
    
    -- 会话令牌
    session_token: JWT,  -- 绑定 transfer_id, 允许跨入口
    expires_at: timestamp
}
```

**通道切换流程：**
```
1. 客户端从 entry_1 下载，速度低于阈值或断开
2. 客户端请求 /api/v1/transfer/:transfer_id/switch
3. 服务端验证 session_token，返回可用入口列表
4. 客户端用相同 session_token 从 entry_2 发起 Range 请求
   Headers: X-Transfer-Id, X-Entry-Id (由 Nginx 注入)
5. 服务端根据 transfer_id 找到会话，从 completed_ranges 继续
```

### 6.4 智能选路算法

**评分函数（明确无冲突）：**
```
entry_score = 
    (entry.type == 'direct' ? 1000 : 0)      -- 类型权重
    + (1000 - min(latency_ms, 1000))          -- 延迟权重，越低越好
    + (historical_throughput_mbps * 10)       -- 历史吞吐
    - (failure_count * 100)                   -- 失败惩罚

选择 score 最高的 enabled 入口
```

**探测机制：**
- 周期：每 30 秒并行探测所有 enabled 入口
- 方法：GET /api/v1/health?entry_id=xxx（带时间戳）
- 记录：latency_ms + 最近 100MB 下载平均 throughput
- 失败：连续 3 次失败标记不可用，5 分钟后重试

---

## 7. API 接口设计（统一规范）

**版本：** `/api/v1/*`

**错误格式：**
```json
{
    "code": "UPLOAD_EXPIRED",
    "message": "上传会话已经过期",
    "request_id": "req_abc123",
    "details": {}
}
```

### 7.1 认证 `/api/v1/auth/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/auth/init` | 首次初始化（仅当 system_meta 无记录） |
| POST | `/api/v1/auth/login` | 账号密码 → {requires_totp?, session_token?} |
| POST | `/api/v1/auth/totp/verify` | TOTP 验证 → {access_token, refresh_token} |
| POST | `/api/v1/auth/refresh` | Refresh Token 轮换（旧 Token 失效） |
| POST | `/api/v1/auth/token` | API Token 换 JWT |
| GET | `/api/v1/auth/sessions` | 当前账户会话列表 |
| DELETE | `/api/v1/auth/sessions/:id` | 吊销会话 |
| POST | `/api/v1/auth/logout` | 吊销当前会话 |

**Refresh Token 轮换：**
- 每次 refresh 生成新 token，旧 token 标记 revoked
- 检测到已 revoked token 重用，吊销该账户所有会话

### 7.2 文件 `/api/v1/files/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/files` | 列表（分页/搜索/筛选） |
| GET | `/api/v1/files/:id` | 元信息 |
| GET | `/api/v1/files/:id/content` | 管理员下载内容（支持 Range） |
| PATCH | `/api/v1/files/:id` | 更新（有效期/文件夹/文件名） |
| DELETE | `/api/v1/files/:id` | 删除（标记 deleting，异步清理） |
| POST | `/api/v1/files/:id/extend` | 延长过期时间 |

### 7.3 上传 `/api/v1/uploads/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/uploads` | 初始化上传会话 |
| PUT | `/api/v1/uploads/:id/parts/:n` | 上传分块 |
| GET | `/api/v1/uploads/:id` | 查询状态 |
| POST | `/api/v1/uploads/:id/complete` | 完成上传 |
| POST | `/api/v1/uploads/:id/resume` | 恢复会话 |
| DELETE | `/api/v1/uploads/:id` | 中止上传 |

### 7.4 分享 `/api/v1/shares/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/shares` | 管理员列出所有分享 |
| POST | `/api/v1/shares` | 创建分享 |
| GET | `/api/v1/shares/:id` | 获取分享信息（公开） |
| PATCH | `/api/v1/shares/:id` | 修改（密码/次数/有效期） |
| DELETE | `/api/v1/shares/:id` | 吊销分享 |
| POST | `/api/v1/shares/:id/verify` | 验证密码/临时码 → 获取 download_token |
| GET | `/api/v1/shares/:id/access` | 用 token 获取下载授权 |
| GET | `/api/v1/shares/:id/content` | 下载内容（Range 支持） |

### 7.5 直链 `/f/*`（无 API 前缀）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/f/:id/:filename` | 直链下载，支持 Range，Content-Disposition 智能 |

**MIME 白名单（允许 inline）：**
- 图片：jpg, png, gif, webp, avif（**不含 svg**）
- 视频：mp4, webm, mov
- 音频：mp3, wav, ogg, flac
- 文档：pdf
- 纯文本：txt, md（使用独立安全预览页，非直接 inline）

**禁止 inline：**
- svg, html, xml, js, css 等可执行内容，强制 `attachment`

### 7.6 临时码 `/api/v1/temp-codes/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/temp-codes` | 生成 |
| GET | `/api/v1/temp-codes` | 列表 |
| DELETE | `/api/v1/temp-codes/:id` | 吊销 |
| POST | `/api/v1/temp-codes/:id/verify` | 访客验证 → 获取 session_token |

### 7.7 传输 `/api/v1/transfer/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/transfer/entries` | 入口列表（公开，仅返回 id/name/type，不含地址） |
| POST | `/api/v1/transfer/:id/switch` | 请求切换入口 |
| WS | `/ws/transfer` | 进度推送、P2P 信令 |

### 7.8 设置 `/api/v1/settings/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/settings` | 获取配置（公开仅 site 部分） |
| PUT | `/api/v1/settings` | 更新配置 |
| POST | `/api/v1/settings/icon` | 上传 favicon |

### 7.9 统计 `/api/v1/stats/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/stats/storage` | 存储使用统计 |
| GET | `/api/v1/stats/downloads` | 下载统计（时间范围） |

---

## 8. 安全机制详述

### 8.1 密码与令牌安全

| 场景 | 机制 |
|------|------|
| 分享密码 | bcrypt 哈希存储，验证后返回短期 download_token（1小时），不通过 URL 传递 |
| 临时码 | code_id 公开 + code_secret 哈希存储，格式 XXXX-XXXX（ Crockford Base32，128位熵） |
| Refresh Token | 每次轮换，重用检测，绑定设备信息 |
| API Token | 仅存储 SHA-256 哈希，前缀识别，支持 scopes 限制 |

### 8.2 登录保护

```
失败计数维度：
- 账户维度：连续失败 5 次，锁定 15 分钟
- IP 维度：连续失败 10 次，延迟递增响应（不直接封禁，防 NAT 误伤）
- 凭据维度：特定 Token/临时码失败 3 次，临时吊销

信任代理：
- 只信任来自 127.0.0.1 的 X-Forwarded-For
- 可配置 trusted_proxies 列表
```

### 8.3 通道测速 SSRF 防护

```
允许协议：仅 https://
地址检查：
- 禁止 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- 禁止 169.254.0.0/16（云元数据）
- 除非明确配置 allow_private_entries=true
端口限制：仅允许 80, 443, 1024-65535
重定向：禁止跟随重定向
超时：连接 5s，总 10s
响应：不读取 body，仅 HEAD 或 Range: bytes=0-0
```

### 8.4 原子计数

```sql
-- 分享下载计数（原子）
UPDATE shares 
SET used_downloads = used_downloads + 1,
    last_used_at = ?
WHERE id = ? 
  AND status = 'active'
  AND (max_downloads IS NULL OR used_downloads < max_downloads)
  AND (expires_at IS NULL OR expires_at > ?);
-- 检查 affected_rows = 1

-- 临时码使用计数（原子）
UPDATE temp_codes
SET used_count = used_count + 1
WHERE id = ?
  AND status = 'active'
  AND (max_uses IS NULL OR used_count < max_uses)
  AND expires_at > ?;
```

### 8.5 日志脱敏

**禁止记录：**
- 密码、TOTP 码、Token 完整值
- 临时码 secret 完整值
- 分享密码

**脱敏规则：**
- Token 只记录前缀：`token_prefix=abc123***`
- IP 地址可选匿名化（保留 /24）
- 下载日志记录 file_id + share_id，不记录完整 URL

---

## 9. 文件生命周期状态机

```
uploading
    ↓ complete
active ←──────────────┐
    ↓ expires_at 到达  │ extend
expired ──────────────┘
    ↓ cleanup_grace_hours (默认24h) 后
deleting
    ↓ 物理删除成功
deleted
```

**状态语义：**
- `uploading`：上传中，不可访问
- `active`：可正常访问，expires_at 未来时间或 NULL
- `expired`：已过期，不可访问，但可在 grace 期内延长恢复
- `deleting`：正在删除，异步任务处理
- `deleted`：已删除，保留元数据 30 天用于统计，然后硬删除

**清理任务：**
```typescript
@Cron(CronExpression.EVERY_MINUTE)
async cleanup() {
    // 1. 标记过期
    UPDATE files SET status='expired', expired_at=NOW 
    WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= NOW
    
    // 2. 进入删除队列（grace 期后）
    UPDATE files SET status='deleting'
    WHERE status='expired' AND expired_at <= NOW - grace_period
    
    // 3. 物理删除（异步，可重试）
    for file in files.where(status='deleting'):
        try:
            storage.delete(file.stored_name)
            file.status = 'deleted'
            file.deleted_at = NOW
        catch:
            // 保持 deleting，下次重试
}
```

**延长恢复：**
- `POST /files/:id/extend` 可将 `expired` 恢复为 `active`，设置新 expires_at
- 分享状态联动：文件恢复 active 后，关联分享自动恢复（若未手动吊销）

---

## 10. 权限模型（统一）

**核心原则：文件始终私有，公开访问必须通过 shares 表**

| 角色 | 文件操作 | 分享操作 | 说明 |
|------|---------|---------|------|
| 管理员 | 全部 | 全部 | 通过 JWT 认证 |
| 临时码 | 限定 | 不可创建 | permissions JSON 控制：<br>- upload: bool<br>- download_file_ids: []<br>- folder_ids: []<br>- max_files: int |
| 公开访问 | 无 | 通过分享链接 | 仅访问 shares 表中 active 状态的资源 |

**临时码权限示例：**
```json
{
    "upload": true,
    "download_file_ids": ["file_1", "file_2"],
    "folder_ids": ["folder_1"],
    "max_files": 10,
    "expire_hours": 24
}
```

**分享与文件状态联动：**
- 文件过期 → 分享自动失效（查询时判断，不修改 shares 状态）
- 文件恢复 active → 分享自动恢复（若 status='active'）
- 文件删除 → 分享级联删除（ON DELETE CASCADE）

---

## 11. 前端页面结构

### 11.1 路由

| 路径 | 页面 | 权限 |
|------|------|------|
| `/` | 文件管理主页 | 管理员 |
| `/login` | 登录页 | 公开 |
| `/init` | 首次初始化页 | 公开（仅未初始化时） |
| `/s/:id` | 分享页 | 公开 |
| `/f/:id/:filename` | 直链（后端处理） | - |
| `/upload/:code` | 临时码上传页 | 公开 |
| `/settings` | 站点设置 | 管理员 |
| `/devices` | 设备管理（会话+Token+认证器） | 管理员 |
| `/transfers` | 传输状态 | 管理员 |

### 11.2 主页布局（方案A：经典侧边栏）

```
┌────────────────────────────────────────┐
│  [Logo] FileStation          [用户▼]   │
├──────────┬─────────────────────────────┤
│          │  📁 收件箱 > 项目A           │
│  📤 上传  │  ─────────────────────────  │
│  ─────── │                             │
│  📁 收件箱│  当前位置: 3个文件            │
│  📁 项目A │  ┌────┬────┬────┬────┐    │
│  📁 项目B │  │名称│大小│过期│操作│    │
│  📁 归档  │  ├────┼────┼────┼────┤    │
│  ➕ 新建  │  │doc │2MB │2h │ ↓ ⋮│    │
│  ─────── │  │img │5MB │∞  │ ↓ ⋮│    │
│  ⏰ 临时  │  │zip │1GB │1d │ ↓ ⋮│    │
│  ♾️ 永久  │  └────┴────┴────┴────┘    │
│  🗑️ 已过期│                             │
│  ─────── │  [+ 拖拽文件到此处上传]        │
│  📊 统计  │                             │
│  已用 2.1G│                             │
│  ─────── │                             │
│  ⚙️ 设置  │                             │
└──────────┴─────────────────────────────┘
```

**文件右键菜单（无"公开"状态，统一为分享）：**
- 下载
- 分享... → 创建分享链接
- 移动到...
- 重命名
- 有效期设置...
- 下载统计
- 删除

**有效期设置弹窗：**
- 临时文件（自定义小时数）
- 永久保留（expires_at = NULL）
- 自定义具体时间
- 快速操作：+1天/+1周/+1月

**分享创建弹窗：**
```
┌─────────────────────────────┐
│  分享文件: report.pdf        │
├─────────────────────────────┤
│  类型:                      │
│  ○ 分享页（显示信息卡片）     │
│  ○ 直链（浏览器直接预览）     │
│                             │
│  保护:                      │
│  ○ 免密 - 知道链接即可访问    │
│  ○ 密码 - 需要输入密码        │
│  ○ 管理员 - 仅登录管理员可访问 │
│                             │
│  [ ] 限制下载次数: [ 10 ]    │
│  [ ] 链接有效期: [ 7 ] 天     │
│                             │
│        [取消]  [生成链接]     │
└─────────────────────────────┘
```

### 11.3 设备管理页 `/devices`

三个标签页：
- **登录会话**：当前有效的 Refresh Token 会话，可吊销
- **API Token**：长期凭据列表，可创建/吊销，显示 scopes
- **认证器**：TOTP 和 WebAuthn 设备，可注册/删除

### 11.4 设置页标签

| 标签 | 内容 |
|------|------|
| 基本 | 站点名称、默认过期时间、最大文件大小 |
| 安全 | TOTP 开关、登录保护策略、API Token 管理入口 |
| 传输 | 入口管理（添加/编辑/测试延迟）、选路策略、全局限速 |
| 存储 | 存储路径、清理宽限期、磁盘配额 |
| 外观 | favicon、主题色、浏览器标签标题 |

---

## 12. 开发里程碑（四阶段）

### Phase 1: MVP（2周）

**目标：** 单管理员基础文件站

- [ ] 项目脚手架（NestJS + React + SQLite）
- [ ] 首次初始化（创建管理员账户）
- [ ] 账号密码登录 + JWT
- [ ] 文件上传（HTTP 分块）/下载（Range）
- [ ] 文件夹 CRUD
- [ ] 文件有效期 + 自动过期
- [ ] 分享链接（page 类型，免密/密码）
- [ ] 基础设置页

**验收标准：**
- 可通过 WebUI 上传下载文件
- 可创建密码保护分享
- 文件到期自动过期

### Phase 2: 可靠性（2周）

**目标：** 生产可用，数据安全

- [ ] Refresh Token 轮换 + 会话管理
- [ ] TOTP 认证
- [ ] API Token
- [ ] 断点续传（上传会话恢复）
- [ ] 下载会话（Range 不重复计数）
- [ ] 文件删除异步化（deleting→deleted）
- [ ] 原子计数（下载次数/临时码次数）
- [ ] 审计日志
- [ ] 并发测试 + 压力测试

### Phase 3: 多入口传输（2周）

**目标：** 多 FRP 地址智能选路

- [ ] 入口管理（CRUD + 探测）
- [ ] Nginx 配置生成/指导
- [ ] 智能选路算法
- [ ] 下载通道切换（Range 续传）
- [ ] 上传跨入口恢复
- [ ] 入口限速
- [ ] 直链分享（direct 类型）

### Phase 4: 增强功能（2周）

**目标：** 完整功能集

- [ ] WebAuthn
- [ ] P2P 传输（WebRTC）
- [ ] 临时码（访客上传/下载）
- [ ] 文件夹分享
- [ ] 统计面板
- [ ] 多语言

**总计：8周（比原计划的16天更现实）**

---

## 13. 项目结构

```
filestation-webservice/
├── package.json
├── apps/
│   ├── server/                 # NestJS
│   │   ├── src/
│   │   │   ├── auth/
│   │   │   ├── accounts/
│   │   │   ├── files/
│   │   │   ├── folders/
│   │   │   ├── uploads/
│   │   │   ├── shares/
│   │   │   ├── temp-codes/
│   │   │   ├── transfer/
│   │   │   ├── settings/
│   │   │   ├── stats/
│   │   │   └── main.ts
│   │   └── package.json
│   └── web/                    # React
│       ├── src/
│       │   ├── pages/
│       │   ├── components/
│       │   ├── hooks/
│       │   └── stores/
│       └── package.json
├── packages/
│   └── shared/                 # 共享类型
│       └── types.ts
├── data/                       # 运行时数据
│   ├── filestation.db
│   ├── storage/               # 文件存储
│   └── temp/                  # 上传临时文件
├── nginx/
│   └── filestation.conf       # Nginx 配置示例
├── docs/
│   └── superpowers/specs/
│       └── 2026-07-28-filestation-design.md  # 本文档
└── README.md
```

---

## 14. 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 文件公开方式 | 统一走 shares 表 | 避免文件级 ACL 复杂度，单管理员模式足够 |
| 上传协议 | HTTP 分块 | 比 WebSocket 更稳定，Nginx/FRP 兼容性好 |
| 断点续传 | upload_sessions 表 | 明确状态，支持恢复和清理 |
| 下载计数 | download_sessions 表 | Range 请求不重复计数 |
| 权限模型 | 文件私有 + shares 公开 | 简单清晰，满足需求 |
| 入口识别 | Nginx X-Entry-Id | 服务端可信识别，防伪造 |
| 限速单位 | bytes_per_second | 内部统一，前端转换显示 |
| 开发策略 | 四阶段，P2P 最后 | 先稳定核心，再扩展复杂功能 |

---

*文档版本: v2.0*
*创建日期: 2026-07-28*
*审阅状态: 已根据 AI 审阅意见全面修正*
