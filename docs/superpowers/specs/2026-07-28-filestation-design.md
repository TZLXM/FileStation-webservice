# FileStation 文件传输站 - 设计文档 v2.1

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

**v2.1 核心修正：**
- 部署图修正：FRP 流量方向正确，Nginx 覆盖 X-Entry-Id
- 初始化安全：本机限制 + 一次性 Token + 事务保护
- 认证 API 补全：TOTP/WebAuthn/API Token/密码管理完整端点
- 上传协议闭合：upload_token_hash，complete 幂等，状态权威来源唯一
- 临时码安全：128 位熵（26 字符 Base32），Argon2id 哈希
- 直链规则明确：direct 仅限 protection=none，密码/管理员用分享页
- 数据库修正：部分唯一索引解决 NULL 问题，外键级联补全

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
| 密码哈希 | bcrypt (密码), Argon2id (临时码 secret) | 不同场景不同算法 |

---

## 3. 部署架构（信任边界明确）

### 3.1 正确流量方向

**FRP 入口：**
```
浏览器
  → 公网 frps (用户自有的公网服务器)
  → 本地 frpc (用户自建的端口转发)
  → 本地 Nginx (TLS 终结 + 入口识别)
  → Unix Socket / 127.0.0.1:8080 Node.js
```

**直连入口：**
```
浏览器
  → 本地 Nginx
  → Unix Socket / 127.0.0.1:8080 Node.js
```

### 3.2 Nginx 配置关键要求

```nginx
# 每个 server 块必须覆盖而非保留客户端 Header
proxy_set_header X-Entry-Id "entry_1";  # 覆盖，非保留

# 关闭缓冲以支持应用层流式限速
proxy_request_buffering off;
proxy_buffering off;

# 其他安全头
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Host $host;
```

**Node.js 绑定：**
- 默认：`127.0.0.1:8080`
- 推荐：Unix Socket `/tmp/filestation.sock`（进一步隔离）
- 仅信任来自 Nginx 的 `X-Entry-Id`，客户端提交的同名 Header 被 Nginx 覆盖

### 3.3 多入口与 WebAuthn

- **管理员入口**：固定一个主域名（如 `admin.example.com`）作为 WebAuthn RP ID
- **传输入口**：其他 FRP 域名仅用于文件传输，不用于 WebAuthn 注册/登录
- 避免多域名分别注册 Passkey 的复杂度

---

## 4. 初始化安全机制

### 4.1 初始化流程（防抢占）

**方式一：本机限制（推荐默认）**
```
POST /api/v1/auth/init
仅当请求来自 127.0.0.1 时接受
```

**方式二：一次性 Token**
```
启动时控制台输出：
=================================================
FileStation 首次启动
初始化 Token: init_a1b2c3d4e5f6...
有效期: 10 分钟
请访问 http://localhost:8080/init 完成设置
=================================================

POST /api/v1/auth/init
Headers: X-Init-Token: init_a1b2c3d4e5f6...
```

**方式三：环境变量**
```bash
FILESTATION_INIT_TOKEN=init_a1b2c3d4e5f6 npm start
```

### 4.2 事务保护

```sql
BEGIN IMMEDIATE;

-- 检查是否已初始化
SELECT value FROM system_meta WHERE key = 'initialized_at';
-- 若存在，ROLLBACK

-- 创建管理员账户
INSERT INTO admin_accounts (...) VALUES (...);

-- 标记已初始化
INSERT INTO system_meta (key, value) VALUES ('initialized_at', ?), ('first_account_id', ?);

COMMIT;
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
    id TEXT PRIMARY KEY,
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
    name TEXT NOT NULL,
    
    -- TOTP 专用
    totp_secret_encrypted TEXT,       -- AES-256-GCM
    
    -- WebAuthn 专用
    credential_id TEXT UNIQUE,
    public_key TEXT,
    sign_count INTEGER DEFAULT 0,
    transports TEXT,
    
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    is_active INTEGER DEFAULT 1
);

-- API Token
CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    name TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,         -- SHA-256
    scopes TEXT NOT NULL,             -- JSON: ["files:read", "files:write"]
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_used_ip TEXT,
    revoked_at INTEGER
);

-- 登录会话
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    refresh_token_hash TEXT NOT NULL,
    device_info TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    
    UNIQUE(refresh_token_hash)
);

-- 一次性恢复码（紧急访问）
CREATE TABLE recovery_codes (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    code_hash TEXT NOT NULL,          -- Argon2id
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL       -- 生成后 24 小时
);

-- 系统元数据
CREATE TABLE system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

### 5.2 文件与文件夹（修正唯一约束）

```sql
CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    is_deleted INTEGER DEFAULT 0
);

