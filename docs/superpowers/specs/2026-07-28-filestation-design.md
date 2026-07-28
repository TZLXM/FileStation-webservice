# FileStation 文件传输站 - 设计文档 v2.2

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

**v2.2 核心修正：**
- SQLite 兼容性：移除 FOR UPDATE，改用条件更新抢占
- 上传完成：三阶段分离，避免长事务阻塞
- 初始化安全：Nginx 层限制 + 一次性 Token，Node 不判断 127.0.0.1
- 下载计数：先抢占 download_session 计数权，再扣减分享额度
- 免密分享/直链：统一 access 流程，302 重定向带 Token
- 外键级联：download_sessions/transfer_events/upload_parts 补全
- 认证缺口：登录 TOTP/WebAuthn challenge，API Token 交换端点
- 数据库约束：CHECK 约束补全，防前端绕过
- 上传分块：单文件存储改分块文件，崩溃恢复定义
- CORS：Phase 3 多入口跨域设计
- 存储路径：环境变量控制，非热更新
- 文件夹删除：MVP 仅允许删除空文件夹
- 临时码配额：reserved_files/completed_files 原子预留
- 安全预览：MIME 白名单恢复，CSP sandbox

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
| 密码哈希 | bcrypt (密码), Argon2id (临时码 secret/恢复码) | 不同场景不同算法 |

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

# 初始化端点本机限制（关键：Node 不判断 127.0.0.1）
location = /api/v1/auth/init {
    allow 127.0.0.1;
    allow ::1;
    deny all;
    proxy_pass http://filestation;
}

