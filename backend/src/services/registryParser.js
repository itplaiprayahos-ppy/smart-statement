import * as XLSX from 'xlsx';
import { parseDate } from '../utils/dates.js';
import { norm, parseMoney, text } from './excelParser.js';

/**
 * อ่านไฟล์ Excel ทะเบียนบริการของหน้างาน (หนึ่งแถว = หนึ่งบริการ)
 * หาแถวหัวตารางเองจากชื่อคอลัมน์ที่รู้จัก ไม่ต้องตั้งรูปแบบไฟล์
 * ต้องมี: วันที่, HN (หรือเลขบัตร), รายการ (ชื่อหรือ icode)
 */
export const REGISTRY_COLUMNS = {
  service_date: { label: 'วันที่ให้บริการ', aliases: ['วันที่ให้บริการ', 'วันที่รับบริการ', 'วันรับบริการ', 'วันที่บริการ', 'วันที่บันทึก', 'วันที่', 'date', 'vstdate'] },
  hn:           { label: 'HN', aliases: ['hn'] },
  cid:          { label: 'เลขบัตรประชาชน', aliases: ['เลขบัตรประชาชน', 'เลขประจำตัวประชาชน', 'cid', 'pid', 'เลขบัตร'] },
  patient_name: { label: 'ชื่อ-สกุล', aliases: ['ชื่อ-สกุล', 'ชื่อ - สกุล', 'ชื่อสกุล', 'ชื่อ-นามสกุล', 'ชื่อผู้ป่วย', 'ชื่อ'] },
  icode:        { label: 'icode', aliases: ['icode', 'รหัสรายการ', 'รหัสค่าบริการ'] },
  item_text:    { label: 'รายการค่าบริการ', aliases: ['รายการค่าบริการ', 'รายการบริการ', 'ชื่อรายการ', 'รายการ', 'บริการ', 'ค่าบริการ'] },
  qty:          { label: 'จำนวน', aliases: ['จำนวน', 'qty'] },
  price:        { label: 'ราคา', aliases: ['ราคา', 'จำนวนเงิน', 'ราคารวม', 'ค่าบริการ(บาท)', 'บาท'] },
};
const KEYS = Object.keys(REGISTRY_COLUMNS);
const MAX_ERRORS = 300;

export const itemKey = (s) => norm(s).replace(/[.,;:'"()[\]{}\-_/]/g, '');
export const hnKey = (hn) => (hn ? String(hn).trim().replace(/^0+/, '') || '0' : null);

/** แถวหัวตาราง = แถวใน 20 แถวแรกที่ตรงกับชื่อคอลัมน์ที่รู้จักมากที่สุด */
function detectHeader(rows) {
  let best = { idx: -1, cols: {}, score: 0 };
  rows.slice(0, 20).forEach((row, idx) => {
    const cols = {};
    (row || []).forEach((cell, c) => {
      const k = norm(cell);
      if (!k) return;
      // ชื่อที่ตรงตัวมาก่อน แล้วค่อยหาแบบขึ้นต้น (เช่น "วันที่ให้บริการ (วว/ดด/ปปปป)")
      for (const exact of [true, false]) {
        const field = KEYS.find((f) => cols[f] === undefined
          && REGISTRY_COLUMNS[f].aliases.some((a) => (exact ? k === norm(a) : k.startsWith(norm(a)))));
        if (field) { cols[field] = c; break; }
      }
    });
    const score = Object.keys(cols).length;
    if (score > best.score) best = { idx, cols, score };
  });
  return best;
}

export function parseRegistry(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  // ใช้ชีตที่หัวตารางตรงกับคอลัมน์ทะเบียนมากที่สุด (เท่ากันเลือกชีตที่มีข้อมูลมากกว่า)
  // ไม่ใช้แค่จำนวนแถว เพราะชีตคำอธิบาย/รายการในแม่แบบอาจยาวกว่าชีตทะเบียน
  const candidates = wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
    const header = detectHeader(rows);
    const required = ['service_date', 'item_text', 'icode', 'hn', 'cid'].filter((f) => header.cols[f] !== undefined).length;
    return { name, rows, header, required, dataRows: rows.length - header.idx - 1 };
  }).sort((a, b) => b.required - a.required || b.header.score - a.header.score || b.dataRows - a.dataRows);
  if (!candidates.length) throw new Error('ไม่พบข้อมูลในไฟล์');
  const { name: sheetName, rows, header: { idx, cols } } = candidates[0];

  const missing = [];
  if (cols.service_date === undefined) missing.push('วันที่ให้บริการ');
  if (cols.hn === undefined && cols.cid === undefined) missing.push('HN');
  if (cols.item_text === undefined && cols.icode === undefined) missing.push('รายการค่าบริการ');

  const result = {
    sheetName,
    headerRowNumber: idx + 1,
    columns: Object.fromEntries(Object.entries(cols).map(([f, c]) => [f, text(rows[idx][c])])),
    missingRequired: missing,
    records: [],
    errors: [],
    errorCount: 0,
    totalRows: 0,
    dateFrom: null,
    dateTo: null,
  };
  if (missing.length) return result;

  const get = (row, f) => (cols[f] === undefined ? null : row[cols[f]]);
  for (let i = idx + 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    if (row.every((v) => text(v) === null)) continue;
    const rowNumber = i + 1;
    const hn = text(get(row, 'hn'));
    const cidRaw = text(get(row, 'cid'));
    const cid = cidRaw ? cidRaw.replace(/\D/g, '') : null;
    const itemText = text(get(row, 'item_text'));
    const icode = text(get(row, 'icode'));
    const rawDate = get(row, 'service_date');
    // ข้ามแถวรวมยอด / หมายเหตุ ที่ไม่มีคนไข้และไม่มีรายการ
    if (!hn && !cid && !itemText && !icode) continue;
    result.totalRows += 1;

    const problems = [];
    const date = parseDate(rawDate);
    if (!date) problems.push(`วันที่อ่านไม่ได้ (${text(rawDate) ?? 'ว่าง'})`);
    if (!hn && !(cid && cid.length === 13)) problems.push('ไม่มี HN หรือเลขบัตรประชาชน');
    if (!itemText && !icode) problems.push('ไม่มีรายการค่าบริการ');
    const qty = parseMoney(get(row, 'qty'));
    const price = parseMoney(get(row, 'price'));
    if (qty.error) problems.push(`จำนวนไม่ถูกต้อง (${text(get(row, 'qty'))})`);
    if (price.error) problems.push(`ราคาไม่ถูกต้อง (${text(get(row, 'price'))})`);
    if (problems.length) {
      result.errorCount += 1;
      if (result.errors.length < MAX_ERRORS) result.errors.push({ row: rowNumber, message: problems.join(', ') });
      continue;
    }
    result.records.push({
      row_number: rowNumber,
      service_date: date,
      hn,
      hn_key: hnKey(hn),
      cid: cid && cid.length === 13 ? cid : null,
      patient_name: text(get(row, 'patient_name')),
      item_text: itemText,
      item_key: itemText ? itemKey(itemText) : null,
      icode,
      qty: qty.value,
      price: price.value,
    });
    if (!result.dateFrom || date < result.dateFrom) result.dateFrom = date;
    if (!result.dateTo || date > result.dateTo) result.dateTo = date;
  }
  return result;
}
