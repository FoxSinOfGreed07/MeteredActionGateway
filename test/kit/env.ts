export const TEST_DATABASE_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://gateway:gateway@localhost:5432/postgres';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
export const TEMPLATE_DB = 'mag_template';

export function dbUrl(name: string): string {
  const u = new URL(TEST_DATABASE_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}
