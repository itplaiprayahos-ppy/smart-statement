/**
 * ทดสอบดาวน์โหลดและนำเข้าไฟล์ REP (OP) จาก e-Claim โดยไม่ต้องผ่านเว็บแอป (ระยะที่ 2)
 *   node scripts/nhso-import.js <เดือน 1-12> <ปี พ.ศ.> --only <เลขที่ REP,เลขที่ REP,...>
 * ตัวอย่าง: node scripts/nhso-import.js 9 2569 --only 690900086
 *
 * แนะนำให้ลองกับไฟล์ที่มีรายการน้อย ๆ ก่อน (ดูจำนวนจาก node scripts/nhso-list.js)
 * ต้องระบุ --only เสมอ สคริปต์จะไม่นำเข้าทั้งเดือนโดยไม่ได้ตั้งใจ
 * จะเปิดหน้าต่าง Edge/Chrome ให้สแกน ThaiD เอง แล้วดาวน์โหลดและนำเข้าทีละไฟล์
 * (ผู้นำเข้าในประวัติจะว่างเพราะไม่ได้ผ่านผู้ใช้ของเว็บแอป ตั้ง NHSO_IMPORT_USER_ID=<id ผู้ใช้> เพื่อระบุ)
 */
import { startSession, startImport, getSession, stopSession } from '../src/services/nhsoService.js';

const args = process.argv.slice(2);
const month = Number(args[0]);
const year = Number(args[1]);
const onlyIdx = args.indexOf('--only');
const repNos = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').split(',').map((x) => x.trim()).filter(Boolean) : [];
if (!month || !year || !repNos.length) {
  console.error('วิธีใช้: node scripts/nhso-import.js <เดือน 1-12> <ปี พ.ศ.> --only <เลขที่ REP,...>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = await startSession({ type: 'REP', month, year: year < 2400 ? year + 543 : year });
console.log(`เริ่มเซสชัน: ${first.message}`);

let last = '';
let importing = false;
for (;;) {
  const s = getSession(first.id);
  if (!s) break;
  const line = `[${s.status}] ${s.message}`;
  if (line !== last) { console.log(line); last = line; }

  if (s.status === 'ready' && !importing) {
    importing = true;
    const chosen = s.files.filter((f) => repNos.includes(f.repNo));
    console.log('\nไฟล์ที่เลือก:');
    console.table(chosen.map(({ repNo, sentAt, type, total, passed, failed, imported }) =>
      ({ repNo, sentAt, type, total, passed, failed, imported })));
    const userId = process.env.NHSO_IMPORT_USER_ID ? Number(process.env.NHSO_IMPORT_USER_ID) : null;
    try {
      await startImport(first.id, { repNos, userId });
    } catch (err) {
      console.error('เริ่มนำเข้าไม่ได้:', err.message);
      await stopSession(first.id);
      break;
    }
  }

  if (s.status === 'imported' || s.status === 'error' || s.status === 'closed') {
    if (s.importResults) console.table(s.importResults);
    if (s.status !== 'imported') console.log('debug:', JSON.stringify(s.debug, null, 2));
    await stopSession(first.id);
    break;
  }
  await sleep(1500);
}
process.exit(0);