-- 修正：部分唯一索引解决 NULL 不等于 NULL 问题
CREATE UNIQUE INDEX uq_folder_child_name 
ON folders(parent_id, name) 
WHERE parent_id IS NOT NULL AND is_deleted = 0;

CREATE UNIQUE INDEX uq_folder_root_name 
ON folders(name) 
WHERE parent_id IS NULL AND is_deleted = 0;

CREATE TABLE files (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES folders(id),
    filename TEXT NOT NULL,
    stored_name TEXT UNIQUE NOT NULL,
    size INTEGER NOT NULL CHECK(size >= 0),
    mime_type TEXT,
    hash_sha256 TEXT,
    
    -- 生命周期（移除 uploading 状态，上传完成才创建记录）
    status TEXT NOT NULL DEFAULT 'active' 
        CHECK(status IN ('active', 'expired', 'deleting', 'deleted')),
    expires_at INTEGER,
    expired_at INTEGER,
    deleted_at INTEGER,
    
    -- 来源
    uploaded_by_type TEXT NOT NULL CHECK(uploaded_by_type IN ('admin', 'temp_code')),
    uploaded_by_id TEXT NOT NULL,
    upload_ip TEXT,
    
    -- 统计
    download_count INTEGER DEFAULT 0,
    last_download_at INTEGER,
    
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_status_expires ON files(status, expires_at);
CREATE INDEX idx_files_created ON files(created_at);
CREATE INDEX idx_folders_parent ON folders(parent_id);
```

### 5.3 上传会话（补全 Token 字段）

```sql
CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY,
    upload_token_hash TEXT UNIQUE NOT NULL,  -- 新增：上传凭据
    
    filename TEXT NOT NULL,
    expected_size INTEGER NOT NULL,
    expected_hash TEXT,
    chunk_size INTEGER NOT NULL,
    
    -- 状态
    status TEXT NOT NULL DEFAULT 'initiated'
        CHECK(status IN ('initiated', 'uploading', 'verifying', 'completed', 'aborted', 'expired', 'failed')),
    
    -- 权威来源：upload_parts 表，received_size 为缓存
    received_size INTEGER DEFAULT 0,  -- 缓存，与 upload_parts 事务同步
    
    -- 存储
    temp_path TEXT NOT NULL,
    
    -- 来源
    principal_type TEXT NOT NULL CHECK(principal_type IN ('admin', 'temp_code')),
    principal_id TEXT NOT NULL,
    
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    completed_at INTEGER
);

-- 分块记录（唯一权威来源）
CREATE TABLE upload_parts (
    upload_id TEXT NOT NULL REFERENCES upload_sessions(id),
    part_number INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    size INTEGER NOT NULL,
    checksum TEXT NOT NULL,           -- 分块 SHA-256，必填
    received_at INTEGER NOT NULL,
    
    PRIMARY KEY (upload_id, part_number)
);

-- 索引
CREATE INDEX idx_upload_sessions_token ON upload_sessions(upload_token_hash);
CREATE INDEX idx_upload_sessions_status ON upload_sessions(status, expires_at);
```

**上传完成事务（幂等）：**
```sql
BEGIN IMMEDIATE;

-- 1. 检查状态，防止并发 complete
SELECT status FROM upload_sessions WHERE id = ? FOR UPDATE;
-- 若已是 completed/verifying，返回已有 file_id