# 其他安全头
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Host $host;
```

**Node.js 绑定：**
- 默认：`127.0.0.1:8080`
- 推荐：Unix Socket `/tmp/filestation.sock`（进一步隔离）
- 仅信任来自 Nginx 的 `X-Entry-Id`

### 3.3 初始化安全（Nginx 层 + Token 双保险）

**方式：Nginx allow/deny + 一次性 Token**
```
启动时控制台输出：
=================================================
FileStation 首次启动
初始化 Token: init_a1b2c3d4e5f6...
有效期: 10 分钟
请通过本机访问 http://localhost:8080/init 完成设置
=================================================
```

- Nginx 限制 `/api/v1/auth/init` 仅本机可访问
- Node 验证 `X-Init-Token` 头
- 事务保护防并发

---

## 4. 数据库 Schema (SQLite)

**统一规范：**
- 时间字段：Unix 毫秒 (INTEGER)，UTC
- API 返回：ISO 8601 字符串
- 限速单位：bytes_per_second (INTEGER)，NULL=跟随上级，0=不限
- 外键：仅列级声明，启用 `PRAGMA foreign_keys = ON`

### 4.1 认证与账户

```sql
CREATE TABLE admin_accounts (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_changed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE authenticators (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    type TEXT NOT NULL CHECK(type IN ('totp', 'webauthn')),
    name TEXT NOT NULL,
    totp_secret_encrypted TEXT,
    credential_id TEXT UNIQUE,
    public_key TEXT,
    sign_count INTEGER DEFAULT 0,
    transports TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    name TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_used_ip TEXT,
    revoked_at INTEGER
);

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

CREATE TABLE recovery_codes (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE login_challenges (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES admin_accounts(id),
    challenge_type TEXT NOT NULL CHECK(challenge_type IN ('totp', 'webauthn')),
    challenge_data TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE TABLE system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

### 4.2 文件与文件夹

```sql
CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    is_deleted INTEGER DEFAULT 0,
    deleted_at INTEGER  -- 新增：软删除时间
);

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
    status TEXT NOT NULL DEFAULT 'active' 
        CHECK(status IN ('active', 'expired', 'deleting', 'deleted')),
    expires_at INTEGER,
    expired_at INTEGER,
    deleted_at INTEGER,
    uploaded_by_type TEXT NOT NULL CHECK(uploaded_by_type IN ('admin', 'temp_code')),
    uploaded_by_id TEXT NOT NULL,
    upload_ip TEXT,
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

**文件夹删除规则（MVP）：**
- 仅允许删除空文件夹（无文件、无子文件夹）
- 非空文件夹需先移动或删除内容
- 软删除：is_deleted=1, deleted_at=NOW
- 已删除文件夹不能作为新文件目标

### 4.3 上传会话（三阶段完成）

```sql
CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY,
    upload_token_hash TEXT UNIQUE NOT NULL,
    
    filename TEXT NOT NULL,
    expected_size INTEGER NOT NULL CHECK(expected_size >= 0),
    expected_hash TEXT,
    chunk_size INTEGER NOT NULL CHECK(chunk_size > 0),
    
    status TEXT NOT NULL DEFAULT 'initiated'
        CHECK(status IN ('initiated', 'uploading', 'verifying', 'completed', 'aborted', 'expired', 'failed')),
    
    received_size INTEGER DEFAULT 0 CHECK(received_size >= 0),
    
    -- 三阶段完成字段
    final_stored_name TEXT,           -- 预生成，幂等
    final_file_id TEXT REFERENCES files(id),
    verify_started_at INTEGER,
    failure_reason TEXT,
    
    temp_path TEXT NOT NULL,
    
    principal_type TEXT NOT NULL CHECK(principal_type IN ('admin', 'temp_code')),
    principal_id TEXT NOT NULL,
    
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    completed_at INTEGER,
    
    CHECK(received_size <= expected_size)
);

-- 分块记录（唯一权威来源）
CREATE TABLE upload_parts (
    upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    size INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    
    PRIMARY KEY (upload_id, part_number)
);

CREATE INDEX idx_upload_sessions_token ON upload_sessions(upload_token_hash);
CREATE INDEX idx_upload_sessions_status ON upload_sessions(status, expires_at);
```

**上传完成三阶段：**

**阶段一：短事务抢占**
```sql
BEGIN IMMEDIATE;

UPDATE upload_sessions
SET status = 'verifying', verify_started_at = ?
WHERE id = ?
  AND status IN ('initiated', 'uploading');

-- affected_rows = 1: 获得完成权
-- status = 'completed': 返回已有 final_file_id
-- status = 'verifying': 返回 409 UPLOAD_FINALIZING
-- status = 'aborted/expired/failed': 拒绝

COMMIT;
```

**阶段二：事务外处理**
- 检查分块连续性（offset = part_number × chunk_size）
- 校验临时文件大小
- 计算完整哈希
- 准备最终存储名（预生成 final_stored_name）
- 幂等文件移动

**阶段三：短事务完成**
```sql
BEGIN IMMEDIATE;

INSERT INTO files (...);

UPDATE upload_sessions
SET status = 'completed',
    final_file_id = ?,
    completed_at = ?
WHERE id = ?
  AND status = 'verifying';

COMMIT;
```

**崩溃恢复：**
- verifying 超过 5 分钟：恢复任务重新检查
- 最终文件存在但 files 记录不存在：继续完成数据库提交
- 临时文件和最终文件都不存在：标记 failed

### 4.4 分享与下载会话（修正计数顺序）

```sql
CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    
    type TEXT NOT NULL CHECK(type IN ('page', 'direct')),
    
    protection TEXT NOT NULL DEFAULT 'none' 
        CHECK(protection IN ('none', 'password', 'admin')),
    password_hash TEXT,
    
    max_downloads INTEGER CHECK(max_downloads IS NULL OR max_downloads >= 0),
    used_downloads INTEGER DEFAULT 0 CHECK(used_downloads >= 0),
    
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    last_used_at INTEGER,
    
    -- 数据库级约束：direct 必须 protection=none
    CHECK(type <> 'direct' OR protection = 'none'),
    -- 密码保护必须有密码哈希
    CHECK((protection = 'password' AND password_hash IS NOT NULL)
          OR (protection <> 'password' AND password_hash IS NULL))
);

-- 下载会话（授权阶段创建，counted=0）
CREATE TABLE download_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    
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

**下载计数（正确顺序）：**
```sql
BEGIN IMMEDIATE;

-- 1. 先抢占 download_session 计数权
UPDATE download_sessions
SET counted = 1, counted_at = ?
WHERE id = ?
  AND counted = 0
  AND expires_at > ?;

-- affected_rows = 0: 已计数，不再更新 shares
-- affected_rows = 1: 获得计数权，继续

-- 2. 检查并扣减分享额度
UPDATE shares
SET used_downloads = used_downloads + 1,
    last_used_at = ?
WHERE id = ?
  AND status = 'active'
  AND (max_downloads IS NULL OR used_downloads < max_downloads)
  AND (expires_at IS NULL OR expires_at > ?);

-- 失败则 ROLLBACK，download_sessions.counted 恢复 0

COMMIT;
```

### 4.5 临时码（配额预留）

```sql
CREATE TABLE temp_codes (
    id TEXT PRIMARY KEY,
    code_secret_hash TEXT NOT NULL,
    label TEXT,
    
    permissions TEXT NOT NULL,
    
    max_uses INTEGER CHECK(max_uses IS NULL OR max_uses >= 0),
    used_count INTEGER DEFAULT 0 CHECK(used_count >= 0),
    rate_limit_bps INTEGER CHECK(rate_limit_bps IS NULL OR rate_limit_bps >= 0),
    
    -- 文件配额（原子预留）
    reserved_files INTEGER DEFAULT 0 CHECK(reserved_files >= 0),
    completed_files INTEGER DEFAULT 0 CHECK(completed_files >= 0),
    
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    created_by TEXT NOT NULL REFERENCES admin_accounts(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE TABLE temp_code_sessions (
    id TEXT PRIMARY KEY,
    temp_code_id TEXT NOT NULL REFERENCES temp_codes(id) ON DELETE CASCADE,
    session_token_hash TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    
    UNIQUE(session_token_hash)
);
```

**文件配额原子预留：**
```sql
-- 初始化上传时
UPDATE temp_codes
SET reserved_files = reserved_files + 1
WHERE id = ?
  AND reserved_files + completed_files < max_files;

-- 上传完成时
UPDATE temp_codes
SET reserved_files = reserved_files - 1,
    completed_files = completed_files + 1
WHERE id = ?;

-- 上传中止/过期时
UPDATE temp_codes
SET reserved_files = reserved_files - 1
WHERE id = ?;
```

### 4.6 传输入口

```sql
CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('direct', 'frp')),
    name TEXT NOT NULL,
    
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
    entry_id TEXT UNIQUE NOT NULL,
    
    public_base_url TEXT NOT NULL,
    
    is_enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    
    last_check_at INTEGER,
    last_latency_ms INTEGER,
    last_throughput_bps INTEGER,
    failure_count INTEGER DEFAULT 0,
    
    upload_rate_limit_bps INTEGER CHECK(upload_rate_limit_bps IS NULL OR upload_rate_limit_bps >= 0),
    download_rate_limit_bps INTEGER CHECK(download_rate_limit_bps IS NULL OR download_rate_limit_bps >= 0)
);
```

### 4.7 传输事件统计（外键修正）

```sql
CREATE TABLE transfer_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('upload', 'download')),
    file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
    share_id TEXT REFERENCES shares(id) ON DELETE SET NULL,
    entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
    principal_type TEXT NOT NULL,
    principal_id TEXT,
    bytes_transferred INTEGER NOT NULL,
    duration_ms INTEGER,
    occurred_at INTEGER NOT NULL
);

CREATE TABLE transfer_stats_hourly (
    hour_timestamp INTEGER NOT NULL,
    entry_id TEXT,
    upload_bytes INTEGER DEFAULT 0,
    download_bytes INTEGER DEFAULT 0,
    upload_count INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    PRIMARY KEY (hour_timestamp, entry_id)
);

CREATE INDEX idx_transfer_events_time ON transfer_events(occurred_at);
```

### 4.8 审计日志

```sql
CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    account_id TEXT REFERENCES admin_accounts(id),
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_logs_account ON audit_logs(account_id, created_at);
CREATE INDEX idx_audit_logs_action ON audit_logs(action, created_at);
```

### 4.9 系统配置

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES admin_accounts(id)
);

