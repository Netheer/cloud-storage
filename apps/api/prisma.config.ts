import { config } from 'dotenv';
import { defineConfig, env } from 'prisma/config';
import { resolve } from 'node:path';

config({
  path: resolve(process.cwd(), '../../.env'),
});

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});