// สร้างไฟล์ migration ตารางรหัสข้อผิดพลาด e-Claim จาก db/seed/eclaim_error_codes.tsv
// ใช้เมื่อแก้ไฟล์ .tsv แล้วต้องการสร้าง migration ใหม่:  node scripts/build-error-codes-migration.js 0XX_error_codes_update.sql
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseErrorCodeText } from '../src/services/errorCodeService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] || '014_error_codes_seed.sql';
const rows = parseErrorCodeText(fs.readFileSync(path.join(root, 'db/seed/eclaim_error_codes.tsv'), 'utf8'));

const q = (s) => {
  if (s === null || s === undefined) return 'NULL';
  if (s.includes('$ec$')) throw new Error('ข้อความมี $ec$');
  return `$ec$${s}$ec$`;
};

const sql = [
  '-- =====================================================================',
  `-- ${name} : ตารางรหัสข้อผิดพลาด e-Claim (ติด C) ${rows.length} รหัส`,
  '-- สร้างอัตโนมัติจาก db/seed/eclaim_error_codes.tsv ด้วย scripts/build-error-codes-migration.js',
  '-- รหัสที่มีอยู่แล้วจะถูกอัปเดตเป็นข้อความในไฟล์นี้ (แก้ไขเพิ่มเติมได้ที่เมนู "รหัสข้อผิดพลาด")',
  '-- =====================================================================',
  'INSERT INTO error_codes (code, description, guidance) VALUES',
  rows.map((r) => `  (${q(r.code)}, ${q(r.description)}, ${q(r.guidance)})`).join(',\n'),
  'ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, guidance = EXCLUDED.guidance, updated_at = now();',
  '',
].join('\n');

fs.writeFileSync(path.join(root, 'db/migrations', name), sql);
console.log(`✔ db/migrations/${name} (${rows.length} รหัส)`);