-- 存储路径由环境变量控制，非热更新：
-- FILESTATION_STORAGE_PATH=/data/storage
-- WebUI 只读显示
```

---

## 5. 核心协议设计

### 5.1 上传协议（分块文件存储）

**分块存储方式（改单文件为分块文件）：**
```
temp/<upload_id>/
    part_000000.part      # 正式分块文件
    part_000001.part
    part_000002.part.tmp  # 写入中临时文件
```

**分块写入流程：**
1. 写入 `part_<n>.part.tmp`
2. 校验长度和 SHA-256
3. `fsync`
4. 原子重命名为 `part_<n>.part`
5. 插入 `upload_parts` 记录

**崩溃恢复：**
- 启动时扫描 `temp/` 目录
- `.tmp` 文件：删除（未确认）
- `.part` 文件无数据库记录：删除（孤立）
- 数据库记录无 `.part` 文件：标记分块缺失

**完成时合并：**
- 按 part_number 顺序读取所有 `.part` 文件
- 合并为最终文件
- 验证总哈希
- 删除分块文件

### 5.2 下载协议（统一 access 流程）

**所有分享类型统一流程：**

```
1. 获取访问授权
   POST /api/v1/shares/:id/access
   {password?}  -- 免密分享无 body
   ← {download_token, expires_at, file_info, direct_url?}

