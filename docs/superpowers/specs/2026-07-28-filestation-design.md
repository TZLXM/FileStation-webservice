# FileStation 文件传输站 - 设计文档

## 1. 项目概述

私有文件传输站 Web 应用，支持多传输方式、灵活分享控制、细粒度权限管理。

**核心特性：**
- 多传输通道智能选路（直连 / FRP多地址 / P2P）
- 文件 URL 直链（免密预览 / 密码保护 / 管理员验证）
- 临时码授权访客上传下载
- 文件自动过期 + 手动延长/永久保留
- 全局限速 + 通道限速 + 角色限速
- 多设备管理员认证（TOTP / API Token / WebAuthn）
- 虚拟文件夹管理
- WebUI 全配置（站点名、图标、传输、存储等）

---

## 2. 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 后端 | NestJS (Node.js/TypeScript) | 模块化架构，便于扩展 |
| 前端 | React + shadcn/ui + Tailwind CSS | 现代美观，组件丰富 |
| 数据库 | SQLite (TypeORM) | 单文件部署，零配置 |
| 文件存储 | 本地磁盘（抽象层，未来可换 S3） | 简单可靠 |
| 实时通信 | WebSocket (Socket.io) | 传输进度、P2P 信令 |
| 构建 | Vite + Turborepo (可选) | 快速开发 |

---

## 3. 部署架构

```
┌─────────────────────────────────────────┐
│  访问者浏览器 / 管理员设备                │
└──────────┬──────────────────────────────┘
           │ HTTPS/WSS
           ▼
┌─────────────────────────────────────────┐
│  Nginx (可选，反向代理 + TLS 终结)        │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│  FileStation Node.js 服务               │
│  - 监听 0.0.0.0:8080 (可配置)            │
│  - SQLite 数据库 + 本地文件存储           │
│  - 内置 WebSocket 服务                   │
└──────────┬──────────────────────────────┘
           │ 用户自行配置 frpc 暴露此端口
           ▼
┌─────────────────────────────────────────┐
│  公网服务器 (frps / 其他 FRP 工具)        │
└─────────────────────────────────────────┘
```

**FRP 职责边界：**
- FileStation 只负责监听本地端口，**不管理 frpc 进程**
- 用户自行使用 frpc 或第三方 FRP 软件暴露端口
- WebUI 中手动录入已暴露的公网地址列表，用于智能选路

---

## 4. 后端模块架构 (NestJS)

```
src/
├── main.ts                    # 启动入口，全局前缀 /api
├── app.module.ts
├── config/                    # 环境配置
├── database/                  # SQLite 初始化、TypeORM 配置、迁移
├── auth/                      # 认证模块
│   ├── strategies/            # JWT / API Token / TOTP / WebAuthn
│   ├── guards/                # AdminGuard / TempCodeGuard / PublicGuard
│   └── auth.controller.ts
├── files/                     # 文件核心
│   ├── files.controller.ts    # CRUD + 上传/下载
│   ├── files.service.ts       # 元数据管理
│   ├── storage.service.ts     # 磁盘读写抽象
│   ├── cleanup.service.ts     # 定时清理过期文件 (@Cron)
│   └── rate-limit.service.ts  # 令牌桶限速
├── folders/                   # 文件夹模块
│   └── folders.controller.ts  # 树形结构 CRUD
├── shares/                    # 分享链接
│   ├── shares.controller.ts   # 分享页 / 直链
│   └── shares.service.ts      # 密码校验、权限判断
├── temp-codes/                # 临时码
│   └── temp-codes.service.ts  # 生成/验证/吊销
├── transfer/                  # 传输调度
│   ├── transfer.gateway.ts    # WebSocket 信令 (/ws/transfer)
│   ├── channel.service.ts     # 通道探测与选路
│   └── p2p.service.ts         # WebRTC 协调
├── settings/                  # 站点设置 (WebUI 可配)
│   └── settings.controller.ts
└── health/                    # 健康检查 (用于通道探测)
    └── health.controller.ts   # /api/health
```

