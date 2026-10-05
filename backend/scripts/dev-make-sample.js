// สร้างไฟล์ REP ตัวอย่างจากฐาน HOSxP จำลอง (db/dev/mock_hosxp.sql) สำหรับทดสอบการนำเข้า
// โครงสร้างเลียนแบบไฟล์ REP OPD จริงจาก e-Claim: หัวรายงานด้านบน + หัวตาราง 3 ชั้น
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

// ---------- หัวตาราง 3 ชั้น ----------
const MAIN = ['REP', 'ลำดับที่', 'TRAN_ID', 'HN', 'AN', 'PID', 'ชื่อ - สกุล', 'วันเข้ารักษา',
  'วันจำหน่าย', 'MAININSCL', 'PROJCODE', 'เรียกเก็บ'];                         // 0-11 merge แนวตั้ง 3 แถว
const COL = {
  IP_PRB: 12, IP_ADJRW: 13,                                                   // กลุ่ม "กองทุน IP"
  OP: 14, IP_CALC: 15, IP_PAID: 16, HC: 17, HC_DRUG: 18, AE: 19, AE_DRUG: 20,
  INST: 21, DMIS_CALC: 22, DMIS_PAID: 23, DMIS_DRUG: 24, PALL: 25, DMISHD: 26, PP: 27, FS: 28,
  TOTAL: 29,                                                                  // ยอดชดเชยทั้งสิ้น
};
const WIDTH = 30;
const HEAD = 11; // index แถวหัวตารางแถวแรก (แถว 12 ใน Excel)

function headerRows() {
  const top = Array(WIDTH).fill(null);
  const mid = Array(WIDTH).fill(null);
  const bot = Array(WIDTH).fill(null);
  MAIN.forEach((h, c) => { top[c] = h; });
  top[COL.IP_PRB] = 'กองทุน IP';
  mid[COL.IP_PRB] = 'พรบ.'; bot[COL.IP_PRB] = '(2)';
  mid[COL.IP_ADJRW] = 'AdjRW'; bot[COL.IP_ADJRW] = '(3)';
  top[COL.OP] = 'ยอดจ่ายชดเชย';
  mid[COL.OP] = 'OP';
  mid[COL.IP_CALC] = 'IP'; bot[COL.IP_CALC] = 'ยอดชดเชยที่คำนวณได้'; bot[COL.IP_PAID] = 'ยอดชดเชยที่จ่ายจริง';
  mid[COL.HC] = 'HC'; bot[COL.HC] = 'HC'; bot[COL.HC_DRUG] = 'DRUG';
  mid[COL.AE] = 'AE'; bot[COL.AE] = 'AE'; bot[COL.AE_DRUG] = 'DRUG';
  mid[COL.INST] = 'INST';
  mid[COL.DMIS_CALC] = 'DMIS';
  bot[COL.DMIS_CALC] = 'ยอดชดเชยที่คำนวณได้'; bot[COL.DMIS_PAID] = 'ยอดชดเชยที่จ่ายจริง'; bot[COL.DMIS_DRUG] = 'DMIS_DRUG';
  mid[COL.PALL] = 'Palliative care'; mid[COL.DMISHD] = 'DMISHD'; mid[COL.PP] = 'PP'; mid[COL.FS] = 'FS';
  top[COL.TOTAL] = 'ยอดชดเชยทั้งสิ้น';
  return [top, mid, bot];
}

function merges() {
  const m = (r1, c1, r2, c2) => ({ s: { r: HEAD + r1, c: c1 }, e: { r: HEAD + r2, c: c2 } });
  return [
    ...MAIN.map((_, c) => m(0, c, 2, c)),                 // คอลัมน์หลัก แนวตั้ง 3 แถว
    m(0, COL.IP_PRB, 0, COL.IP_ADJRW),                    // กองทุน IP
    m(0, COL.OP, 0, COL.FS),                              // หัวกลุ่มยอดจ่าย
    m(1, COL.OP, 2, COL.OP),
    m(1, COL.IP_CALC, 1, COL.IP_PAID),
    m(1, COL.HC, 1, COL.HC_DRUG),
    m(1, COL.AE, 1, COL.AE_DRUG),
    m(1, COL.INST, 2, COL.INST),
    m(1, COL.DMIS_CALC, 1, COL.DMIS_DRUG),
    m(1, COL.PALL, 2, COL.PALL), m(1, COL.DMISHD, 2, COL.DMISHD), m(1, COL.PP, 2, COL.PP), m(1, COL.FS, 2, COL.FS),
    m(0, COL.TOTAL, 2, COL.TOTAL),
  ];
}

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

  const aoa = [
    ['ออกรายงานวันที่ 05/10/2569 เวลา 09:39 (ข้อมูลตัวอย่าง)'],
    [],
    ['โรงพยาบาล 99999 รพ.ทดสอบ'],
    ['จังหวัด ทดสอบ'],
    [],
    ['เลขที่เอกสาร 99999 OPUCS256909 01'],
    [], [], [],
    ['ข้อมูลปกติ'],
    [],
    ...headerRows(),
  ];

  let seq = 0;
  rows.forEach((v, k) => {
    if (k % 10 === 3) return; // ไม่ส่ง -> ไม่พบใน Statement
    const amount = Number(v.uc_money);
    const claim = k % 10 === 5 ? amount + 120 : amount; // ยอดต่าง
    // ยอดกองทุน: ได้รับ 80% ของค่าบริการ ยกเว้นบางรายที่ไม่ได้รับเงินกองทุน
    const it = itemsOf[v.vn] || {};
    const pay = (icode) => (it[icode] && k % 4 !== 1 ? Math.round(it[icode] * 0.8) : 0);
    const row = Array(WIDTH).fill(0);
    const date = k % 2 ? toThaiDate(v.vstdate) : toExcelSerial(v.vstdate);
    [`690900${1 + (k % 3)}`, ++seq, `T${v.vn}`, v.hn, '', v.cid, v.name, date, date, 'UCS', '', claim]
      .forEach((x, c) => { row[c] = x; });
    row[COL.OP] = k % 10 === 7 ? 0 : amount;
    row[COL.HC] = pay('3000001');
    row[COL.HC_DRUG] = pay('1600001');
    row[COL.AE] = pay('3100001');
    row[COL.INST] = pay('3200001');
    row[COL.PP] = pay('3300001');
    row[COL.TOTAL] = row[COL.OP] + row[COL.HC] + row[COL.HC_DRUG] + row[COL.AE] + row[COL.INST] + row[COL.PP];
    aoa.push(row);
  });

  // รายการที่ไม่มีใน HOSxP (ได้รับเงิน HC -> ตรวจย้อนกลับ)
  const extra = Array(WIDTH).fill(0);
  ['6909001', ++seq, 'T999999000001', '000099999', '', '3999999999991', 'นายนอก ระบบ', '10/09/2569',
    '10/09/2569', 'UCS', '', 500].forEach((x, c) => { extra[c] = x; });
  extra[COL.HC] = 400; extra[COL.TOTAL] = 400;
  aoa.push(extra);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges();
  aoa.forEach((row, r) => {
    if (r <= HEAD + 2) return;
    [7, 8].forEach((c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === 'n') cell.z = 'dd/mm/yyyy';
    });
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'รายละเอียด(ข้อมูลปกติ) 1 OP');
  XLSX.writeFile(wb, out);
  console.log(`✔ สร้าง ${out} (${aoa.length - HEAD - 3} แถว)`);
  await hosxp.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
