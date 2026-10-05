// อ่านไฟล์ Excel จาก สปสช. แล้วแปลงเป็นรายการตามรูปแบบ mapping ที่กำหนด
import * as XLSX from 'xlsx';
import { parseDate } from '../utils/dates.js';

/** ฟิลด์ในระบบที่จับคู่ได้ */
export const FIELD_DEFS = {
  rep_no:       { label: 'เลข REP',           type: 'text' },
  tran_id:      { label: 'TRAN_ID',           type: 'text' },
  hn:           { label: 'HN',                type: 'text' },
  an:           { label: 'AN',                type: 'text' },
  pid:          { label: 'เลขบัตรประชาชน',     type: 'pid',   required: true },
  patient_name: { label: 'ชื่อ-สกุล',          type: 'text' },
  service_date: { label: 'วันที่รับบริการ',     type: 'date',  required: true },
  fund:         { label: 'สิทธิ/กองทุน',       type: 'text' },
  claim_amount: { label: 'ยอดเรียกเก็บ',       type: 'money' },
  compensated:  { label: 'ยอดชดเชย',          type: 'money' },
  error_code:   { label: 'รหัสข้อผิดพลาด',     type: 'text' },
};

/**
 * mapping เริ่มต้น: ชื่อหัวคอลัมน์ในไฟล์ของ สปสช. เปลี่ยนได้ตามรอบปรับปรุง
 * ให้ admin ตรวจกับไฟล์จริงแล้วแก้ในหน้า "รูปแบบไฟล์" ได้โดยไม่ต้องแก้โค้ด
 */
export const DEFAULT_OPD_MAPPING = {
  rep_no:       ['REP', 'REP No.', 'REP NO', 'เลข REP'],
  tran_id:      ['TRAN_ID', 'TRAN ID', 'TRANID'],
  hn:           ['HN'],
  an:           ['AN'],
  pid:          ['PID', 'CID', 'เลขประจำตัวประชาชน', 'เลขบัตรประชาชน'],
  patient_name: ['ชื่อ - สกุล', 'ชื่อ– สกุล', 'ชื่อ-สกุล', 'ชื่อ', 'NAME'],
  service_date: ['วันเข้ารักษา', 'วันที่รับบริการ', 'วันรับบริการ', 'DATEADM', 'วันที่'],
  fund:         ['สิทธิ', 'กองทุน', 'MAININSCL', 'สิทธิหลัก'],
  claim_amount: ['เรียกเก็บ', 'ยอดเรียกเก็บ', 'ค่ารักษาที่เรียกเก็บ', 'CHARGE'],
  compensated:  ['ยอดชดเชยทั้งสิ้น', 'ชดเชยสุทธิ', 'ยอดชดเชย', 'จ่ายชดเชย'],
  error_code:   ['ERROR CODE', 'Error Code', 'ERROR_CODE', 'รหัสข้อผิดพลาด', 'Deny'],
};

const MAX_ERRORS = 500;

/**
 * เลขเอกสาร Statement เช่น "เลขที่เอกสาร 11344 OPUCS256908 01" หรือชื่อไฟล์ "STM_11344_OPUCS256908_01.xls"
 * -> "OPUCS256908-01" ใช้แยกรอบ STM (รายการเดียวกันในรอบต่างกันจะเก็บแยกกัน)
 */
export function normalizeStmDoc(text) {
  const m = String(text ?? '').match(/([A-Z]{2,}[0-9]{6,})(?:[_\s]+([0-9]{1,3}))?/);
  return m ? m[1] + (m[2] ? `-${m[2]}` : '') : null;
}

/** "OPUCS256908-01" -> '2026-08-01' (เดือนของรอบ Statement) */
export function stmPeriodOf(doc) {
  const m = String(doc ?? '').match(/(25\d{2})(0[1-9]|1[0-2])/);
  return m ? `${Number(m[1]) - 543}-${m[2]}-01` : null;
}

