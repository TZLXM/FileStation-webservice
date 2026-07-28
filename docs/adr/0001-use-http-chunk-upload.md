# ADR-0001: 使用 HTTP 分块上传替代 WebSocket 传文件主体

## 状态
accepted

## 上下文

文件上传需要支持大文件和断点续传。早期设计考虑使用 WebSocket (Socket.io) 传输文件分块，但存在以下问题：

1. Socket.io 对二进制帧有额外封装开销
2. Nginx、FRP 和中间代理可能限制 WebSocket 帧大小和连接时长
3. WebSocket 断线后的恢复语义需要自行完整实现
4. 浏览器和服务端缓冲区会削弱限速和背压效果
5. 大量长连接增加服务端内存压力

## 决策

使用 HTTP 分块上传协议：

1. `POST /api/v1/uploads` 初始化上传会话
2. `PUT /api/v1/uploads/:id/parts/:n` 上传分块（幂等）
3. `POST /api/v1/uploads/:id/complete` 完成上传

WebSocket 仅用于：
- 进度推送
- P2P 信令
- 管理端实时监控

## 后果

**正面：**
- 兼容所有 HTTP 代理和负载均衡器
- 天然支持 HTTP Range 和断点续传
- 无需维护长连接状态
- 更容易实现限速和背压

**负面：**
- 需要额外的上传会话管理
- 分块合并需要额外 I/O

## 替代方案

**WebSocket 传文件主体**： rejected，代理兼容性和内存压力问题

**单请求整体上传**： rejected，不支持断点续传，大文件超时风险

---

*ADR 编号: 0001*
*日期: 2026-07-28*
*决策者: AI Agent*
