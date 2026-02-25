import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env.js';

const pool = new Pool({ connectionString: env.POSTGRES_URL });

export const db = drizzle(pool);
export const pgPool = pool;
