/**
 * ทดสอบอ่านรายการไฟล์ REP จาก e-Claim โดยไม่ต้องผ่านเว็บแอป (ระยะที่ 1: อ่านรายการเท่านั้น ไม่ดาวน์โหลด)
 *   node scripts/nhso-list.js <เดือน 1-12> <ปี พ.ศ.>      เช่น  node scripts/nhso-list.js 9 2569
 * จะเปิดหน้าต่าง Edge/Chrome ให้สแกน ThaiD ด้วยตัวเอง แล้วพิมพ์ผลลัพธ์ออกทางหน้าจอ
 */
import { startSession, getSession, stopSession } from '../src/services/nhsoService.js';

const month = Number(process.argv[2]);
const year = Number(process.argv[3]);
if (!month || !year) {
  console.error('วิธีใช้: node scripts/nhso-list.js <เดือน 1-12> <ปี พ.ศ.>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = await startSession({ type: 'REP', month, year: year < 2400 ? year + 543 : year });
console.log(`เริ่มเซสชัน ${first.id}: ${first.message}`);

let last = '';
let lastSeen = '';
for (;;) {
  const s = getSession(first.id);
  if (!s) break;
  const line = `[${s.status}] ${s.message}`;
  if (line !== last) { console.log(line); last = line; }
  if (s.status === 'waiting_login' && s.debug?.pages) {
    const snap = JSON.stringify(s.debug.pages);
    if (snap !== lastSeen) {
      console.log('  เห็นหน้า:', s.debug.pages.map((p) => `${p.url} | ${p.text}`).join(' || '));
      lastSeen = snap;
    }
  }
  if (['ready', 'error', 'closed'].includes(s.status)) {
    console.log('\nสรุป:', s.summary);
    console.table(s.files.map(({ repNo, sentAt, type, total, passed, failed, imported, hasExcel }) =>
      ({ repNo, sentAt, type, total, passed, failed, imported, hasExcel })));
    console.log('debug:', JSON.stringify(s.debug, null, 2));
    await stopSession(first.id);
    break;
  }
  await sleep(1500);
}
process.exit(0);
