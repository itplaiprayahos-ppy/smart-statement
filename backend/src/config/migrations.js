import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

const migrationFiles = async () => (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

/** ไฟล์ migration ที่ยังไม่ได้รันกับฐานข้อมูลนี้ (ยังไม่มีตาราง schema_migrations = ยังไม่ได้รันเลย) */
export async function pendingMigrations() {
  const files = await migrationFiles();
  const { rows: [t] } = await db.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`);
  if (!t.ok) return files;
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  return files.filter((f) => !applied.has(f));
}

/**
 * รัน migration ที่ค้างอยู่ตามลำดับชื่อไฟล์ แต่ละไฟล์อยู่ใน transaction เดียว (ล้มแล้ว rollback และหยุด)
 * คืน { applied: [...], failed: { file, message } | null }
 */
export async function runMigrations(log = () => {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = [];
  for (const file of await pendingMigrations()) {
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      log(`✔ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      log(`✘ ${file}: ${err.message}`, true);
      return { applied, failed: { file, message: err.message } };
    } finally {
      client.release();
    }
  }
  return { applied, failed: null };
}
