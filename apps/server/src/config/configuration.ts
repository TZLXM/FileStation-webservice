import { registerAs } from '@nestjs/config';

export default registerAs('app', () => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const jwtSecret = process.env.JWT_SECRET;

  // 生产环境必须设置 JWT_SECRET
  if (nodeEnv === 'production' && !jwtSecret) {
    throw new Error('JWT_SECRET is required in production');
  }

  return {
    nodeEnv,
    port: parseInt(process.env.FILESTATION_PORT || '8080', 10),
    storagePath: process.env.FILESTATION_STORAGE_PATH || './data/storage',
    tempPath: process.env.FILESTATION_TEMP_PATH || './data/temp',
    dbPath: process.env.FILESTATION_DB_PATH || './data/filestation.db',
    jwtSecret: jwtSecret || 'dev-secret-change-in-production',
    jwtExpiresIn: '24h',
    refreshTokenExpiresIn: '7d',
  };
});