---

## 5. 数据库 Schema (SQLite)

### 5.1 文件与文件夹

```sql
CREATE TABLE folders (
    id TEXT PRIMARY KEY,              -- UUID
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id),  -- NULL=根目录
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    is_deleted INTEGER DEFAULT 0
);

CREATE TABLE files (
    id TEXT PRIMARY KEY,              -- UUID
    folder_id TEXT REFERENCES folders(id),  -- NULL=收件箱
    filename TEXT NOT NULL,           -- 原始文件名
    stored_name TEXT NOT NULL,        -- 磁盘存储名
    size INTEGER NOT NULL,
    mime_type TEXT,
    hash_sha256 TEXT,                 -- 完整性校验
    uploaded_by TEXT,                 -- 'admin' 或 temp_code_id
    upload_ip TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,               -- NULL=永不删除
    is_permanent INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',     -- active / expired / deleted
    rate_limit_mbps INTEGER,          -- 单文件限速，NULL=跟随全局
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
);
```

### 5.2 分享与临时码

```sql
CREATE TABLE shares (
    id TEXT PRIMARY KEY,              -- 短随机码 /s/abc123
    file_id TEXT NOT NULL REFERENCES files(id),
    type TEXT NOT NULL,               -- 'page' | 'direct' (直链)
    protection TEXT NOT NULL,         -- 'none' | 'password' | 'admin'
    password_hash TEXT,               -- protection=password 时
    max_downloads INTEGER,
    used_downloads INTEGER DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE temp_codes (
    id TEXT PRIMARY KEY,              -- 8位码 A7B3-X9K2
    label TEXT,                       -- 备注
    permissions TEXT NOT NULL,        -- JSON: {"upload":true,"folder_ids":[],"expire_hours":24}
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    is_revoked INTEGER DEFAULT 0,
    rate_limit_mbps INTEGER           -- 临时码专属限速
);
```

### 5.3 设备与通道

```sql
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,               -- "我的手机"
    type TEXT NOT NULL,               -- 'web' | 'api' | 'totp' | 'webauthn'
    credential TEXT,                  -- Token哈希 / TOTP密钥(加密) / WebAuthn公钥
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,               -- 'direct' | 'frp' | 'p2p'
    name TEXT NOT NULL,               -- "FRP-北京节点"
    config TEXT NOT NULL,             -- JSON: {host, port, priority, rate_limit_mbps}
    is_enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    last_check_at INTEGER,
    last_latency_ms INTEGER
);
```

