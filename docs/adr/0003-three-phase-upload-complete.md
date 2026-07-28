# ADR-0003: 上传完成采用三阶段分离

## 状态
accepted

## 上下文

文件上传完成时需要：
1. 校验分块完整性
2. 计算文件哈希
3. 移动临时文件到正式存储
4. 创建 files 数据库记录

早期设计在单个 SQLite 事务中完成所有操作，但存在严重问题：

1. 大文件哈希计算可能耗时数分钟，阻塞其他写操作
2. 文件系统操作和 SQL 事务无法真正原子化
3. 进程崩溃时状态不一致

## 决策

采用三阶段分离：

**阶段一：短事务抢占**
```sql
BEGIN IMMEDIATE;
UPDATE upload_sessions SET status = 'verifying' WHERE id = ? AND status IN ('initiated', 'uploading');
COMMIT;
```

**阶段二：事务外处理**
- 校验分块
- 计算哈希
- 移动文件

**阶段三：短事务完成**
```sql
BEGIN IMMEDIATE;
INSERT INTO files (...);
UPDATE upload_sessions SET status = 'completed', final_file_id = ? WHERE id = ? AND status = 'verifying';
COMMIT;
```

## 后果

**正面：**
- 避免长事务阻塞数据库
- 崩溃时可从 `verifying` 状态恢复
- 文件系统操作失败不影响数据库

**负面：**
- 实现复杂度增加
- 需要额外的崩溃恢复任务

## 替代方案

**单事务完成**： rejected，大文件阻塞数据库

**异步任务队列**： rejected，MVP 阶段过度设计

---

*ADR 编号: 0003*
*日期: 2026-07-28*
*决策者: AI Agent*
