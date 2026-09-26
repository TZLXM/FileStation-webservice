# Task 14 实施 Brief：Phase 2 文档与发布收尾

## 身份与范围

- 计划：`docs/superpowers/plans/2026-09-19-phase2-reliability-agent-mobile.md`，Task 14
- 基线：`15dd142`
- 执行工作区：既有平铺台账 `.superpowers/sdd/`
- 改动范围：设计文档 v2.3、ADR-0005、`AGENTS.md`、`docs/CURRENT-STATE.md`、`README.md`；本 brief/report 与 progress ledger
- 不创建 PR、不合并。提交只包含 Task14 文档及必要安全修复；保留 `.claude/settings.local.json` 与计划文件两个用户未跟踪文件。

## 目标

按 Task14 完成文档和发布说明，所有具体事实必须与最终代码、数据库迁移、`package-lock.json`、自动化测试和 Task13 的最终审阅记录核对。不要照抄已过期计划示例。文档应明确 Phase2 自动化实现/验证状态与仍待用户手动验收的区别；不得宣称发布验收完成。

核实并记录：API Token 与 JWT principal/scope、端点、MCP 11 个工具及 scope、路由 body / 上传 part / 单文件限制、token 熵与存储/查找、SDK/Zod 锁定版本、审计 action enum、TOTP 与 recovery 参数、断点续传、Task13 owner staging UUID 命名不变量与混合版本部署约束。

## 输出

1. 设计文档 v2.2 → v2.3
2. 新增 ADR-0005，按 `docs/DOCUMENTATION-GOVERNANCE.md` 格式撰写
3. `AGENTS.md` 增补 Phase2 安全硬规则与上传/部署约束
4. `docs/CURRENT-STATE.md` 区分实现+自动化完成和用户手动验收待完成
5. `README.md` 更新启动、功能、限制、Agent 接入示例和手动验收清单；仅用 token 占位符，不声称未经验证的客户端配置格式

## 验证门槛

- server unit 显式 workspace 命令
- Web `vitest run --no-cache`
- 完整 server E2E
- root `npm run typecheck`、`npm run build`、`git diff --check`
- 复核 lint 的当前可运行性
- 执行当日 `npm audit --json`，与旧记录的 39 项核对；分类实际快照（runtime/dev、direct/transitive、critical/high、修复是否 breaking）。不运行 `npm audit fix`，不做大版本升级。若发现 production dependency closure 中的 Critical/High，暂停发布完成声明并向委派方报告最小安全修复选项。
- 明确记录根 `npm test` 因 shared workspace 没有 test script 而失败的证据；不能误报为全绿。

## 完成边界

真实 MCP 客户端、375px 浏览器视觉验收、TOTP/recovery 手动流程、断点续传手动刷新恢复仍列为用户待验收；当前浏览器 localhost 环境已有 `ERR_BLOCKED_BY_CLIENT` 阻塞。自动化测试通过不等同发布验收完成。

## 提交

仅提交 Task14 范围与必要安全修复；中文 Conventional Commit，Co-Authored-By 使用 `GPT-6 Luna <noreply@openai.com>`。提交后由委派方安排 `gpt5.6-sol medium` 最终审阅。
