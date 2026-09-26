# Task 15 实施报告 — LAN HTTP Web 上传哈希兼容

## 结果

修复了 SPA 从非安全 LAN HTTP origin 打开时，WebCrypto 不可用导致上传在首个分块请求前中断的问题。新上传和续传仍通过共用的 `uploadChunks` 上传循环计算 SHA-256，并保持现有 `X-Part-Checksum` 请求值和服务端契约。

## 变更文件

- `apps/web/src/lib/sha256.ts`：新增独立 SHA-256 hex helper 与专用失败类型。
- `apps/web/src/components/FileUpload.tsx`：接入 helper；哈希彻底失败时显示专用错误；续传区说明需要重新选择原文件。
- `apps/web/src/__tests__/sha256.test.ts`：覆盖 native WebCrypto、SubtleCrypto 缺失、native digest 拒绝后 fallback、两种算法都失败。
- `apps/web/src/__tests__/FileUpload.test.tsx`：覆盖 LAN HTTP 下的精确校验头、校验失败后的错误提示与续传记录保留，以及续传说明和隐藏 picker 可访问性。
- `apps/web/package.json`、`package-lock.json`：将已有 `@noble/hashes@1.8.0` 固定为 Web 运行时直接依赖，并同步锁文件 production 标记。
- `README.md`、`docs/CURRENT-STATE.md`：记录 LAN HTTP 修复、真实 MCP 客户端通过项及仍待手工验收项。
- `.superpowers/sdd/task-15-report.md`：本报告。

## TDD 证据

在修改生产代码之前添加了回归测试。最初的组合 RED 运行观察到 LAN HTTP 用例没有发出任何 `PUT`，界面显示通用“上传中断”提示；续传说明断言也因文本不存在而失败。哈希失败用例的首个夹具尝试重复定义 `File.slice`，导致夹具错误；修正夹具后，在生产代码未改变时单独重跑该用例，确认初始化请求已发出、续传记录仍在，但界面仍显示通用“上传中断”而非校验错误。

实现后聚焦 GREEN 命令 `npx vitest run src/__tests__/FileUpload.test.tsx src/__tests__/sha256.test.ts --no-cache` 退出 0：2 files / 32 tests passed。helper 测试使用已知输入 `hello` 和固定 SHA-256 字面值，native、fallback 及 native reject 后 fallback 均返回同一精确小写摘要；LAN HTTP UI 回归断言首个分块的校验头为预期值。总哈希失败回归断言专用提示出现、本地续传记录保留，且凭据没有显示到页面。

## 验证

- `npx vitest run src/__tests__/FileUpload.test.tsx src/__tests__/sha256.test.ts --no-cache`：2 files / 32 passed。
- `npx vitest run --no-cache`（`apps/web`）：16 files / 137 passed，exit 0。现有 `PageErrorBoundary.test.tsx` 会向 jsdom 输出预期的 `render failed` 错误边界日志；未造成测试失败。
- `npm run typecheck`：root 全部 workspace 通过，exit 0。
- `npm run build`：shared、server、Web build 通过，exit 0。
- `git diff --check`：exit 0；只有工作区既有 LF/CRLF 规范化提示。
- `npm ls @noble/hashes --all`：exit 0；Web 指向 `@noble/hashes@1.8.0`，server 既有传递依赖仍去重到同一版本。

## 自审

- SHA-256 仍由 WebCrypto 或 `@noble/hashes` 执行，没有自写密码学实现；无论采用哪条路径，返回格式都是 64 个小写十六进制字符。
- `uploadChunks` 是新上传和续传共用路径；没有修改分块上传 API、校验协议或服务端代码。
- 续传文件名和大小验证、隐藏 picker 的 `hidden` / `aria-hidden` / `tabIndex=-1`、单飞、AbortController 与终态/模糊状态分类均保留。
- 哈希失败错误不包含文件字节、Token 或底层错误文本；待续传状态不因该错误清理。
- README 与当前状态将 MCP 客户端验收标为通过，范围为 `server_info`、上传、列表、分享、浏览器下载/读回、审计查询和 Token 吊销；直接 MCP `download_file` 工具仍不存在。375px、TOTP/恢复码及刷新后续传仍标为 pending。
- 主实现提交只包含 8 个 Task 15 代码、测试、manifest/lock 与用户文档文件。本任务未暂存，也未更改原有 `.superpowers/sdd/progress.md` 工作区内容；`.claude/settings.local.json`、未跟踪 plan 文件和 `.tmp-manual-acceptance-20260926/` 均未暂存或更改。未启动/停止手动服务，未派生 reviewer。

## 提交

- Conventional Commit：`fix(web): support LAN HTTP upload hashing`
- 主实现 commit：`950f3779b2307d7ec990b1d7b57ca5047a6dd291`

## Concerns

- 仓库已知 lint 状态仍不可用：server/Web 缺少 ESLint 可执行文件，shared 没有 lint script；本任务未声称 lint 通过。
- 375px 真实设备布局、TOTP/恢复码真实流程和页面刷新后的续传仍待用户手动验收。Codex 内置浏览器访问本地服务的已知限制为 `ERR_BLOCKED_BY_CLIENT`；本任务未重试，也未把自动化验证当成手验完成。
- 完整 Web suite 通过，但包含既有 Error Boundary 测试主动触发并打印的 jsdom 异常日志。
