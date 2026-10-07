// สร้างไฟล์ REP ตัวอย่าง (ข้อมูลสมมติ) จากฐาน HOSxP จำลอง (db/dev/mock_hosxp.sql) สำหรับทดสอบการนำเข้า
// โครงสร้างเลียนแบบไฟล์ REP OPD จาก e-Claim ชีต Detail: หัวรายงานแถว 1-5 + หัวตาราง 3 ชั้น (แถว 6-8)
// มีเฉพาะคอลัมน์ที่ระบบใช้ ไฟล์จริงมีคอลัมน์มากกว่านี้
// ใช้: npm run sample  (ต้องตั้ง HOSXP_* ใน .env ให้ชี้ฐานจำลอง)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { hosxp } from '../src/config/db.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples/sample_rep_opd_2569-09.xlsx');
const REP_NO = '690900001';
const HEAD = 5; // index ของแถวหัวตารางแรก (แถว 6 ใน Excel)

// [หัวชั้น 1, ชั้น 2, ชั้น 3] ต่อคอลัมน์ (null = ว่าง / ถูก merge)
const COLS = [
  ['REP No.'], ['ลำดับที่'], ['TRAN_ID'], ['HN'], ['AN'], ['PID'], ['ชื่อ-สกุล'], ['ประเภทผู้ป่วย'],
  ['วันเข้ารักษา'], ['วันจำหน่าย'],
  ['ชดเชยสุทธิ', 'สปสช.'], [null, 'ต้นสังกัด'],
  ['Error Code'], ['สิทธิหลัก'],
  ['เรียกเก็บ\n(1)', 'กลุ่มที่ไม่ใช่กลุ่มค่ารถ+ค่ายา+ค่าอุปกรณ์\n(1.1)'],
  [null, 'กลุ่มที่เป็น\nค่ารถ+ค่ายา+\nค่าอุปกรณ์\n(1.2)'],
  [null, 'รวมยอดเรียกเก็บ\n(1.3) = (1.1)+(1.2)'],
  ['ค่าใช้จ่ายสูง (HC)', 'IPHC'], [null, 'OPHC'],
  ['อุบัติเหตุฉุกเฉิน (AE)', 'OPAE\n(1.1*4*5)'], [null, 'CARAE'],
  ['อวัยวะเทียม/อุปกรณ์บำบัดรักษา (INST)', 'OPINST'], [null, 'INST'],
  ['โรคเฉพาะ (DMIS)', 'CATARACT', 'CATARACT'], [null, null, 'ค่าภาระงาน(รพ.)'],
  [null, 'PP'], [null, 'DMISHD'], [null, 'Paliative Care'],
  ['DRUG'],
  ['Deny', 'HC'], [null, 'AE'],
  ['FS'],
];
const C = Object.fromEntries([
  'REP', 'SEQ', 'TRAN', 'HN', 'AN', 'PID', 'NAME', 'PTYPE', 'DATE', 'DCH', 'COMP', 'COMP_ORG', 'ERR', 'MAININSCL',
  'CLAIM11', 'CLAIM12', 'CLAIM13', 'IPHC', 'OPHC', 'OPAE', 'CARAE', 'OPINST', 'INST', 'CAT', 'CAT_WL',
  'PP', 'DMISHD', 'PALL', 'DRUG', 'DENY_HC', 'DENY_AE', 'FS',
].map((k, i) => [k, i]));

function merges() {
  const m = [];
  const lastNonNull = (col) => COLS[col].length - 1;
  COLS.forEach((parts, c) => {
    // merge แนวตั้ง: หัวที่ไม่มีชั้นล่าง ยาวลงถึงแถวที่ 3
    const depth = lastNonNull(c);
    if (parts[depth] !== null && depth < 2) m.push({ s: { r: HEAD + depth, c }, e: { r: HEAD + 2, c } });
  });
  // merge แนวนอนของหัวกลุ่ม
  for (let level = 0; level < 2; level += 1) {
    for (let c = 0; c < COLS.length; c += 1) {
      if (!COLS[c][level] || COLS[c].length <= level + 1) continue;
      let e = c;
      while (e + 1 < COLS.length && COLS[e + 1][level] === null && COLS[e + 1].length > level + 1) e += 1;
      if (e > c) m.push({ s: { r: HEAD + level, c }, e: { r: HEAD + level, c: e } });
    }
  }
  return m;
}

