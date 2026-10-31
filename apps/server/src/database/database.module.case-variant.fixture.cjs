const path = require('node:path');
const { createRequire } = require('node:module');

const managedRoot = process.argv[2];
const workspaceRoot = process.argv[3];
if (!managedRoot || !workspaceRoot) {
  throw new Error('fixture requires managed and workspace roots');
}

process.chdir(managedRoot);
process.env.TS_NODE_PROJECT = path.join(
  workspaceRoot,
  'apps',
  'server',
  'tsconfig.json',
);
require('ts-node/register/transpile-only');

const workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
const typeormDirectory = path.dirname(workspaceRequire.resolve('typeorm'));
const typeormGlob = require(path.join(
  typeormDirectory,
  'node_modules',
  'glob',
));
const originalSync = typeormGlob.sync;
typeormGlob.sync = function caseVariantGlob(pattern, options) {
  const matches = originalSync.call(this, pattern, options) ?? [];
  if (!String(pattern).includes('.entity')) return matches;
  const marker = `${path.sep}files${path.sep}entities${path.sep}file.entity.`;
  return matches.map((filename) =>
    filename.includes(marker)
      ? filename.replace(
          marker,
          `${path.sep}FILES${path.sep}entities${path.sep}file.entity.`,
        )
      : filename,
  );
};

const sourceRoot = path.join(workspaceRoot, 'apps', 'server', 'src');
const { Test } = require('@nestjs/testing');
const { ConfigModule } = require('@nestjs/config');
const { DataSource } = require('typeorm');
const { DatabaseModule } = require(
  path.join(sourceRoot, 'database', 'database.module.ts'),
);
const { File } = require(
  path.join(sourceRoot, 'files', 'entities', 'file.entity.ts'),
);
const { SystemMeta } = require(
  path.join(sourceRoot, 'auth', 'entities', 'system-meta.entity.ts'),
);

async function main() {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        load: [
          () => ({
            app: {
              dbPath: ':memory:',
              nodeEnv: 'test',
            },
          }),
        ],
        isGlobal: true,
      }),
      DatabaseModule,
    ],
  }).compile();

  try {
    await module.init();
    const dataSource = module.get(DataSource);
    process.stdout.write(
      `${JSON.stringify({
        metadataCount: dataSource.entityMetadatas.length,
        fileTargetIdentity:
          dataSource.getMetadata(File).target === File,
        systemMetaTargetIdentity:
          dataSource.getMetadata(SystemMeta).target === SystemMeta,
        migrationClasses: (
          dataSource.options.migrations ?? []
        ).map((migration) => migration.name),
      })}\n`,
    );
  } finally {
    await module.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