2. 下载内容
   GET /api/v1/shares/:id/content
   Headers: Authorization: Bearer <download_token>, Range: bytes=...
   ← 206 Partial Content

3. 直链访问（type=direct）
   GET /f/:id/:filename
   ← 302 Found
   Location: /f/:id/:filename?dl=<short_lived_token>
   
   GET /f/:id/:filename?dl=<token>
   Headers: Range: bytes=...
   ← 206 / 200
```

**直链 Token 特性：**
- 短期：15 分钟
- 绑定：share_id + file_id + client_ip（可选）
- 用途：仅内容下载，不用于其他 API
- 响应头：`Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`

### 5.3 认证流程（完整）

**密码登录 + TOTP：**
```
POST /api/v1/auth/login
{username, password}

← {
    requires_second_factor: true,
    login_challenge: "ch_abc123...",  -- 5分钟有效，单次使用
    available_methods: ["totp", "webauthn"]
}

POST /api/v1/auth/login/totp
{login_challenge, totp_code}

← {
    access_token,
    refresh_token,
    expires_in
}
```

**WebAuthn 登录：**
```
POST /api/v1/auth/login
{username, password}

← {requires_second_factor: true, login_challenge, available_methods: ["webauthn"]}

POST /api/v1/auth/login/webauthn/options
{login_challenge}
← {publicKeyCredentialRequestOptions}

POST /api/v1/auth/login/webauthn/verify
{login_challenge, credential}
← {access_token, refresh_token}
```

**API Token 交换：**
```
POST /api/v1/auth/api-token/exchange
Authorization: Bearer fs_api_xxx

← {
    access_token,  -- JWT，含 principal_type: api_token, scopes
    expires_in
}
```

**API Token 权限限制：**
- 默认不能管理其他 Token
- 默认不能修改密码和认证器
- 默认不能生成恢复码
- scopes 不得被换取后的 JWT 放大

### 5.4 CORS 设计（Phase 3）

**允许来源：**
- 仅配置的管理员主域名（如 `https://admin.example.com`）
- 不使用 `Access-Control-Allow-Origin: *`

**允许头：**
```
Authorization, Range, X-Transfer-Id, X-Upload-Token, 
X-Part-Checksum, Content-Range, Content-Type
```