/** หาเลขเอกสารจากหัวรายงานเหนือตาราง ถ้าไม่พบใช้ชื่อไฟล์ */
function findStmDoc(rows, headerIdx, fileName) {
  for (const row of rows.slice(0, Math.max(0, headerIdx))) {
    const line = (row || []).filter((v) => v !== null && v !== undefined).join(' ');
    if (/เลขที่เอกสาร/.test(line)) {
      const doc = normalizeStmDoc(line);
      if (doc) return doc;
    }
  }
  return normalizeStmDoc(fileName);
}

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** ตรวจ mapping ที่ admin บันทึก; คืนข้อความผิดพลาด หรือ null ถ้าถูกต้อง */
export function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return 'mapping ต้องเป็น JSON object';
  }
  for (const [field, aliases] of Object.entries(mapping)) {
    if (!FIELD_DEFS[field]) return `ไม่รู้จักฟิลด์ "${field}"`;
    const list = Array.isArray(aliases) ? aliases : [aliases];
    if (!list.length || list.some((a) => typeof a !== 'string' || !a.trim())) {
      return `ฟิลด์ "${field}" ต้องเป็นชื่อหัวคอลัมน์ (ข้อความ) อย่างน้อย 1 ชื่อ`;
    }
  }
  const missing = Object.entries(FIELD_DEFS)
    .filter(([k, d]) => d.required && !mapping[k]).map(([k]) => k);
  if (missing.length) return `ต้องกำหนดฟิลด์บังคับ: ${missing.join(', ')}`;
  if (!mapping.tran_id && !mapping.rep_no) return 'ต้องกำหนด tran_id หรือ rep_no อย่างน้อยหนึ่งฟิลด์';
  return null;
}

function aliasesOf(mapping, field) {
  const v = mapping[field];
  return (Array.isArray(v) ? v : v ? [v] : []);
}

const splitPath = (label) => String(label ?? '').split('/').map(norm).filter(Boolean);

/** ส่วนท้ายของชื่อคอลัมน์ตรงกับชื่อที่กำหนดหรือไม่ เช่น "ยอดจ่าย / HC / HC" ลงท้ายด้วย "HC / HC" */
function endsWithPath(colParts, nameParts) {
  if (!nameParts.length || nameParts.length > colParts.length) return false;
  const start = colParts.length - nameParts.length;
  return nameParts.every((p, i) => colParts[start + i] === p);
}

/**
 * หาคอลัมน์ที่ตรงกับชื่อที่กำหนด
 * 1) ตรงกับชื่อเต็มของหัวตารางหลายชั้น เช่น "HC / DRUG"
 * 2) ถ้าไม่พบ เทียบกับส่วนท้ายของชื่อ เช่น "HC / DRUG" ตรงกับ "ยอดจ่าย / HC / DRUG"
 *    และ "INST" ตรงกับ "ยอดจ่าย / INST" (ใช้คอลัมน์แรกที่พบ)
 * จึงไม่ต้องรู้ชื่อหัวกลุ่มชั้นบนสุด ซึ่งอาจต่างกันในแต่ละไฟล์
 */
function findColumn(columns, name, used = new Set()) {
  const key = norm(name);
  if (!key) return null;
  const nameParts = splitPath(name);
  return columns.find((c) => !used.has(c.index) && c.key === key)
    || columns.find((c) => !used.has(c.index) && endsWithPath(c.parts, nameParts))
    || null;
}

/** คอลัมน์ย่อยที่เป็น "ยอดที่จ่ายจริง" และ "ยอดที่คำนวณได้" ในกลุ่มเดียวกัน (ห้ามรวมกัน เพราะจะนับซ้ำ) */
const PAID_LEAF = norm('ยอดชดเชยที่จ่ายจริง');
const CALC_LEAF = norm('ยอดชดเชยที่คำนวณได้');

/**
 * หาคอลัมน์ยอดเงินของกองทุนจากชื่อที่กำหนด คืนได้หลายคอลัมน์ (ระบบจะรวมยอดให้)
 *  - ชื่อตรงกับชื่อเต็มของคอลัมน์ -> ใช้คอลัมน์นั้นคอลัมน์เดียว
 *  - ชื่อตรงกับหัวกลุ่มชั้นใดชั้นหนึ่ง เช่น "HC" (แถวที่ 13 ของไฟล์ REP)
 *    -> ใช้ทุกคอลัมน์ย่อยใต้หัวกลุ่มนั้น เช่น HC + DRUG
 *    -> ถ้ากลุ่มมีคอลัมน์ "ยอดชดเชยที่จ่ายจริง" ใช้เฉพาะคอลัมน์นั้น (เช่น DMIS) ไม่รวม "ที่คำนวณได้"
 *  - ถ้าชื่อเดียวกันอยู่หลายกลุ่ม ใช้กลุ่มที่อยู่ชั้นบนกว่า แล้วกลุ่มที่อยู่ซ้ายสุด
 */
