export const manifestFixture = (): any => ({
  version: "0.2.5",
  commit: "a".repeat(40),
  published_at: "2026-09-29T00:00:00.000Z",
  channel: "stable",
  minimum_node: "20.17.0",
  database_migration: true,
  migration_workspace_multiplier: 2,
  migration_workspace_min_bytes: 268435456,
  breaking_changes: false,
  requires_manual_bootstrap: false,
  automatic_update_from: "0.2.0",
  update_protocol: 1,
  min_updater_version: "0.2.0",
  release_notes_url:
    "https://github.com/TZLXM/FileStation-webservice/releases/tag/v0.2.5",
  upgrade_guide_url:
    "https://github.com/TZLXM/FileStation-webservice/blob/master/docs/upgrade.md",
  release_summaries: {
    "zh-CN": { fixes: [{ id: "fix", text: "修复" }] },
    en: { fixes: [{ id: "fix", text: "Fix" }] },
  },
  artifacts: [
    {
      platform: "windows-x64",
      os: "windows",
      arch: "x64",
      filename: "filestation-v0.2.5-win-x64.zip",
      url: "https://github.com/TZLXM/FileStation-webservice/releases/download/v0.2.5/filestation-v0.2.5-win-x64.zip",
      archive_size: 1024,
      unpacked_size: 2048,
      sha256: "a".repeat(64),
      format: "zip",
    },
  ],
});