**暴露头：**
```
Content-Range, Content-Length, Accept-Ranges, 
Content-Disposition, ETag
```

**预检请求处理：**
- 不计入下载次数
- 不创建下载事件
- 不执行限额扣减
- 不要求内容下载 Token，但限制 Origin

**传输 Token 绑定：**
```json
{
    "transfer_id": "xxx",
    "principal_type": "admin|temp_code|share",
    "principal_id": "xxx",
    "direction": "upload|download",
    "resource_id": "file_xxx|upload_xxx",
    "allowed_entries": ["entry_1", "entry_2"],
    "aud": "filestation-transfer",
    "jti": "unique_id",
    "exp": 1234567890
}
```

---

## 6. 安全机制（完整）

### 6.1 密码与令牌安全

| 场景 | 机制 |
|------|------|
| 管理员密码 | bcrypt，修改需验证当前密码 |
| 分享密码 | bcrypt，验证后返回短期 download_token |
| 临时码 secret | Argon2id，130 bit 熵 |
| API Token | SHA-256，scopes 限制，JWT 声明区分 |
| Refresh Token | 轮换 + 重用检测 |
| 恢复码 | Argon2id，一次性，24 小时有效期 |
| Login Challenge | 5 分钟有效，单次使用，绑定账户 |

### 6.2 登录保护

- 账户维度：连续失败 5 次锁定 15 分钟
- IP 维度：连续失败 10 次延迟递增
- 凭据维度：特定 Token/临时码失败 3 次临时吊销
- 恢复码：使用一次即作废，同时吊销所有会话

### 6.3 原子计数（所有场景）

- 分享下载：先 UPDATE download_sessions SET counted=1 WHERE counted=0，再 UPDATE shares
- 临时码使用：UPDATE ... WHERE used_count < max_uses
- 临时码文件配额：UPDATE ... SET reserved_files = reserved_files + 1 WHERE reserved_files + completed_files < max_files
- 上传完成：BEGIN IMMEDIATE 条件 UPDATE 抢占

### 6.4 安全预览（恢复 v2.0）

**MIME 白名单（允许 inline）：**
- 图片：jpg, png, gif, webp, avif
- 视频：mp4, webm
- 音频：mp3, ogg, wav
- 文档：pdf

**强制 attachment：**
- svg, html, xml, js, css
- 无法确认的 MIME

**安全响应头：**
```
X-Content-Type-Options: nosniff
Content-Security-Policy: sandbox
Referrer-Policy: no-referrer
```

**主动内容隔离：**
- 用户上传的 HTML/SVG 等使用独立预览域名
- 避免与管理员 Cookie 共享 Origin

### 6.5 日志脱敏

- 禁止记录：密码、TOTP、完整 Token、临时码 secret
- 脱敏：Token 前缀、IP /24 匿名化
- 审计日志：90 天保留，定期清理

---

## 7. API 接口设计（完整）

**版本：** `/api/v1/*`

### 7.1 认证 `/api/v1/auth/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/auth/init` | 首次初始化（Nginx 限制 + Token） |
| POST | `/api/v1/auth/login` | 账号密码 → login_challenge |
| POST | `/api/v1/auth/login/totp` | TOTP 二次验证 |
| POST | `/api/v1/auth/login/webauthn/options` | WebAuthn 登录选项 |
| POST | `/api/v1/auth/login/webauthn/verify` | WebAuthn 登录验证 |
| POST | `/api/v1/auth/refresh` | Refresh Token |
| POST | `/api/v1/auth/logout` | 登出 |
| GET | `/api/v1/auth/sessions` | 会话列表 |
| DELETE | `/api/v1/auth/sessions/:id` | 吊销会话 |
| POST | `/api/v1/auth/password/change` | 修改密码 |
| POST | `/api/v1/auth/totp/setup` | TOTP 设置 |
| POST | `/api/v1/auth/totp/confirm` | TOTP 确认启用 |
| DELETE | `/api/v1/auth/authenticators/:id` | 删除认证器 |
| POST | `/api/v1/auth/webauthn/register/options` | WebAuthn 注册选项 |
| POST | `/api/v1/auth/webauthn/register/verify` | WebAuthn 注册验证 |
| GET | `/api/v1/auth/api-tokens` | Token 列表 |
| POST | `/api/v1/auth/api-tokens` | 创建 Token |
| DELETE | `/api/v1/auth/api-tokens/:id` | 吊销 Token |
| POST | `/api/v1/auth/api-token/exchange` | API Token 换 JWT |
| POST | `/api/v1/auth/recovery/generate` | 生成恢复码 |
| POST | `/api/v1/auth/recovery/verify` | 使用恢复码 |