-- 2. 验证所有分块
SELECT COUNT(*), SUM(size) FROM upload_parts WHERE upload_id = ?;
-- 校验总数、总大小、连续性

-- 3. 更新状态为 verifying
UPDATE upload_sessions SET status = 'verifying' WHERE id = ?;

-- 4. 验证最终哈希（如提供）
-- 5. 移动临时文件到正式存储
-- 6. 原子创建 files 记录（status='active'）
INSERT INTO files (...) VALUES (...);

-- 7. 标记完成
UPDATE upload_sessions SET status = 'completed', completed_at = ?, final_file_id = ? WHERE id = ?;

COMMIT;
```

### 5.4 分享与下载会话（补全级联）

```sql
CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,  -- 补全级联
    
    -- 类型：page=分享页，direct=直链（仅限 protection=none）
    type TEXT NOT NULL CHECK(type IN ('page', 'direct')),
    
    -- 保护方式（direct 类型只允许 none）
    protection TEXT NOT NULL DEFAULT 'none' 
        CHECK(protection IN ('none', 'password', 'admin')),
    password_hash TEXT,
    
    -- 限制
    max_downloads INTEGER,
    used_downloads INTEGER DEFAULT 0,
    
    -- 状态（派生状态：active/revoked 持久化，exhausted/expired 查询时计算）
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    last_used_at INTEGER
);

-- 下载会话（授权阶段创建，counted=0）
CREATE TABLE download_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id),
    file_id TEXT NOT NULL REFERENCES files(id),
    
    token_hash TEXT NOT NULL,
    
    counted INTEGER DEFAULT 0,
    counted_at INTEGER,
    
    first_range_start INTEGER,
    last_range_end INTEGER,
    total_bytes_sent INTEGER DEFAULT 0,
    
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    
    UNIQUE(token_hash)
);

CREATE INDEX idx_shares_file ON shares(file_id);
CREATE INDEX idx_shares_status ON shares(status, expires_at);
CREATE INDEX idx_download_sessions_share ON download_sessions(share_id);
```

**直链类型约束：**
- `type='direct'` 必须满足 `protection='none'`
- 密码保护和管理员保护必须使用 `type='page'`
- 前端创建分享时强制此规则

### 5.5 临时码（128 位熵）

```sql
CREATE TABLE temp_codes (
    id TEXT PRIMARY KEY,              -- code_id，公开部分，8 字符
    code_secret_hash TEXT NOT NULL,   -- Argon2id(secret)，26 字符 Base32 = 130 bit
    label TEXT,
    
    permissions TEXT NOT NULL,        -- JSON Schema 校验
    
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    rate_limit_bps INTEGER,
    
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'revoked')),  -- exhausted/expired 派生
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

-- 临时码格式：XXXX-XXXX.XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX
-- code_id: 8 字符 Crockford Base32（40 bit，用于标识）
-- code_secret: 26 字符 Crockford Base32（130 bit，用于验证）

-- 临时码会话（一次授权，事务内创建）
CREATE TABLE temp_code_sessions (
    id TEXT PRIMARY KEY,
    temp_code_id TEXT NOT NULL REFERENCES temp_codes(id),
    session_token_hash TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    
    UNIQUE(session_token_hash)
);
```

**临时码验证事务：**
```sql
BEGIN IMMEDIATE;

-- 1. 原子增加使用计数
UPDATE temp_codes 
SET used_count = used_count + 1
WHERE id = ? 
  AND status = 'active'
  AND (max_uses IS NULL OR used_count < max_uses)
  AND expires_at > ?;
-- 检查 affected_rows = 1

-- 2. 创建会话
INSERT INTO temp_code_sessions (...) VALUES (...);

