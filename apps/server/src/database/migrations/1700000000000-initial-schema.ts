import { MigrationInterface, QueryRunner } from 'typeorm';

// ============================================================================
// Phase 1 实际使用的表:
//   admin_accounts, sessions, system_meta, folders, files,
//   upload_sessions, upload_parts, shares, download_sessions,
//   download_tickets, settings
// Phase 2+ 预留（Phase 1 建表但不读写，禁止为其写业务代码）:
//   authenticators, api_tokens, login_challenges, recovery_codes,
//   temp_codes, temp_code_sessions, entries, transfer_events,
//   transfer_stats_hourly, audit_logs
// ============================================================================

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`PRAGMA foreign_keys = ON`);

    // 管理员账户
    await queryRunner.query(`
      CREATE TABLE admin_accounts (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1
      )
    `);

    // 认证器
    await queryRunner.query(`
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
      )
    `);

    // API Token
    await queryRunner.query(`
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
      )
    `);

    // 会话
    await queryRunner.query(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES admin_accounts(id),
        refresh_token_hash TEXT NOT NULL,
        device_info TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE(refresh_token_hash)
      )
    `);

    // 登录挑战
    await queryRunner.query(`
      CREATE TABLE login_challenges (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES admin_accounts(id),
        challenge_type TEXT NOT NULL CHECK(challenge_type IN ('totp', 'webauthn')),
        challenge_data TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      )
    `);

    // 恢复码
    await queryRunner.query(`
      CREATE TABLE recovery_codes (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES admin_accounts(id),
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    // 系统元数据
    await queryRunner.query(`
      CREATE TABLE system_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // 文件夹（邻接表模型）
    await queryRunner.query(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES folders(id),
        created_by TEXT NOT NULL REFERENCES admin_accounts(id),
        created_at INTEGER NOT NULL,
        is_deleted INTEGER DEFAULT 0,
        deleted_at INTEGER
      )
    `);

    // 文件夹唯一索引（部分索引解决 NULL 问题）
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_folder_child_name
      ON folders(parent_id, name)
      WHERE parent_id IS NOT NULL AND is_deleted = 0
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_folder_root_name
      ON folders(name)
      WHERE parent_id IS NULL AND is_deleted = 0
    `);

    // v1.6 新增：文件夹 parent 索引
    await queryRunner.query(`CREATE INDEX idx_folders_parent ON folders(parent_id)`);

    // 文件
    await queryRunner.query(`
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
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_files_folder ON files(folder_id)`);
    await queryRunner.query(`CREATE INDEX idx_files_status_expires ON files(status, expires_at)`);
    await queryRunner.query(`CREATE INDEX idx_files_created ON files(created_at)`);

    // 上传会话
    await queryRunner.query(`
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
        final_stored_name TEXT,
        final_file_id TEXT REFERENCES files(id),
        verify_started_at INTEGER,
        -- v1.7 新增：finalizer 租约（阻断 4：防 5 分钟误杀正常合并）
        verify_owner_token TEXT,
        verify_lease_until INTEGER,
        verify_heartbeat_at INTEGER,
        -- v1.7 新增：上传目标文件夹（建议 c：初始化持久化，阶段三直写，替代完成后二次 PATCH）
        target_folder_id TEXT REFERENCES folders(id),
        failure_reason TEXT,
        temp_path TEXT NOT NULL,
        principal_type TEXT NOT NULL CHECK(principal_type IN ('admin', 'temp_code')),
        principal_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        completed_at INTEGER,
        CHECK(received_size <= expected_size)
      )
    `);

    // v1.6 新增：上传会话索引
    // 注：upload_token_hash 已有 UNIQUE 约束（自动索引），idx_upload_sessions_token 显式命名
    // 保证跨 SQLite 版本查询计划可预期；实体侧不再重复定义 @Index
    await queryRunner.query(`CREATE INDEX idx_upload_sessions_token ON upload_sessions(upload_token_hash)`);
    await queryRunner.query(`CREATE INDEX idx_upload_sessions_status ON upload_sessions(status, expires_at)`);

    // 上传分块（并发安全字段）
    await queryRunner.query(`
      CREATE TABLE upload_parts (
        upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
        part_number INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving', 'ready')),
        owner_token TEXT,
        temp_name TEXT,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (upload_id, part_number)
      )
    `);

    // 分享（Phase 1 仅 page 类型，仅 none/password 保护）
    await queryRunner.query(`
      CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('page')),
        protection TEXT NOT NULL DEFAULT 'none'
          CHECK(protection IN ('none', 'password')),
        password_hash TEXT,
        max_downloads INTEGER CHECK(max_downloads IS NULL OR max_downloads >= 0),
        used_downloads INTEGER DEFAULT 0 CHECK(used_downloads >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
        created_by TEXT NOT NULL REFERENCES admin_accounts(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        last_used_at INTEGER,
        CHECK((protection = 'password' AND password_hash IS NOT NULL)
              OR (protection <> 'password' AND password_hash IS NULL))
      )
    `);

    // v1.6 新增：分享索引
    await queryRunner.query(`CREATE INDEX idx_shares_file ON shares(file_id)`);
    await queryRunner.query(`CREATE INDEX idx_shares_status ON shares(status, expires_at)`);

    // 下载会话
    await queryRunner.query(`
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
      )
    `);

    // v1.6 新增：下载会话索引
    await queryRunner.query(`CREATE INDEX idx_download_sessions_share ON download_sessions(share_id)`);

    // 临时码
    await queryRunner.query(`
      CREATE TABLE temp_codes (
        id TEXT PRIMARY KEY,
        code_secret_hash TEXT NOT NULL,
        label TEXT,
        permissions TEXT NOT NULL,
        max_uses INTEGER CHECK(max_uses IS NULL OR max_uses >= 0),
        used_count INTEGER DEFAULT 0 CHECK(used_count >= 0),
        rate_limit_bps INTEGER CHECK(rate_limit_bps IS NULL OR rate_limit_bps >= 0),
        reserved_files INTEGER DEFAULT 0 CHECK(reserved_files >= 0),
        completed_files INTEGER DEFAULT 0 CHECK(completed_files >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
        created_by TEXT NOT NULL REFERENCES admin_accounts(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      )
    `);

    // 临时码会话
    await queryRunner.query(`
      CREATE TABLE temp_code_sessions (
        id TEXT PRIMARY KEY,
        temp_code_id TEXT NOT NULL REFERENCES temp_codes(id) ON DELETE CASCADE,
        session_token_hash TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(session_token_hash)
      )
    `);

    // 传输入口
    await queryRunner.query(`
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
      )
    `);

    // 传输事件
    await queryRunner.query(`
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
      )
    `);

    // v1.6 新增：传输事件时间索引
    await queryRunner.query(`CREATE INDEX idx_transfer_events_time ON transfer_events(occurred_at)`);

    // v1.6 新增：每小时传输统计表（Phase 2+ 预留：Phase 1 建表但不读写，禁止为其写业务代码）
    // 结构与设计文档 §4.7 对齐：按小时 × 入口聚合
    await queryRunner.query(`
      CREATE TABLE transfer_stats_hourly (
        hour_timestamp INTEGER NOT NULL,
        entry_id TEXT,  -- v1.7：NULL = 无法归属具体入口的统计（与设计文档 §4.7 一致）
        upload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(upload_bytes >= 0),
        download_bytes INTEGER NOT NULL DEFAULT 0 CHECK(download_bytes >= 0),
        upload_count INTEGER NOT NULL DEFAULT 0 CHECK(upload_count >= 0),
        download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count >= 0),
        PRIMARY KEY (hour_timestamp, entry_id)
      )
    `);

    // 审计日志
    await queryRunner.query(`
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
      )
    `);

    // v1.6 新增：审计日志索引
    await queryRunner.query(`CREATE INDEX idx_audit_logs_account ON audit_logs(account_id, created_at)`);
    await queryRunner.query(`CREATE INDEX idx_audit_logs_action ON audit_logs(action, created_at)`);

    // 下载票据（支持多 Range 请求）
    await queryRunner.query(`
      CREATE TABLE download_tickets (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        download_session_id TEXT NOT NULL REFERENCES download_sessions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      )
    `);

    // 设置
    await queryRunner.query(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT REFERENCES admin_accounts(id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS settings`);
    await queryRunner.query(`DROP TABLE IF EXISTS download_tickets`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs`);
    await queryRunner.query(`DROP TABLE IF EXISTS transfer_stats_hourly`);
    await queryRunner.query(`DROP TABLE IF EXISTS transfer_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS entries`);
    await queryRunner.query(`DROP TABLE IF EXISTS temp_code_sessions`);
    await queryRunner.query(`DROP TABLE IF EXISTS temp_codes`);
    await queryRunner.query(`DROP TABLE IF EXISTS download_sessions`);
    await queryRunner.query(`DROP TABLE IF EXISTS shares`);
    await queryRunner.query(`DROP TABLE IF EXISTS upload_parts`);
    await queryRunner.query(`DROP TABLE IF EXISTS upload_sessions`);
    await queryRunner.query(`DROP TABLE IF EXISTS files`);
    await queryRunner.query(`DROP TABLE IF EXISTS folders`);
    await queryRunner.query(`DROP TABLE IF EXISTS system_meta`);
    await queryRunner.query(`DROP TABLE IF EXISTS recovery_codes`);
    await queryRunner.query(`DROP TABLE IF EXISTS login_challenges`);
    await queryRunner.query(`DROP TABLE IF EXISTS sessions`);
    await queryRunner.query(`DROP TABLE IF EXISTS api_tokens`);
    await queryRunner.query(`DROP TABLE IF EXISTS authenticators`);
    await queryRunner.query(`DROP TABLE IF EXISTS admin_accounts`);
  }
}
