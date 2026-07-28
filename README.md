# FileStation

私有文件传输站 Web 应用，支持多传输入口、灵活分享控制、细粒度权限管理。

## 特性

- **多传输入口**: 直连 / 多 FRP 地址智能选路
- **文件分享**: URL 直链（免密 / 密码 / 管理员验证）
- **临时码**: 授权访客上传下载
- **自动过期**: 文件过期自动清理，可手动延长
- **限速控制**: 全局 / 入口 / 角色 多层限速
- **多设备认证**: TOTP / API Token / WebAuthn
- **文件夹管理**: 虚拟文件夹，嵌套结构
- **WebUI 配置**: 站点名称、图标、传输、存储全配置

## 技术栈

- **后端**: NestJS (Node.js/TypeScript)
- **前端**: React + shadcn/ui + Tailwind CSS
- **数据库**: SQLite (TypeORM)
- **构建**: Vite

## 快速开始

### 开发环境

```bash
# 克隆项目
git clone <repository-url>
cd filestation-webservice

# 安装依赖
npm install

# 启动开发服务器（前后端并行）
npm run dev
```

访问:
- 前端: http://localhost:5173
- 后端 API: http://localhost:8080

### 生产部署

```bash
# 构建
npm run build

# 启动
npm start
```

**注意**: 生产环境必须配置 Nginx 反向代理，详见 [部署文档](docs/deployment.md)。

## 文档

- [设计文档](docs/superpowers/specs/2026-07-28-filestation-design.md) - 详细架构设计
- [开发手册](AGENTS.md) - Agent 开发指南
- [当前状态](docs/CURRENT-STATE.md) - 项目进度和状态
- [架构决策](docs/adr/) - 技术决策记录

## 开发

```bash
# 类型检查
npm run typecheck

# Lint
npm run lint

# 测试
npm test

# 构建
npm run build
```

## 许可证

MIT

---

*项目状态: Phase 1 MVP 开发中*