COMMIT;
```

### 5.6 传输入口（修正 P2P 兼容性）

```sql
CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('direct', 'frp')),  -- v2.1 移除 p2p，Phase 4 再添加
    name TEXT NOT NULL,
    
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    entry_id TEXT UNIQUE NOT NULL,    -- Nginx X-Entry-Id 对应值
    
    public_base_url TEXT NOT NULL,    -- 新增：客户端访问的公网地址
    
    is_enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    
    last_check_at INTEGER,
    last_latency_ms INTEGER,
    last_throughput_bps INTEGER,
    failure_count INTEGER DEFAULT 0,
    
    upload_rate_limit_bps INTEGER,    -- 分离上传下载限速
    download_rate_limit_bps INTEGER
);
```

### 5.7 传输事件统计（新增）

```sql
CREATE TABLE transfer_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('upload', 'download')),
    file_id TEXT REFERENCES files(id),
    share_id TEXT REFERENCES shares(id),
    entry_id TEXT REFERENCES entries(id),
    principal_type TEXT NOT NULL,
    principal_id TEXT,
    bytes_transferred INTEGER NOT NULL,
    duration_ms INTEGER,
    occurred_at INTEGER NOT NULL
);

-- 按小时聚合（可选，避免事件表过大）
CREATE TABLE transfer_stats_hourly (
    hour_timestamp INTEGER NOT NULL,  -- 小时级时间戳
    entry_id TEXT,
    upload_bytes INTEGER DEFAULT 0,
    download_bytes INTEGER DEFAULT 0,
    upload_count INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    
    PRIMARY KEY (hour_timestamp, entry_id)
);

CREATE INDEX idx_transfer_events_time ON transfer_events(occurred_at);
CREATE INDEX idx_transfer_events_file ON transfer_events(file_id);
```

### 5.8 审计日志（新增）

```sql
CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    account_id TEXT REFERENCES admin_accounts(id),
    action TEXT NOT NULL,             -- 'auth.login', 'file.upload', 'share.create', etc.
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,                     -- JSON，脱敏后
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_logs_account ON audit_logs(account_id, created_at);
CREATE INDEX idx_audit_logs_action ON audit_logs(action, created_at);

-- 保留策略：90 天，定期清理
```

### 5.9 系统配置

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES admin_accounts(id)
);

-- 预置键：
-- site: {name, icon, theme_color}
-- security: {totp_required, max_login_attempts, lockout_minutes, recovery_codes_count}
-- transfer: {default_chunk_size, global_upload_limit_bps, global_download_limit_bps,
--            role_limits: {admin:0, temp_code:10485760, public:5242880}}
-- storage: {path, max_size_gb, cleanup_grace_hours, default_expire_hours}
```

---

## 6. 核心协议设计

### 6.1 上传协议（HTTP 分块，完整闭合）

```
1. 初始化
   POST /api/v1/uploads
   {filename, size, hash?, chunk_size?}
   ← {upload_id, upload_token, chunk_size, expires_at}
   
   upload_token 仅返回一次，绑定 upload_id + principal + 有效期

2. 上传分块（幂等）
   PUT /api/v1/uploads/:id/parts/:part_number
   Headers: X-Upload-Token, Content-Range, X-Part-Checksum
   Body: binary chunk
   ← 200 {received: true, part_checksum} 
      或 409 {received: false, expected_checksum, received_checksum}

3. 查询状态
   GET /api/v1/uploads/:id
   Headers: X-Upload-Token
   ← {status, received_parts: [0,1,2,5], received_size, total_parts}

4. 完成上传（幂等）
   POST /api/v1/uploads/:id/complete
   Headers: X-Upload-Token
   {final_hash?}
   ← {file_id, status: 'active'}
      或 200 {file_id} (已 completed 时)
      或 409 {status: 'verifying'} (另一个请求正在完成)

5. 中止上传
   DELETE /api/v1/uploads/:id
   Headers: X-Upload-Token

6. 恢复上传
   POST /api/v1/uploads/:id/resume
   Headers: X-Upload-Token
   ← {received_parts, chunk_size}
```

**状态权威来源：**
- `upload_parts` 表是分块记录的唯一权威来源
- `upload_sessions.received_size` 是缓存值，在同一事务中更新
- 查询时优先查 `upload_parts`，`received_size` 仅用于快速展示

**Files 记录创建时机：**
- 上传期间只存在 `upload_sessions`，不创建 `files`
- `complete` 事务中验证通过后，原子创建 `files(status='active')`
- 移除 `files.status='uploading'` 状态

