import pg from 'pg';
import { env } from './env.js';

// ให้ DATE ของ PostgreSQL ออกมาเป็นสตริง 'YYYY-MM-DD' ตรง ๆ ไม่แปลงเป็น Date (กันปัญหา timezone)
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC ออกมาเป็น number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/** ฐานข้อมูลของระบบ (อ่าน/เขียน) */
export const db = new pg.Pool({ ...env.db, max: 10 });

/** ฐานข้อมูล HOSxP (อ่านอย่างเดียว) */
export const hosxp = new pg.Pool({
  ...env.hosxp,
  max: 3,
  statement_timeout: 120_000,
  application_name: 'claim-recon',
  // ป้องกันการเขียน HOSxP โดยไม่ตั้งใจ: ทุก session เป็น read-only
  options: '-c default_transaction_read_only=on',
});

export async function withTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