export function findFundColumns(columns, name) {
  const key = norm(name);
  if (!key) return [];
  const exact = columns.find((c) => c.key === key);
  if (exact) return [exact];

  const nameParts = splitPath(name);
  let best = null; // { depth, prefix }
  for (const c of columns) {
    for (let start = 0; start + nameParts.length <= c.parts.length; start += 1) {
      const hit = nameParts.every((p, i) => c.parts[start + i] === p);
      if (!hit) continue;
      const depth = start + nameParts.length;
      if (!best || depth < best.depth) best = { depth, prefix: c.parts.slice(0, depth) };
      break;
    }
  }
  if (!best) return [];

  const group = columns.filter((c) => c.parts.length >= best.depth
    && best.prefix.every((p, i) => c.parts[i] === p));
  const paid = group.filter((c) => c.parts[c.parts.length - 1] === PAID_LEAF);
  if (paid.length) return paid;
  return group.filter((c) => c.parts[c.parts.length - 1] !== CALC_LEAF);
}

function buildColumnIndex(columns, mapping) {
  const index = {};
  const used = new Set();
  for (const field of Object.keys(mapping)) {
    for (const alias of aliasesOf(mapping, field)) {
      const col = findColumn(columns, alias, used);
      if (col) {
        index[field] = col.index;
        used.add(col.index);
        break;
      }
    }
  }
  return index;
}

const singleRowColumns = (row = []) => row.map((v, index) => {
  const label = text(v) ?? '';
  return { index, label, key: norm(label), parts: splitPath(label) };
});

/** หาแถวหัวตาราง: แถวที่จับคู่ฟิลด์ได้มากที่สุดใน 30 แถวแรก */
function detectHeaderRow(rows, mapping) {
  let best = { row: -1, score: 0 };
  rows.slice(0, 30).forEach((row, i) => {
    const score = Object.keys(buildColumnIndex(singleRowColumns(row || []), mapping)).length;
    if (score > best.score) best = { row: i, score };
  });
  return best.score >= 2 ? best.row : -1;
}

/** เติมค่าเซลล์ที่ merge แนวนอนให้ทุกคอลัมน์ในช่วง (เช่น หัวกลุ่ม "HC" ที่คลุม 2 คอลัมน์) */
function fillHorizontalMerges(rows, ws, offset, colOffset) {
  for (const m of ws['!merges'] || []) {
    const r = m.s.r - offset;
    if (!rows[r]) continue;
    const value = rows[r][m.s.c - colOffset];
    for (let c = m.s.c + 1; c <= m.e.c; c += 1) {
      if (rows[r][c - colOffset] === null || rows[r][c - colOffset] === undefined) rows[r][c - colOffset] = value;
    }
  }
}

/**
 * รวมหัวตารางหลายชั้นเป็นชื่อเดียว เช่น แถวบน "HC" แถวล่าง "DRUG" -> "HC / DRUG"
 * หัวตารางต่อจากแถวแรกได้อีกไม่เกิน 2 แถว ตราบใดที่คอลัมน์เลขบัตรประชาชนยังว่าง
 */
function buildHeaderColumns(rows, headerIdx, pidCol) {
  let depth = 1;
  while (depth < 3 && pidCol !== undefined) {
    const next = rows[headerIdx + depth];
    if (!next || next.every((v) => text(v) === null) || text(next[pidCol]) !== null) break;
    depth += 1;
  }
  const width = Math.max(...rows.slice(headerIdx, headerIdx + depth).map((r) => (r || []).length));
  const columns = [];
  for (let c = 0; c < width; c += 1) {
    const parts = [];
    for (let d = 0; d < depth; d += 1) {
      const v = text(rows[headerIdx + d]?.[c]);
      if (v !== null) parts.push(v);
    }
    const label = parts.join(' / ');
    columns.push({ index: c, label, key: norm(label), parts: parts.map(norm) });
  }
  return { columns, depth };
}

function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseMoney(v) {
  if (v === null || v === undefined || v === '') return { value: null };
  if (typeof v === 'number') return { value: Math.round(v * 100) / 100 };
  const s = String(v).replace(/[,\s฿]/g, '');
  if (s === '' || s === '-') return { value: null };
  const n = Number(s);
  return Number.isFinite(n) ? { value: Math.round(n * 100) / 100 } : { error: true };
}

function parsePid(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'number' ? String(Math.round(v)) : String(v).replace(/[\s-]/g, '');
  // เลขที่ขึ้นต้นด้วย 0 อาจถูก Excel ตัด 0 หน้าทิ้งเหลือ 12 หลัก ให้เติมกลับ
  // ค่าผิดรูปแบบอื่น ๆ จะถูกจับในขั้นตรวจสอบ
  return /^\d{12}$/.test(s) ? `0${s}` : s;
}

/**
 * @param {Buffer} buffer ไฟล์ .xlsx / .xls
 * @param {{ mapping: object, header_row?: number|null, sheet_name?: string|null, claim_type: string }} profile
 * @param {{ code: string, stm_columns: string[] }[]} funds กองทุนที่ต้องอ่านยอดที่ได้รับแยก
 */
