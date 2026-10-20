import app from './app.js';
import { env } from './config/env.js';
import { pendingMigrations, runMigrations } from './config/migrations.js';

/**
 * ตรวจก่อนเปิดเซิร์ฟเวอร์ว่าฐานข้อมูลตรงกับเวอร์ชันโปรแกรมหรือไม่
 * ถ้ามี migration ค้าง (มักเกิดจากแตกไฟล์เวอร์ชันใหม่ทับแล้วลืมรัน npm run migrate) จะไม่เปิดเซิร์ฟเวอร์
 * เพราะทุกหน้าจะล้มด้วยข้อความ column ... does not exist ตั้ง AUTO_MIGRATE=1 ใน .env เพื่อให้รันให้อัตโนมัติ
 * ถ้าเชื่อมต่อฐานข้อมูลไม่ได้ ให้เปิดเซิร์ฟเวอร์ต่อ (เชื่อมต่อได้เมื่อไรก็ใช้งานได้เมื่อนั้น)
 */
async function checkDatabase() {
  let pending;
  try {
    pending = await pendingMigrations();
  } catch (err) {
    console.warn(`⚠ ตรวจเวอร์ชันฐานข้อมูลไม่ได้ (${err.message}) เปิดเซิร์ฟเวอร์ต่อ`);
    return;
  }
  if (!pending.length) return;
  if (env.autoMigrate) {
    console.log(`พบ migration ที่ค้างอยู่ ${pending.length} ไฟล์ กำลังรันให้อัตโนมัติ (AUTO_MIGRATE)`);
    const { failed } = await runMigrations((m) => console.log(m));
    if (failed) { console.error('รัน migration ไม่สำเร็จ ไม่เปิดเซิร์ฟเวอร์'); process.exit(1); }
    return;
  }
  console.error([
    '',
    '✘ ฐานข้อมูลยังไม่ตรงกับเวอร์ชันของโปรแกรม มี migration ที่ยังไม่ได้รัน:',
    ...pending.map((f) => `    - ${f}`),
    '',
    '  แก้ไข: รันคำสั่งนี้ในโฟลเดอร์ backend แล้วเปิดเซิร์ฟเวอร์ใหม่',
    '      npm run migrate',
    '  (หรือใส่ AUTO_MIGRATE=1 ใน .env ให้รันให้เองทุกครั้งที่เปิดเซิร์ฟเวอร์)',
    '',
  ].join('\n'));
  process.exit(1);
}

await checkDatabase();
app.listen(env.port, () => {
  console.log(`claim-recon API พร้อมใช้งานที่ http://localhost:${env.port}`);
});
