import { migrate } from '../src/db/migrate.js';
import { loadEnv } from '../src/shared/config.js';

const env = loadEnv();
const res = await migrate(env.DATABASE_URL);
console.log(`migrations applied: [${res.applied.join(', ')}] skipped: [${res.skipped.join(', ')}]`);