### 5.4 系统配置

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL               -- JSON
);
-- 预置键:
-- site_name, site_icon, default_expire_hours, max_file_size_mb,
-- allow_public_upload, p2p_enabled, stun_server, frp_addresses[],
-- global_upload_limit_mbps, global_download_limit_mbps,
-- role_limits: {admin:0, temp_code:10, public:5}  (0=不限)
```

---

## 6. API 接口设计

### 6.1 认证 `/api/auth/*`

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/auth/login` | 账号密码登录 | 公开 |
| POST | `/api/auth/totp/verify` | TOTP 二次验证 | 待验证 |
| POST | `/api/auth/token` | API Token 换 JWT | 公开 |
| POST | `/api/auth/webauthn/register` | 注册 Passkey | 管理员 |
| POST | `/api/auth/webauthn/verify` | Passkey 登录 | 公开 |
| GET | `/api/auth/devices` | 设备列表 | 管理员 |
| DELETE | `/api/auth/devices/:id` | 吊销设备 | 管理员 |

**安全机制：**
- JWT 有效期 24h，refresh token 7 天
- TOTP 密钥 AES-256 加密存储
- API Token 仅存储 SHA-256 哈希
- 连续失败 5 次锁定 IP 15 分钟

### 6.2 文件 `/api/files/*`

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/files` | 列表（分页/搜索/筛选） | 管理员 |
| POST | `/api/files/upload` | 上传（分块，WebSocket 进度） | 管理员/临时码 |
| GET | `/api/files/:id` | 元信息 | 管理员/有权限临时码 |
| PATCH | `/api/files/:id` | 修改（有效期/权限/文件夹/限速） | 管理员 |
| DELETE | `/api/files/:id` | 删除 | 管理员 |
| POST | `/api/files/:id/extend` | 延长过期时间 | 管理员 |

**上传流程：**
1. POST `/upload` 传元数据 → 返回 `upload_id`
2. WebSocket `/ws/transfer` 发送 `upload_id` + 分块
3. 支持断点续传（分块确认持久化）

### 6.3 文件夹 `/api/folders/*`

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/folders` | 树形结构 | 管理员 |
| POST | `/api/folders` | 新建 | 管理员 |
| PATCH | `/api/folders/:id` | 重命名/移动 | 管理员 |
| DELETE | `/api/folders/:id` | 删除（文件移回收件箱） | 管理员 |

### 6.4 分享 `/api/shares/*` + `/s/*` + `/f/*`

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/shares` | 创建分享 | 管理员/临时码 |
| GET | `/api/shares/:id` | 分享信息 | 公开 |
| POST | `/api/shares/:id/verify` | 验证密码/临时码 | 公开 |
| GET | `/s/:id` | 分享页（HTML） | 公开 |
| GET | `/f/:id/:filename` | 直链（直接返回文件） | 公开/密码 |

**直链特性：**
- 根据 MIME 类型自动 `Content-Disposition: inline/attachment`
- 图片/视频/PDF/文本可直接浏览器预览
- 支持 Range 请求（视频拖动、断点续传）
- 可选 `?key=xxx` 密码保护

### 6.5 临时码 `/api/temp-codes/*`

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/temp-codes` | 生成 | 管理员 |
| GET | `/api/temp-codes` | 列表 | 管理员 |
| DELETE | `/api/temp-codes/:id` | 吊销 | 管理员 |
| POST | `/api/temp-codes/:id/verify` | 访客验证 | 公开 |

### 6.6 传输 `/api/transfer/*` + WebSocket

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/transfer/channels` | 通道列表及延迟 |
| POST | `/api/transfer/test/:id` | 测试通道速度 |
| WS | `/ws/transfer` | 传输信令（分块确认、进度、P2P SDP） |

**智能选路算法：**
1. 并行探测所有启用通道（HEAD `/api/health`）
2. 按延迟排序，优先直连，其次 FRP，最后 P2P
3. 传输中实时监控速度，低于阈值或断开自动切换

**限速实现（令牌桶）：**
- 每 100ms 检查全局/通道/角色/单文件令牌桶
- WebSocket 背压控制分块发送间隔
- 前端实时显示当前速率 vs 限制

### 6.7 设置 `/api/settings/*`

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/settings` | 获取配置（公开仅名称/图标） | 公开/管理员 |
| PUT | `/api/settings` | 更新配置 | 管理员 |
| POST | `/api/settings/icon` | 上传 favicon | 管理员 |

---

## 7. 前端页面结构 (React)

### 7.1 路由

| 路径 | 页面 | 权限 |
|------|------|------|
| `/` | 文件管理主页 | 管理员 |
| `/login` | 登录页 | 公开 |
| `/s/:id` | 分享页 | 公开 |
| `/f/:id/:filename` | 直链（后端处理，前端无页面） | - |
| `/upload/:code` | 临时码上传页 | 公开 |
| `/settings` | 站点设置 | 管理员 |
| `/devices` | 设备管理 | 管理员 |
| `/transfers` | 传输状态 | 管理员 |

### 7.2 主页布局（方案A：经典侧边栏）

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

**文件右键菜单：**
- 下载 / 分享 / 移动到 / 重命名
- 有效期设置 / 访问权限 / 下载统计
- 删除

**有效期设置弹窗：**
- 临时文件（自定义小时数，到期前提醒）
- 永久保留
- 自定义具体时间
- 快速操作：+1天/+1周/+1月/+1年

**访问权限设置弹窗：**
- 私有 / 内部分享 / 公开
- 公开时可选：密码 / 下载次数限制 / 允许直链预览
- 生效范围：仅当前文件 / 应用到文件夹

### 7.3 设置页标签

| 标签 | 内容 |
|------|------|
| 基本 | 站点名称、默认过期时间、最大文件大小 |
| 安全 | TOTP开关、API Token管理、WebAuthn注册 |
| 传输 | P2P开关、STUN服务器、通道优先级拖拽、全局限速 |
| FRP地址 | 多行输入框，每行一个 host:port，带"测试延迟" |
| 存储 | 存储路径、自动清理周期、磁盘配额 |
| 外观 | favicon上传、主题色、浏览器标签标题 |

### 7.4 组件库

| 用途 | 方案 |
|------|------|
| 基础组件 | shadcn/ui + Radix UI |
| 图标 | Lucide React |
| 文件拖拽 | react-dropzone |
| 状态管理 | Zustand |
| 图表 | Recharts |
| 二维码 | qrcode.react |
| 大文件 hash | Web Worker 计算 SHA-256 |

---

## 8. 安全设计

| 层面 | 措施 |
|------|------|
| 传输安全 | 全站 HTTPS（Nginx 终结），WebSocket WSS |
| 认证安全 | JWT + Refresh Token，TOTP，WebAuthn，Token 哈希存储 |
| 密码安全 | bcrypt 哈希，连续失败锁定 |
| 文件安全 | 存储名随机化，防路径遍历，MIME 类型校验 |
| 分享安全 | 密码哈希存储，一次性下载令牌，下载次数限制 |
| 临时码 | 使用次数限制，过期时间，权限最小化 |
| API 安全 | 速率限制（全局/角色），输入校验，CORS 配置 |

---

## 9. 扩展性设计

| 未来扩展 | 预留接口 |
|----------|----------|
| 多用户系统 | devices 表可扩展为 users 表，当前 uploaded_by 已预留 |
| 对象存储 | storage.service.ts 抽象层，实现 S3StorageService 即可 |
| WebDAV | 新增 webdav 模块，复用 files/folders 服务 |
| 在线预览 | 直链已支持，新增 preview 模块渲染特殊格式 |
| 多语言 | i18n 目录预留，前端 react-i18next |
| 插件系统 | NestJS 动态模块，运行时加载 |

---

## 10. 开发里程碑

| 阶段 | 内容 | 预估 |
|------|------|------|
| M1 | 基础框架 + 文件上传下载 + SQLite | 3天 |
| M2 | 认证系统（JWT + TOTP + Token） | 2天 |
| M3 | 分享链接 + 直链 + 临时码 | 2天 |
| M4 | 文件夹 + 有效期管理 | 2天 |
| M5 | 传输调度（直连/FRP/P2P）+ 限速 | 3天 |
| M6 | WebUI 完善 + 设置页 + 设备管理 | 2天 |
| M7 | 测试 + 优化 + 文档 | 2天 |

---

## 11. 项目结构

```
filestation-webservice/
├── package.json
├── turbo.json (可选 monorepo)
├── apps/
│   ├── server/          # NestJS 后端
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/             # React 前端
│       ├── src/
│       ├── package.json
│       └── vite.config.ts
├── packages/
│   └── shared/          # 共享类型/常量
│       └── types.ts
├── data/                # 运行时数据（SQLite + 文件）
│   ├── filestation.db
│   └── storage/
├── docs/
│   └── superpowers/specs/2026-07-28-filestation-design.md
└── README.md
```

---

*文档版本: v1.0*
*创建日期: 2026-07-28*
*确认状态: 已确认*
