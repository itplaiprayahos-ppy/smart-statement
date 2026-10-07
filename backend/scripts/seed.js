// สร้าง admin เริ่มต้น (รันซ้ำได้ ไม่สร้างซ้ำ) รูปแบบไฟล์ REP มาจาก migration
import bcrypt from 'bcryptjs';
import { db } from '../src/config/db.js';

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('กรุณากำหนด ADMIN_PASSWORD ใน .env');

  const hash = await bcrypt.hash(password, 12);
  const u = await db.query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, $2, 'ผู้ดูแลระบบ', 'admin')
     ON CONFLICT (username) DO NOTHING RETURNING id`,
    [username, hash],
  );
  console.log(u.rowCount ? `✔ สร้างผู้ใช้ ${username} (admin)` : `• มีผู้ใช้ ${username} อยู่แล้ว`);

  // รูปแบบไฟล์ REP ถูกสร้างโดย migration 011 แล้ว
  await db.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
