import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     Number(process.env.PG_PORT) || 5432,
  user:     process.env.PG_USER     || 'bot_support',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DB       || 'bot_support',
});

// one(sql, params)  — вернуть первую строку или null
// many(sql, params) — вернуть массив строк
// run(sql, params)  — выполнить без возврата данных
pool.one  = (sql, p) => pool.query(sql, p).then(r => r.rows[0] ?? null);
pool.many = (sql, p) => pool.query(sql, p).then(r => r.rows);
pool.run  = (sql, p) => pool.query(sql, p);

export default pool;
