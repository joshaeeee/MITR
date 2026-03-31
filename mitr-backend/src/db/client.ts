import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { infrastructureConfig } from '../config/infrastructure-config.js';

const pool = new Pool({ connectionString: infrastructureConfig.postgresUrl });

export const db = drizzle(pool);
export const pgPool = pool;