### 6.2 下载协议（明确规则）

**规则：**
- `type='direct'` 必须 `protection='none'`
- 密码保护和管理员保护必须使用 `type='page'`，验证后获取 download_token

```
1. 分享页访问（protection=none）
   GET /s/:id
   ← HTML 页面，点击下载跳转 /api/v1/shares/:id/content

2. 分享页访问（protection=password）
   GET /s/:id
   ← HTML 页面，输入密码
   POST /api/v1/shares/:id/verify
   {password}
   ← {download_token, expires_at, file_info}
   
   GET /api/v1/shares/:id/content
   Headers: Authorization: Bearer <download_token>, Range: bytes=...
   ← 206 Partial Content

3. 直链访问（type=direct, protection=none）
   GET /f/:id/:filename
   Headers: Range: bytes=...
   ← 206 / 200，Content-Disposition: inline/attachment
```

**下载计数（事务）：**
```sql
BEGIN IMMEDIATE;

-- 1. 原子增加分享计数
UPDATE shares 
SET used_downloads = used_downloads + 1,
    last_used_at = ?
WHERE id = ? 
  AND status = 'active'
  AND (max_downloads IS NULL OR used_downloads < max_downloads)
  AND (expires_at IS NULL OR expires_at > ?);
-- 检查 affected_rows = 1，否则返回 410 Gone

-- 2. 标记下载会话已计数
UPDATE download_sessions 
SET counted = 1, counted_at = ?
WHERE id = ? AND counted = 0;

COMMIT;

-- 3. 开始发送内容
```

### 6.3 传输会话与通道切换（客户端探测）

**入口信息分发：**
```json
GET /api/v1/transfer/entries
← {
    "entries": [
        {
            "id": "entry_1",
            "name": "FRP 北京",
            "type": "frp",
            "public_base_url": "https://bj.example.com"
        },
        {
            "id": "entry_2", 
            "name": "直连",
            "type": "direct",
            "public_base_url": "https://local.example.com"
        }
    ]
}
```

**客户端探测流程：**
```
1. 浏览器并行请求各入口探测地址
   GET {public_base_url}/api/v1/health?client_probe=1
   （Nginx 注入 X-Entry-Id，服务端验证匹配）

2. 浏览器测量 RTT，可选小规模下载测速（如 1MB）

3. 浏览器选择最优入口，请求传输授权
   POST /api/v1/transfer/prepare
   {resource_id, direction, preferred_entry_id, client_metrics}
   ← {transfer_id, session_token, authorized_entries, chunk_size}

4. 浏览器从优选入口开始传输
   GET {entry_url}/api/v1/shares/:id/content
   Headers: X-Transfer-Id, Authorization: Bearer <session_token>

5. 速度低于阈值或断开时，请求切换
   POST /api/v1/transfer/:transfer_id/switch
   {current_entry_id, reason, client_metrics}
   ← {recommended_entry_id, session_token} (新 token 或原 token 续期)

6. 浏览器从新入口继续，使用相同 session_token + Range 头
```

**服务端入口验证：**
- 查询参数 `?entry_id=xxx` 不可信
- 必须比较 Nginx 注入的 `X-Entry-Id` 与目标入口
- 不匹配则拒绝或重新标记

### 6.4 智能选路算法（客户端主导）

```
客户端评分：
entry_score = 
    rtt_score (40%)           -- 客户端实测 RTT
    + throughput_score (40%)  -- 客户端实测吞吐（如已测）
    + entry_priority (20%)    -- 服务端配置优先级

选择 score 最高的入口
```

---

## 7. API 接口设计（完整）

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