async function main() {
  const { rows } = await hosxp.query(`
    SELECT v.vn, v.hn, p.cid, p.pname || p.fname || ' ' || p.lname AS name,
           v.vstdate::text AS vstdate, v.uc_money
    FROM vn_stat v JOIN patient p ON p.hn = v.hn JOIN pttype t ON t.pttype = v.pttype
    WHERE t.hipdata_code = 'UCS' AND v.uc_money > 0
    ORDER BY v.vstdate, v.vn`);
  const { rows: itemRows } = await hosxp.query(`
    SELECT vn, icode, SUM(sum_price) AS amt FROM opitemrece
    WHERE icode IN ('3000001','3100001','3200001','3300001','1600001') GROUP BY vn, icode`);
  const itemsOf = {};
  itemRows.forEach((r) => { (itemsOf[r.vn] ||= {})[r.icode] = Number(r.amt); });

  const aoa = [
    ['ออกรายงานวันที่ 01/10/2569 เวลา 09:00 (ข้อมูลตัวอย่าง)', null, null, null, null, null, 'รายงานการรักษาผู้ป่วยของหน่วยบริการ'],
    [null, null, 'กองทุนเขต ทดสอบ'],
    [],
    [null, null, 'จังหวัด ทดสอบ', null, null, null, null, null, null, null, null, null, null, null, null, 'โรงพยาบาล 99999 รพ.ทดสอบ'],
    [],
    COLS.map((p) => p[0] ?? null),
    COLS.map((p) => p[1] ?? null),
    COLS.map((p) => p[2] ?? null),
  ];

  let seq = 0;
  rows.forEach((v, k) => {
    if (k % 10 === 3) return; // ไม่ส่ง -> ไม่พบใน REP
    const amount = Number(v.uc_money);
    const it = itemsOf[v.vn] || {};
    const pay = (icode) => (it[icode] && k % 4 !== 1 ? Math.round(it[icode] * 0.8) : '-');
    const err = k % 10 === 7 ? 'C438' : '-';
    const r = Array(COLS.length).fill('-');
    const [y, m, d] = v.vstdate.split('-');
    Object.assign(r, {
      [C.REP]: REP_NO, [C.SEQ]: ++seq, [C.TRAN]: String(826000000 + seq), [C.HN]: v.hn, [C.AN]: '', [C.PID]: v.cid,
      [C.NAME]: v.name, [C.PTYPE]: 'OP', [C.DATE]: `${d}/${m}/${y} 10:00:00`, [C.DCH]: '-',
      [C.ERR]: err, [C.MAININSCL]: 'UCS',
      [C.CLAIM11]: amount, [C.CLAIM12]: 0, [C.CLAIM13]: k % 10 === 5 ? amount + 120 : amount,
      [C.OPHC]: err === '-' ? pay('3000001') : '-', [C.OPAE]: err === '-' ? pay('3100001') : '-',
      [C.OPINST]: err === '-' ? pay('3200001') : '-', [C.PP]: err === '-' ? pay('3300001') : '-',
      [C.CAT_WL]: 0, [C.DRUG]: err === '-' ? 20 : '-', [C.FS]: err === '-' && k % 3 === 0 ? 25 : '-', [C.DENY_HC]: 'C',
      [C.COMP_ORG]: 0,
    });
    const fundCols = [C.OPHC, C.OPAE, C.OPINST, C.PP, C.DRUG, C.FS];
    r[C.COMP] = fundCols.reduce((a, c) => a + (typeof r[c] === 'number' ? r[c] : 0), 0);
    aoa.push(r);
  });
  // ผู้ป่วยใน (ต้องถูกข้ามในไฟล์ OPD)
  const ip = [...aoa[aoa.length - 1]];
  ip[C.SEQ] = ++seq; ip[C.TRAN] = String(826000000 + seq); ip[C.PTYPE] = 'IP';
  aoa.push(ip);
  // ส่วนท้ายรายงาน
  aoa.push([], ['หมายเหตุ: ข้อมูลตัวอย่าง'], ['* Error Code อ้างอิงคู่มือ e-Claim']);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Detail');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['สรุป (ตัวอย่าง)']]), 'Summary');
  XLSX.writeFile(wb, out);
  console.log(`✔ สร้าง ${out} (${seq - 1} รายการ OP + 1 รายการ IP)`);
  await hosxp.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
