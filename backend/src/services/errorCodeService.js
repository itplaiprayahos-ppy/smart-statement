import { db } from '../config/db.js';

/*
 * ตารางรหัสข้อผิดพลาด e-Claim (error_codes) เป็นตาราง lookup อย่างเดียว
 * ข้อมูลมาจาก db/seed/eclaim_error_codes.tsv ผ่าน migration
 * ปรับปรุง: แก้ไฟล์ .tsv แล้วรัน npm run build:error-codes -- 0XX_error_codes_update.sql และ npm run migrate
 */

/**
 * รหัสข้อผิดพลาด e-Claim (ติด C)
 * ค่าใน REP อาจเป็น "C438", "438" หรือหลายรหัส เช่น "C438,C301" -> แยกเป็นเลขรหัส ["438", "301"]
 */
export function splitCodes(value) {
  const s = String(value ?? '').trim();
  if (!s || s === '-' || s === '0') return [];
  const out = s.split(/[\s,;|/]+/).map((t) => t.trim().toUpperCase()).filter(Boolean).map((t) => {
    if (/^C\d{1,5}$/.test(t)) return t.slice(1);        // C438 -> 438
    if (/^\d{1,5}$/.test(t) || /^[A-Z]{2}\d{1,3}$/.test(t)) return t; // 438, AP1, EA1
    return null;
  }).filter(Boolean);
  return [...new Set(out)];
}

// ---------- cache ในหน่วยความจำ (ตารางเล็ก อ่านบ่อย) ----------
let cache = null;
export async function errorCodeMap() {
  if (!cache) {
    const { rows } = await db.query('SELECT code, description, guidance FROM error_codes');
    cache = new Map(rows.map((r) => [r.code, r]));
  }
  return cache;
}

/** เติม error_detail / error_guidance ให้แต่ละแถวที่มี error_code */
export async function annotateErrors(rows) {
  if (!rows.some((r) => r.error_code)) return rows;
  const map = await errorCodeMap();
  return rows.map((r) => {
    const codes = splitCodes(r.error_code);
    if (!codes.length) return { ...r, error_detail: null, error_guidance: null };
    const found = codes.map((c) => [c, map.get(c)]);
    return {
      ...r,
      error_detail: found.map(([c, e]) => `${c}: ${e ? e.description : 'ไม่พบรหัสในตารางรหัสข้อผิดพลาด'}`).join('\n'),
      error_guidance: found.filter(([, e]) => e?.guidance)
        .map(([c, e]) => `${c}: ${e.guidance.replace(/\s*\n\s*/g, ' ')}`).join('\n') || null,
    };
  });
}

/**
 * แปลงข้อความตาราง (คัดลอกจากหน้าเว็บ หรือ Excel) เป็นรายการรหัส
 * แต่ละแถว: รหัส <TAB> รายละเอียด <TAB> วิธีปฏิบัติ/แนวทางแก้ไข
 * เซลล์ที่มีหลายบรรทัด: บรรทัดต่อมาไม่ขึ้นต้นด้วยรหัส ให้ต่อท้ายคอลัมน์ที่กำลังอ่านอยู่
 * และถ้ามี TAB ในบรรทัดต่อ แปลว่าข้ามไปคอลัมน์ถัดไป
 * รหัสรองรับทั้งตัวเลข (101, C438) และตัวอักษร 2 ตัว + ตัวเลข (AP1, EA1)
 */
const CODE_RE = /^(?:C?(\d{1,5})|([A-Za-z]{2}\d{1,3}))$/;

export function parseErrorCodeText(text) {
  const out = [];
  let cur = null;
  let col = 0; // 1 = รายละเอียด, 2 = แนวทางแก้ไข
  const append = (cell) => {
    const t = cell.replace(/\u00a0/g, ' ').trim();
    if (!t) return;
    const key = col === 1 ? 'description' : 'guidance';
    cur[key] = cur[key] ? `${cur[key]}\n${t}` : t;
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const cells = raw.split('\t');
    const m = cells[0].replace(/\u00a0/g, ' ').trim().match(CODE_RE);
    if (m && cells.length >= 2) {
      cur = { code: (m[1] || m[2]).toUpperCase(), description: '', guidance: '' };
      out.push(cur);
      col = 1;
      cells.slice(1).forEach((c, i) => { if (i > 0) col = Math.min(col + 1, 2); append(c); });
      continue;
    }
    if (!cur || !raw.trim()) continue;
    cells.forEach((c, i) => { if (i > 0) col = Math.min(col + 1, 2); append(c); });
  }
  return out
    .filter((r) => r.description && r.description !== 'รายละเอียด')
    .map((r) => ({ ...r, guidance: r.guidance || null }));
}