### 7.1 认证 `/api/v1/auth/*`（补全）

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/auth/init` | 首次初始化（本机限制或 Token） |
| POST | `/api/v1/auth/login` | 账号密码 |
| POST | `/api/v1/auth/refresh` | Refresh Token 轮换 |
| POST | `/api/v1/auth/logout` | 吊销当前会话 |
| GET | `/api/v1/auth/sessions` | 会话列表 |
| DELETE | `/api/v1/auth/sessions/:id` | 吊销会话 |
| **密码管理** | | |
| POST | `/api/v1/auth/password/change` | 修改密码 |
| **TOTP 管理** | | |
| POST | `/api/v1/auth/totp/setup` | 生成 TOTP 密钥和二维码 |
| POST | `/api/v1/auth/totp/confirm` | 验证并启用 TOTP |
| DELETE | `/api/v1/auth/authenticators/:id` | 删除认证器（TOTP/WebAuthn） |
| **WebAuthn 管理** | | |
| POST | `/api/v1/auth/webauthn/register/options` | 生成注册选项 |
| POST | `/api/v1/auth/webauthn/register/verify` | 验证注册 |
| POST | `/api/v1/auth/webauthn/login/options` | 生成登录选项 |
| POST | `/api/v1/auth/webauthn/login/verify` | 验证登录 |
| **API Token 管理** | | |
| GET | `/api/v1/auth/api-tokens` | Token 列表 |
| POST | `/api/v1/auth/api-tokens` | 创建 Token |
| DELETE | `/api/v1/auth/api-tokens/:id` | 吊销 Token |
| **恢复机制** | | |
| POST | `/api/v1/auth/recovery/generate` | 生成一次性恢复码 |
| POST | `/api/v1/auth/recovery/verify` | 使用恢复码重置 2FA |

**API Token JWT 声明：**
```json
{
    "principal_type": "api_token",
    "principal_id": "token_xxx",
    "scopes": ["files:read", "files:write"],
    "account_id": "admin_xxx"
}
```
- 与管理员 JWT 区分，Guard 检查 scopes

### 7.2 文件 `/api/v1/files/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/files` | 列表 |
| GET | `/api/v1/files/:id` | 元信息 |
| GET | `/api/v1/files/:id/content` | 管理员下载（临时码会话也可访问，检查 download_file_ids） |
| PATCH | `/api/v1/files/:id` | 更新 |
| DELETE | `/api/v1/files/:id` | 删除 |
| POST | `/api/v1/files/:id/extend` | 延长过期 |

### 7.3 上传 `/api/v1/uploads/*`（已详述）

### 7.4 分享 `/api/v1/shares/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/shares` | 管理员列出 |
| POST | `/api/v1/shares` | 创建 |
| GET | `/api/v1/shares/:id` | 公开信息 |
| PATCH | `/api/v1/shares/:id` | 修改 |
| DELETE | `/api/v1/shares/:id` | 吊销 |
| POST | `/api/v1/shares/:id/verify` | 验证密码 |
| GET | `/api/v1/shares/:id/content` | 下载内容 |

### 7.5 直链 `/f/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/f/:id/:filename` | 直链，仅限 protection=none |

### 7.6 临时码 `/api/v1/temp-codes/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/temp-codes` | 生成 |
| GET | `/api/v1/temp-codes` | 列表 |
| DELETE | `/api/v1/temp-codes/:id` | 吊销 |
| POST | `/api/v1/temp-codes/verify` | 验证 code_id + code_secret |

### 7.7 传输 `/api/v1/transfer/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/transfer/entries` | 入口列表（含 public_base_url） |
| POST | `/api/v1/transfer/prepare` | 准备传输 |
| POST | `/api/v1/transfer/:id/switch` | 切换入口 |

### 7.8 设置 `/api/v1/settings/*`

### 7.9 统计 `/api/v1/stats/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/v1/stats/storage` | 存储统计 |
| GET | `/api/v1/stats/transfers` | 传输统计（时间范围，基于 transfer_events） |
| GET | `/api/v1/stats/downloads` | 下载统计 |

---

## 8. 安全机制（补全）

### 8.1 密码与令牌安全

| 场景 | 机制 |
|------|------|
| 管理员密码 | bcrypt，修改需验证当前密码 |
| 分享密码 | bcrypt，验证后返回短期 download_token |
| 临时码 secret | Argon2id，130 bit 熵 |
| API Token | SHA-256，scopes 限制，JWT 声明区分 |
| Refresh Token | 轮换 + 重用检测 |
| 恢复码 | Argon2id，一次性，24 小时有效期 |

### 8.2 登录保护

- 账户维度：连续失败 5 次锁定 15 分钟
- IP 维度：连续失败 10 次延迟递增
- 凭据维度：特定 Token/临时码失败 3 次临时吊销
- 恢复码：使用一次即作废，同时吊销所有会话

### 8.3 原子计数（所有场景）

- 分享下载：UPDATE ... WHERE counted=0
- 临时码使用：UPDATE ... WHERE used_count < max_uses
- 上传完成：BEGIN IMMEDIATE 状态检查

### 8.4 日志脱敏

- 禁止记录：密码、TOTP、完整 Token、临时码 secret
- 脱敏：Token 前缀、IP /24 匿名化
- 审计日志：90 天保留，定期清理

---

## 9. 文件生命周期（最终）

```
active ←──────────────┐
    ↓ expires_at 到达  │ extend
expired ──────────────┘
    ↓ cleanup_grace_hours (默认 24h) 后
deleting
    ↓ 物理删除成功
deleted (保留 30 天元数据，然后硬删除)
```

**分享联动：**
- 文件 expired → 分享查询时判断文件状态，拒绝访问
- 文件恢复 active → 分享自动恢复访问（若 status='active'）
- 文件 deleted → 30 天后硬删除时级联删除分享（ON DELETE CASCADE）

---

## 10. 开发里程碑（四阶段，修正）

### Phase 1: MVP（2 周）

- [ ] 项目脚手架
- [ ] 安全初始化（本机限制 + 一次性 Token）
- [ ] 账号密码登录 + JWT + Refresh Token
- [ ] 文件上传（HTTP 分块 + upload_token）/下载（Range）
- [ ] 文件夹 CRUD（部分唯一索引）
- [ ] 文件有效期 + 自动过期
- [ ] 分享链接（page 类型，免密/密码）
- [ ] 基础设置页

**验收：** 本机初始化后，可通过 WebUI 完整使用基础功能

### Phase 2: 可靠性（2 周）

- [ ] TOTP 认证
- [ ] API Token（scopes 限制）
- [ ] 恢复码机制
- [ ] 断点续传（完整上传协议）
- [ ] 下载会话（Range 不重复计数）
- [ ] 原子计数
- [ ] 审计日志
- [ ] 并发/压力测试

### Phase 3: 多入口传输（2 周）

- [ ] 入口管理（public_base_url）
- [ ] 客户端探测与选路
- [ ] Nginx 配置生成
- [ ] 跨入口授权与切换
- [ ] 入口限速
- [ ] 直链分享（direct 类型）

### Phase 4: 增强功能（2 周）

- [ ] WebAuthn（主域名固定）
- [ ] P2P 传输（entries 表迁移）
- [ ] 临时码（完整功能）
- [ ] 文件夹分享
- [ ] 统计面板（transfer_events）

---

## 11. 关键设计决策记录（v2.1 更新）

| 决策 | 选择 | 理由 |
|------|------|------|
| 初始化安全 | 本机限制 + 一次性 Token + 事务 | 防抢占 |
| 上传凭据 | upload_token_hash | 绑定会话，防未授权分块上传 |
| 分块权威来源 | upload_parts 表 | 避免多源不一致 |
| Files 创建时机 | complete 事务中 | 避免 uploading 状态残留 |
| 直链规则 | direct 仅限 protection=none | 简化模型，避免密码直链矛盾 |
| 临时码熵 | 130 bit（26 字符 Base32） | 抵御离线枚举 |
| 文件夹唯一约束 | 部分唯一索引 | 解决 NULL 问题 |
| 分享状态 | active/revoked 持久化，exhausted/expired 派生 | 避免状态不一致 |
| 入口探测 | 客户端主导 | 反映真实用户网络状况 |
| API Token JWT | 区分 principal_type，强制 scopes | 防权限提升 |

---

*文档版本: v2.1*
*创建日期: 2026-07-28*
*审阅状态: 已根据 AI 审阅意见二次修正，协议闭合*
