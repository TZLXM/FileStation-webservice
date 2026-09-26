# ADR-0005: 内嵌 MCP 使用 API Token 与无状态 Streamable HTTP

## 状态
accepted

## 上下文

Phase 2 需要为自动化 Agent 暴露受控的文件、文件夹、上传和分享能力，同时复用已有单管理员认证、细粒度 scope、审计及业务服务。新增独立 Agent 账户或复制一套上传/分享逻辑会扩大凭据和授权面；让 MCP 自己保存会话状态也会引入额外的会话生命周期与部署一致性。

实现核对基线：`@modelcontextprotocol/sdk` package spec `^1.30.0`、锁定 `1.30.1`；Zod spec `^3.25.76`、锁定 `3.25.76`。SDK 的 Zod 3/4 类型重载会触发当前 TypeScript 深度推断限制，因此实现用窄类型本地 adapter 调用同一个 `server.tool` API，不通过升级到未验证依赖来规避。

## 决策

1. 在 `/api/v1/mcp` 实现无状态 Streamable HTTP，仅开放 `POST`；MCP 默认关闭，GET/DELETE 返回 404。每次请求都提供 `Authorization: Bearer <API_TOKEN>` 并校验 Token，不建立 MCP session，也不要求先换成短期 JWT。
2. 复用 API Token：格式 `fs_api_` + 48 位小写十六进制（192 bit）；明文只在创建时返回，数据库保存 SHA-256 全值及展示前缀；每次使用从数据库确认到期/撤销并读取 scopes。创建/列表/吊销接口为管理员专属。
3. 当前 `api_tokens.token_hash` 列为 `NOT NULL`，没有索引或唯一约束；查验对输入计算 SHA-256 后通过 TypeORM `findOne({ where: { tokenHash } })` 全值精确查找，不按短前缀搜索。当前单管理员模式下预期 Token 行数较低，接受无索引扫描；192-bit CSPRNG 令重复值概率极低，但 DB 并不强制唯一。若未来 Token 数量/查询负载改变，应先审计既有值，再用数据库迁移增加唯一索引并验证发行、查找与冲突处理。
4. 区分两种 API Token 使用路径：REST `POST /api/v1/auth/api-token/exchange` 可将原始 Token 交换成 1 小时 `principal_type: api_token` JWT；受保护 API 每次仍回查 backing Token 行与 scope/撤销/到期状态。MCP 则直接使用 API Token，不经过 exchange。两条路径吊销后都在下一次鉴权请求拒绝；已经通过鉴权的在途请求不会被追溯取消。
5. 工具执行最小 scope 检查，未配置 scope 的工具仅限 `server_info`（仍要求有效 Token）。审计不是每次尝试的完整账本：认证/协议/schema/scope 拒绝、16 MiB MCP 请求体超限，以及上传单文件大小、Base64 格式/解码大小拒绝均可在审计调用前结束；`server_info` 与列表类工具在读取服务前记录，写操作通常在业务服务成功后记录。`mcp.tool_called` 不应解释为 attempt 计数或统一成功标记。文件、文件夹、上传、分享操作复用已有业务服务。
6. MCP 路由使用独立 16 MiB JSON 限额，在功能开关与 API Token 校验后解析；其他 API 保持 Express 默认 JSON/urlencoded 限额。MCP 文件默认最多 32 MiB（可配 1–512 MiB），单 part 解码后最多 8 MiB，chunk 64 KiB–8 MiB；标准 API 上传仍遵循其独立的 100 GiB/64 KiB–64 MiB 限制。
7. 不将客户端专属配置文件格式作为项目 API 契约。MCP 返回的相对 `share_url` 是规范链接；由未受信任代理头派生的 `share_url_absolute` 只作便利展示，不保证 origin 正确。

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

- Agent 沿用已有凭据签发/吊销与每次请求数据库撤销/到期校验；权限撤销会阻止后续 MCP/API Token JWT 请求，但不会取消在途请求。
- 无 MCP session 状态，上传续传继续由 FileStation 的 upload session/token 契约管理。
- MCP 与普通 API 的 body 限制隔离，且在 Token 校验前不读取/反序列化大请求体。

**负面与边界：**

- MCP 客户端需要安全保存长期 Token；用户应遵循最小 scope、HTTPS、及时吊销/轮换，不要把 Token 放在 URL、源码、日志或提交中。
- `server_info` 也需要带一个有效 API Token；它不是匿名探活端点。
- API Token 哈希当前没有索引/唯一约束；低行数与 192-bit 随机发行使全表查找可接受，但数据库唯一性并未强制，规模扩大时须通过迁移补索引并审计既有行。
- `mcp.tool_called` 仅表示 handler 到达该 audit callsite；前置拒绝可能没有审计行，读操作与写操作的审计调用时序不同，不能将它作为完整尝试日志。
- 反向代理不受信任；MCP absolute share URL 中的 scheme/host 可能不适合反代后的用户环境，应优先使用相对链接。
- 依赖风险仍按 `npm audit` 的当前安全门单独跟踪；本 ADR 不授权自动修复、大版本升级或未经兼容性验证的 overrides。

## 替代方案

1. **单独创建 MCP 用户/凭据体系**——拒绝：重复实现身份、scope、吊销和审计，增加安全面。
2. **要求所有客户端先调用 API Token exchange 并使用 JWT**——拒绝：MCP 端仍需按 Token 行验证吊销与权限；直接复用 Token 可避免无必要的双重认证协议。
3. **启用有状态 MCP session**——拒绝：当前工具均是独立 HTTP 请求，上传状态已经由服务端 upload session 管理；新增 MCP 会话状态没有必要。
4. **所有路由共用统一大 JSON body limit**——拒绝：会扩大普通 API 的内存/拒绝服务面；仅对经过启用检查和 Token 校验的 MCP POST 使用专用限额。