export function parseExcel(buffer, profile, funds = [], fileName = '') {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch {
    throw Object.assign(new Error('อ่านไฟล์ไม่ได้ กรุณาตรวจว่าเป็นไฟล์ Excel (.xlsx / .xls)'), { status: 400 });
  }

  // เทียบชื่อชีตแบบไม่สนใจช่องว่าง/ตัวพิมพ์ และแจ้งเตือนถ้าไม่พบ
  const wanted = norm(profile.sheet_name);
  const sheetName = wanted ? wb.SheetNames.find((n) => norm(n) === wanted) : wb.SheetNames[0];
  if (!sheetName) {
    throw Object.assign(new Error(
      `ไม่พบชีต "${profile.sheet_name}" ในไฟล์ (ชีตที่มี: ${wb.SheetNames.join(', ')})`,
    ), { status: 400 });
  }
  const ws = wb.Sheets[sheetName];
  // เก็บแถวว่างไว้ด้วย เพื่อให้เลขแถวตรงกับที่ผู้ใช้เห็นใน Excel
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 } };
  const offset = range.s.r; // ข้อมูลอาจไม่ได้เริ่มที่แถว 1
  fillHorizontalMerges(rows, ws, offset, range.s.c);

  const headerIdx = profile.header_row ? profile.header_row - 1 - offset : detectHeaderRow(rows, profile.mapping);
  if (headerIdx < 0 || !rows[headerIdx]) {
    throw Object.assign(new Error(
      'ไม่พบแถวหัวตารางที่ตรงกับรูปแบบไฟล์ที่เลือก กรุณาตรวจชื่อหัวคอลัมน์ในหน้า "รูปแบบไฟล์"',
    ), { status: 400 });
  }

  // หาคอลัมน์เลขบัตรจากแถวหัวตารางแถวแรกก่อน เพื่อใช้ตัดสินว่าแถวถัดไปยังเป็นหัวตารางหรือเป็นข้อมูลแล้ว
  const firstIndex = buildColumnIndex(singleRowColumns(rows[headerIdx]), profile.mapping);
  const { columns, depth } = buildHeaderColumns(rows, headerIdx, firstIndex.pid);
  const colIndex = buildColumnIndex(columns, profile.mapping);
  const label = (c) => columns[c]?.label;

  const missingRequired = Object.entries(FIELD_DEFS)
    .filter(([k, d]) => d.required && colIndex[k] === undefined).map(([k]) => FIELD_DEFS[k].label);
  if (colIndex.tran_id === undefined && colIndex.rep_no === undefined) missingRequired.push('TRAN_ID หรือ เลข REP');

  // คอลัมน์ยอดที่ได้รับของแต่ละกองทุน
  const fundCols = {};
  const fundColumns = {};
  for (const f of funds) {
    const matched = [];
    const missing = [];
    for (const name of f.stm_columns || []) {
      const cols = findFundColumns(columns, name).filter((c) => !matched.includes(c));
      if (cols.length) matched.push(...cols); else missing.push(name);
    }
    if (matched.length) fundCols[f.code] = matched.map((c) => c.index);
    fundColumns[f.code] = { matched: matched.map((c) => c.label), missing };
  }

  const stmDoc = findStmDoc(rows, headerIdx, fileName);
  const stmPeriod = stmPeriodOf(stmDoc);

  const result = {
    stmDoc,
    stmPeriod,
    sheetName,
    sheetNames: wb.SheetNames,
    headerRowNumber: headerIdx + 1 + offset,
    headerDepth: depth,
    headers: columns.map((c) => c.label).filter(Boolean),
    matchedColumns: Object.fromEntries(Object.entries(colIndex).map(([f, c]) => [f, label(c)])),
    fundColumns,
    missingRequired,
    records: [],
    errors: [],
    errorCount: 0,
    totalRows: 0,
    // แถวที่ไม่ได้อ่านเป็นข้อมูล (แถวรวมยอด / ส่วนท้ายรายงาน) แจ้งให้ผู้ใช้ตรวจได้ แต่ไม่นับเป็นข้อผิดพลาด
    skipped: { count: 0, rows: [], endedAtRow: null },
  };
  if (missingRequired.length) return result;

  const seen = new Map();
  const addError = (rowNumber, message) => {
    result.errorCount += 1;
    if (result.errors.length < MAX_ERRORS) result.errors.push({ row: rowNumber, message });
  };

  const isBlank = (row) => !row || row.every((v) => text(v) === null);
  const skip = (rowNumber) => {
    result.skipped.count += 1;
    if (result.skipped.rows.length < 200) result.skipped.rows.push(rowNumber);
  };
  let started = false;

  for (let i = headerIdx + depth; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const rowNumber = i + 1 + offset; // เลขแถวตามที่เห็นใน Excel

    // ตารางข้อมูลจบที่แถวว่างแถวแรกหลังเริ่มมีข้อมูล แถวต่อจากนั้นเป็นส่วนท้ายรายงาน ไม่อ่าน
    if (isBlank(row)) {
      if (started) {
        const rest = rows.slice(i).map((r, k) => (isBlank(r) ? null : i + k + 1 + offset)).filter(Boolean);
        if (rest.length) {
          result.skipped.endedAtRow = rowNumber - 1;
          rest.forEach(skip);
        }
        break;
      }
      continue;
    }

    const cell = (f) => (colIndex[f] === undefined ? null : row[colIndex[f]]);
    const pid = parsePid(cell('pid'));
    const rawDate = cell('service_date');
    const tranId = text(cell('tran_id'));
    const repNo = text(cell('rep_no'));

    // แถวที่ไม่มีลักษณะเป็นข้อมูลคนไข้ (เช่น แถวรวมยอด) ข้ามโดยไม่นับเป็นข้อผิดพลาด:
    // ไม่มีเลขบัตรรูปแบบตัวเลข 12-13 หลัก และไม่มีวันที่ที่อ่านได้คู่กับ TRAN_ID หรือ REP
    const pidLike = pid && /^\d{12,13}$/.test(pid);
    const dateLike = parseDate(rawDate) !== null && (tranId || repNo);
    if (!pidLike && !dateLike) {
      skip(rowNumber);
      continue;
    }
    started = true;
    result.totalRows += 1;

    const problems = [];
    if (!pid || !/^\d{13}$/.test(pid)) problems.push(`เลขบัตรประชาชนไม่ถูกต้อง (${cell('pid') ?? 'ว่าง'})`);
    const serviceDate = parseDate(rawDate);
    if (!serviceDate) problems.push(`วันที่รับบริการอ่านไม่ได้ (${rawDate ?? 'ว่าง'})`);
    const claim = parseMoney(cell('claim_amount'));
    const comp = parseMoney(cell('compensated'));
    if (claim.error) problems.push('ยอดเรียกเก็บไม่ใช่ตัวเลข');
    if (comp.error) problems.push('ยอดชดเชยไม่ใช่ตัวเลข');

    const fundAmounts = {};
    for (const [code, idxs] of Object.entries(fundCols)) {
      let sum = null;
      for (const c of idxs) {
        const m = parseMoney(row[c]);
        if (m.error) { problems.push(`ยอดกองทุน ${code} ไม่ใช่ตัวเลข`); break; }
        if (m.value !== null) sum = Math.round(((sum ?? 0) + m.value) * 100) / 100;
      }
      if (sum !== null) fundAmounts[code] = sum;
    }

    if (problems.length) {
      addError(rowNumber, problems.join(', '));
      continue;
    }

    const hn = text(cell('hn'));
    // รายการเดียวกันในรอบ STM ต่างกัน เก็บแยกกัน (ยอดปรับปรุงรอบหลังจะไม่ทับรอบแรก)
    const baseKey = tranId ? `T:${tranId}` : `R:${repNo ?? ''}|${pid}|${serviceDate}|${hn ?? ''}`;
    const lineKey = stmDoc ? `${baseKey}|${stmDoc}` : baseKey;
    if (seen.has(lineKey)) {
      addError(rowNumber, `รายการซ้ำกับแถว ${seen.get(lineKey)} ในไฟล์เดียวกัน (ใช้แถวหลังสุด)`);
      result.records = result.records.filter((r) => r.line_key !== lineKey);
    }
    seen.set(lineKey, rowNumber);

    const raw = {};
    columns.forEach((c) => {
      if (c.label && row[c.index] !== null && row[c.index] !== undefined && row[c.index] !== '') raw[c.label] = row[c.index];
    });

    result.records.push({
      row_number: rowNumber,
      claim_type: profile.claim_type,
      line_key: lineKey,
      rep_no: repNo,
      tran_id: tranId,
      hn,
      an: text(cell('an')),
      pid,
      patient_name: text(cell('patient_name')),
      service_date: serviceDate,
      fund: text(cell('fund')),
      claim_amount: claim.value,
      compensated: comp.value,
      error_code: text(cell('error_code')),
      fund_amounts: fundAmounts,
      stm_doc: stmDoc,
      stm_period: stmPeriod,
      raw,
    });
  }
  return result;
}
