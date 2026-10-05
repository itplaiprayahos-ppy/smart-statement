// สร้างไฟล์ REP ตัวอย่างจากฐาน HOSxP จำลอง (db/dev/mock_hosxp.sql) สำหรับทดสอบการนำเข้า
// ใช้: npm run sample  (ต้องตั้ง HOSXP_* ใน .env ให้ชี้ฐานจำลอง)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { hosxp } from '../src/config/db.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples/sample_rep_opd_2569-09.xlsx');

const toThaiDate = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${Number(y) + 543}`;
};

// เขียนเป็นเลข serial ของ Excel ตรง ๆ (เลี่ยงปัญหา timezone ของ Date object)
const toExcelSerial = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + 25569;

async function main() {
  const { rows } = await hosxp.query(`
    SELECT v.vn, v.hn, p.cid, p.pname || p.fname || ' ' || p.lname AS name,
           v.vstdate::text AS vstdate, v.uc_money
    FROM vn_stat v JOIN patient p ON p.hn = v.hn JOIN pttype t ON t.pttype = v.pttype
    WHERE t.hipdata_code = 'UCS' AND v.uc_money > 0
    ORDER BY v.vstdate, v.vn`);

  // ยอดค่าบริการรายกองทุนของแต่ละ visit จาก opitemrece
  const { rows: itemRows } = await hosxp.query(`
    SELECT vn, icode, SUM(sum_price) AS amt FROM opitemrece
    WHERE icode IN ('3000001','3100001','3200001','3300001','1600001') GROUP BY vn, icode`);
  const itemsOf = {};
  itemRows.forEach((r) => { (itemsOf[r.vn] ||= {})[r.icode] = Number(r.amt); });

  // หัวตาราง 2 ชั้น แบบไฟล์ REP: คอลัมน์หลัก merge แนวตั้ง, กลุ่มกองทุน merge แนวนอน
  const main = ['REP No.', 'TRAN_ID', 'HN', 'AN', 'PID', 'ชื่อ-สกุล', 'วันเข้ารักษา',
    'สิทธิ', 'เรียกเก็บ', 'ชดเชยสุทธิ', 'ERROR CODE'];
  const top = [...main, 'HC', null, 'AE', null, 'INST', 'DMIS', null, null, null];
  const sub = [...main.map(() => null), 'HC', 'DRUG', 'AE', 'DRUG', null,
    'ยอดชดเชยที่จ่ายจริง', 'DMISHD', 'Palliative care', 'PP'];
  const aoa = [
    ['รายงานผลการพิจารณาจ่ายชดเชย (ข้อมูลตัวอย่าง)'],
    ['หน่วยบริการ: 99999 โรงพยาบาลทดสอบ'],
    [],
    top,
    sub,
  ];
  const HEAD = 3; // index แถวหัวตารางแถวแรก

  rows.forEach((v, k) => {
    if (k % 10 === 3) return; // ไม่ส่ง -> ไม่พบใน Statement
    const amount = Number(v.uc_money);
    let claim = amount;
    let comp = amount;
    let err = '';
    if (k % 10 === 5) { claim = amount + 120; comp = amount + 120; } // ยอดต่าง
    if (k % 10 === 7) { comp = 0; err = 'C438'; }                    // ติด C
    // ครึ่งหนึ่งเป็นข้อความวันที่ พ.ศ. อีกครึ่งเป็น Excel date เพื่อทดสอบการอ่านวันที่
    const date = k % 2 ? toThaiDate(v.vstdate) : toExcelSerial(v.vstdate);
    // ยอดกองทุน: ได้รับ 80% ของค่าบริการ ยกเว้นบางรายที่ไม่ได้รับเงินกองทุน (ทดสอบสถานะ "ไม่ได้รับเงินกองทุนนี้")
    const it = itemsOf[v.vn] || {};
    const pay = (icode) => (it[icode] && k % 4 !== 1 && !err ? Math.round(it[icode] * 0.8) : 0);
    aoa.push(['690900' + String(1 + (k % 3)), `T${v.vn}`, v.hn, '', v.cid, v.name, date,
      'UCS', claim, comp, err,
      pay('3000001'), pay('1600001'), pay('3100001'), 0, pay('3200001'), 0, 0, 0, pay('3300001')]);
  });

  // รายการที่ไม่มีใน HOSxP
  aoa.push(['6909001', 'T999999000001', '000099999', '', '3999999999991', 'นายนอก ระบบ',
    '10/09/2569', 'UCS', 500, 500, '']);
  aoa.push(['6909002', 'T999999000002', '000099998', '', '3999999999992', 'นางนอก ระบบ',
    '20/09/2569', 'UCS', 650, 0, 'C301']);
  aoa.push([]);
  aoa.push(['', '', '', '', '', '', '', 'รวม', '', '', '']);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [
    ...main.map((_, c) => ({ s: { r: HEAD, c }, e: { r: HEAD + 1, c } })),
    { s: { r: HEAD, c: 11 }, e: { r: HEAD, c: 12 } },     // HC
    { s: { r: HEAD, c: 13 }, e: { r: HEAD, c: 14 } },     // AE
    { s: { r: HEAD, c: 15 }, e: { r: HEAD + 1, c: 15 } }, // INST
    { s: { r: HEAD, c: 16 }, e: { r: HEAD, c: 19 } },     // DMIS
  ];
  // จัดรูปแบบเซลล์วันที่ที่เป็นตัวเลขให้แสดงเป็นวันที่ใน Excel
  aoa.forEach((row, r) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 6 })];
    if (r > HEAD + 1 && cell && cell.t === 'n') cell.z = 'dd/mm/yyyy';
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'REP');
  XLSX.writeFile(wb, out);
  console.log(`✔ สร้าง ${out} (${aoa.length - 5} แถว)`);
  await hosxp.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