### 7.2 文件 `/api/v1/files/*`

### 7.3 上传 `/api/v1/uploads/*`

### 7.4 分享 `/api/v1/shares/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/shares/:id/access` | 统一获取访问授权（免密/密码） |
| GET | `/api/v1/shares/:id/content` | 下载内容 |

### 7.5 直链 `/f/*`

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/f/:id/:filename` | 302 重定向到带 Token URL |

### 7.6-7.9 其他（同 v2.1）

---

## 8. 开发里程碑（四阶段）

### Phase 1: MVP（2 周）

- [ ] 项目脚手架
- [ ] 安全初始化（Nginx allow/deny + 一次性 Token）
- [ ] 账号密码登录 + JWT + Refresh Token
- [ ] 文件上传（分块文件存储 + upload_token + 三阶段完成）
- [ ] 文件下载（Range + download_session）
- [ ] 文件夹 CRUD（仅允许删除空文件夹）
- [ ] 文件有效期 + 自动过期
- [ ] 分享链接（page 类型，统一 access 流程）
- [ ] 基础设置页

### Phase 2: 可靠性（2 周）

- [ ] TOTP 认证（login_challenge 流程）
- [ ] API Token（exchange 端点 + scopes）
- [ ] 恢复码机制
- [ ] 断点续传（崩溃恢复）
- [ ] 原子计数（所有场景）
- [ ] 审计日志
- [ ] 并发/压力测试

### Phase 3: 多入口传输（2 周）

- [ ] 入口管理（public_base_url）
- [ ] 客户端探测与选路
- [ ] Nginx 配置生成（含 CORS）
- [ ] 跨入口授权与切换
- [ ] 入口限速
- [ ] 直链分享（302 + Token）

### Phase 4: 增强功能（2 周）

- [ ] WebAuthn
- [ ] P2P 传输
- [ ] 临时码（完整功能 + 配额预留）
- [ ] 文件夹分享
- [ ] 统计面板

---

## 9. 关键设计决策记录（v2.2 更新）

| 决策 | 选择 | 理由 |
|------|------|------|
| SQLite 行锁 | 条件 UPDATE 抢占，不用 FOR UPDATE | SQLite 兼容性 |
| 上传完成 | 三阶段分离 | 避免长事务阻塞，崩溃可恢复 |
| 初始化安全 | Nginx 层限制 + Token | Node 无法判断真实来源 |
| 下载计数 | 先抢占 download_session | 防并发重复计数 |
| 免密分享/直链 | 统一 access 流程 + 302 Token | 支持 Range 计数和跨入口 |
| 分块存储 | 独立分块文件，完成时合并 | 崩溃恢复简单，校验可靠 |
| 文件夹删除 | MVP 仅允许空文件夹 | 简化一致性 |
| 存储路径 | 环境变量控制 | 避免热更新导致文件丢失 |
| 临时码配额 | reserved_files/completed_files | 原子预留，防并发超额 |
| 安全预览 | MIME 白名单 + CSP sandbox | 防 XSS |

---

*文档版本: v2.2*
*创建日期: 2026-07-28*
*审阅状态: 已根据 AI 审阅意见三次修正，实现级问题闭合*
