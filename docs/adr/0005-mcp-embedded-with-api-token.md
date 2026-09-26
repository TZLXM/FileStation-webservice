# ADR-0005: 内嵌 MCP 使用 API Token 与无状态 Streamable HTTP

## 状态
accepted

## 上下文

Phase 2 需要为自动化 Agent 暴露受控的文件、文件夹、上传和分享能力，同时复用已有单管理员认证、细粒度 scope、审计及业务服务。新增独立 Agent 账户或复制一套上传/分享逻辑会扩大凭据和授权面；让 MCP 自己保存会话状态也会引入额外的会话生命周期与部署一致性。

实现核对基线：`@modelcontextprotocol/sdk` package spec `^1.30.0`、锁定 `1.30.1`；Zod spec `^3.25.76`、锁定 `3.25.76`。SDK 的 Zod 3/4 类型重载会触发当前 TypeScript 深度推断限制，因此实现用窄类型本地 adapter 调用同一个 `server.tool` API，不通过升级到未验证依赖来规避。

## 决策

1. 在 `/api/v1/mcp` 实现无状态 Streamable HTTP，仅开放 `POST`；MCP 默认关闭，GET/DELETE 返回 404。每次请求都提供 `Authorization: Bearer <API_TOKEN>` 并校验 Token，不建立 MCP session，也不要求先换成短期 JWT。
2. 复用 API Token：格式 `fs_api_` + 48 位小写十六进制；明文只在创建时返回，持久化 SHA-256 哈希及短前缀；每次使用从数据库确认到期/撤销并读取 scopes。创建/列表/吊销接口为管理员专属。
3. 工具逐个执行最小 scope 检查，未配置 scope 的工具仅限 `server_info`（仍要求一个有效 Token）；每次工具调用记审计。文件、文件夹、上传、分享操作复用已有业务服务。
4. MCP 路由使用独立 16 MiB JSON 限额，在功能开关与 API Token 校验后解析；其他 API 保持 Express 默认 JSON/urlencoded 限额。MCP 文件默认最多 32 MiB（可配 1–512 MiB），单 part 解码后最多 8 MiB，chunk 64 KiB–8 MiB；标准 API 上传仍遵循其独立的 100 GiB/64 KiB–64 MiB 限制。
5. 不将客户端专属配置文件格式作为项目 API 契约。MCP 返回的相对 `share_url` 是规范链接；由未受信任代理头推导的 absolute URL 只作便利展示。

当前工具与授权映射：

| 工具 | Scope |
|------|-------|
| `server_info` | 有效 Token；无额外 scope |
| `list_files` | `files:read` |
| `list_folders` | `folders:read` |
| `create_folder` | `folders:write` |
| `upload_init`、`upload_part`、`complete_upload`、`delete_file` | `files:write` |
| `create_share`、`revoke_share` | `shares:write` |
| `list_shares` | `shares:read` |

## 后果

**正面：**

- Agent 沿用已有凭据签发/吊销、每次请求数据库 scope 校验和审计链路；权限撤销立即对后续 MCP 请求生效。
- 无 MCP session 状态，上传续传继续由 FileStation 的 upload session/token 契约管理。
- MCP 与普通 API 的 body 限制隔离，且在 Token 校验前不读取/反序列化大请求体。

**负面与边界：**

- MCP 客户端需要安全保存长期 Token；用户应遵循最小 scope、HTTPS、及时吊销/轮换，不要把 Token 放在 URL、源码、日志或提交中。
- `server_info` 也需要带一个有效 API Token；它不是匿名探活端点。
- 反向代理不受信任；MCP absolute share URL 中的 scheme/host 可能不适合反代后的用户环境，应优先使用相对链接。
- 依赖风险仍按 `npm audit` 的当前安全门单独跟踪；本 ADR 不授权自动修复、大版本升级或未经兼容性验证的 overrides。

## 替代方案

1. **单独创建 MCP 用户/凭据体系**——拒绝：重复实现身份、scope、吊销和审计，增加安全面。
2. **要求所有客户端先调用 API Token exchange 并使用 JWT**——拒绝：MCP 端仍需按 Token 行验证吊销与权限；直接复用 Token 可避免无必要的双重认证协议。
3. **启用有状态 MCP session**——拒绝：当前工具均是独立 HTTP 请求，上传状态已经由服务端 upload session 管理；新增 MCP 会话状态没有必要。
4. **所有路由共用统一大 JSON body limit**——拒绝：会扩大普通 API 的内存/拒绝服务面；仅对经过启用检查和 Token 校验的 MCP POST 使用专用限额。
