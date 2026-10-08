import { Router } from 'express';
import { db, withTransaction } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { listPttypes, searchItems } from '../services/hosxpService.js';
import { env } from '../config/env.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT f.*, COUNT(fi.icode)::int AS item_count
     FROM funds f LEFT JOIN fund_items fi ON fi.fund_code = f.code
     GROUP BY f.code ORDER BY f.sort_order, f.code`,
  );
  res.json(rows);
}));

/** ค้นหารายการค่าบริการ/ยาจาก HOSxP (ต้องอยู่ก่อน /:code) */
router.get('/items/search', requireRole('admin'), asyncHandler(async (req, res) => {
  const source = req.query.source === 'drug' ? 'drug' : 'nondrug';
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw new HttpError(400, 'พิมพ์คำค้นหาอย่างน้อย 2 ตัวอักษร');
  try {
    res.json(await searchItems(source, q));
  } catch (err) {
    throw new HttpError(502, `ค้นหาใน HOSxP ไม่สำเร็จ: ${err.message}`);
  }
}));

/** สิทธิการรักษาที่ใช้งานอยู่จาก HOSxP (ต้องอยู่ก่อน /:code) */
router.get('/pttypes', requireRole('admin'), asyncHandler(async (_req, res) => {
  try {
    res.json({ pttypes: await listPttypes(), excludedHipdata: env.excludedHipdata });
  } catch (err) {
    throw new HttpError(502, `อ่านสิทธิการรักษาจาก HOSxP ไม่สำเร็จ: ${err.message}`);
  }
}));

router.get('/:code', asyncHandler(async (req, res) => {
  const { rows: [fund] } = await db.query('SELECT * FROM funds WHERE code = $1', [req.params.code]);
  if (!fund) throw new HttpError(404, 'ไม่พบกองทุน');
  const { rows: items } = await db.query(
    'SELECT icode, item_name, source, required, created_at FROM fund_items WHERE fund_code = $1 ORDER BY source, item_name',
    [fund.code],
  );
  res.json({ ...fund, items });
}));

/**
 * เงื่อนไขรหัส ICD-10 รับได้ทั้งรหัสเดี่ยวและช่วง (มีจุดหรือไม่มีก็ได้)
 *  "H25.1, z51.5, C00 - C96" -> ["H251", "Z515", "C00-C96"]
 */
const ICD_RE = /^[A-Z][0-9][0-9A-Z]{0,5}$/;
export function readIcd10(v) {
  const text = Array.isArray(v) ? v.join(',') : String(v || '');
  const list = text.toUpperCase().replace(/\./g, '').replace(/\s*[-–]\s*/g, '-')
    .split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
  const bad = list.filter((c) => {
    const parts = c.split('-');
    if (parts.length === 1) return !ICD_RE.test(c);
    return parts.length !== 2 || !ICD_RE.test(parts[0]) || !ICD_RE.test(parts[1]) || parts[0] > parts[1];
  });
  if (bad.length) throw new HttpError(400, `รหัส ICD-10 ไม่ถูกต้อง: ${bad.join(', ')} (ช่วงต้องเขียนจากน้อยไปมาก เช่น C00-C96)`);
  return [...new Set(list)];
}

function readFund(body = {}) {
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) throw new HttpError(400, 'รหัสกองทุนต้องเป็น A-Z, 0-9, _ ความยาว 2–20 ตัว');
  if (!name) throw new HttpError(400, 'กรุณาใส่ชื่อกองทุน');
  const cols = (Array.isArray(body.stm_columns) ? body.stm_columns : [])
    .map((c) => String(c).trim()).filter(Boolean);
  const items = (Array.isArray(body.items) ? body.items : []).map((it) => ({
    icode: String(it.icode || '').trim(),
    item_name: it.item_name ? String(it.item_name).slice(0, 300) : null,
    source: it.source === 'drug' ? 'drug' : 'nondrug',
    required: it.required === true,
  })).filter((it) => it.icode);
  const pttypes = [...new Set((Array.isArray(body.pttypes) ? body.pttypes : [])
    .map((p) => String(p).trim()).filter(Boolean))];
  const hipdataCodes = [...new Set((Array.isArray(body.hipdata_codes) ? body.hipdata_codes : ['UCS'])
    .map((p) => String(p).trim().toUpperCase()).filter(Boolean))];
  if (hipdataCodes.some((c) => !/^[A-Z0-9_]{1,10}$/.test(c))) throw new HttpError(400, 'รหัสกลุ่มสิทธิไม่ถูกต้อง');
  const pct = (v, d) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, 'เป้าหมายต้องเป็นตัวเลข 0–100');
    return n;
  };
  const targets = {
    send: pct(body.target_send, 95), success: pct(body.target_success, 90), complete: pct(body.target_complete, 95),
  };
  if (body.match_mode === 'icd' && !body.track_only && !readIcd10(body.icd10_codes).length) {
    throw new HttpError(400, 'วิธีคัดแบบ ICD-10 ต้องใส่รหัสโรคอย่างน้อย 1 รายการ');
  }
  return {
    code, name, cols, items, pttypes, hipdataCodes, targets, trackOnly: body.track_only === true,
    matchMode: ['rights', 'icd'].includes(body.match_mode) ? body.match_mode : 'items',
    // แบบสิทธิการรักษาไม่ใช้รหัสโรค
    icd10Codes: body.match_mode === 'rights' ? [] : readIcd10(body.icd10_codes),
    icd10Scope: body.icd10_scope === 'pdx' ? 'pdx' : 'any',
    sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    is_active: body.is_active !== false,
  };
}

/** บันทึกกองทุนพร้อมรายการทั้งหมดในครั้งเดียว (สร้างใหม่ หรือแก้ไขเมื่อมี :code) */
async function saveFund(req, res, originalCode) {
  const f = readFund(req.body);
  const saved = await withTransaction(async (client) => {
    if (originalCode) {
      const { rowCount } = await client.query(
        `UPDATE funds SET code = $1, name = $2, stm_columns = $3, sort_order = $4, is_active = $5, pttypes = $7,
           target_send = $8, target_success = $9, target_complete = $10, hipdata_codes = $11, track_only = $12,
           match_mode = $13, icd10_codes = $14, icd10_scope = $15, updated_at = now()
         WHERE code = $6`,
        [f.code, f.name, JSON.stringify(f.cols), f.sort_order, f.is_active, originalCode, JSON.stringify(f.pttypes),
          f.targets.send, f.targets.success, f.targets.complete, JSON.stringify(f.hipdataCodes), f.trackOnly, f.matchMode,
          JSON.stringify(f.icd10Codes), f.icd10Scope],
      );
      if (!rowCount) throw new HttpError(404, 'ไม่พบกองทุน');
    } else {
      await client.query(
        `INSERT INTO funds (code, name, stm_columns, sort_order, is_active, pttypes, target_send, target_success,
           target_complete, hipdata_codes, track_only, match_mode, icd10_codes, icd10_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [f.code, f.name, JSON.stringify(f.cols), f.sort_order, f.is_active, JSON.stringify(f.pttypes),
          f.targets.send, f.targets.success, f.targets.complete, JSON.stringify(f.hipdataCodes), f.trackOnly, f.matchMode,
          JSON.stringify(f.icd10Codes), f.icd10Scope],
      );
    }
    // แทนที่รายการ แต่คงเวลาเพิ่มเดิมไว้ เพื่อให้รู้ว่ารายการไหนเพิ่มใหม่หลังดึง HOSxP
    const keep = f.items.map((it) => it.icode);
    await client.query('DELETE FROM fund_items WHERE fund_code = $1 AND NOT (icode = ANY($2::text[]))', [f.code, keep]);
    for (const it of f.items) {
      await client.query(
        `INSERT INTO fund_items (fund_code, icode, item_name, source, required) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (fund_code, icode) DO UPDATE SET item_name = EXCLUDED.item_name, source = EXCLUDED.source,
           required = EXCLUDED.required`,
        [f.code, it.icode, it.item_name, it.source, it.required],
      );
    }
    return f;
  }).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, 'มีรหัสกองทุนนี้แล้ว');
    throw err;
  });
  await audit(req, originalCode ? 'fund_update' : 'fund_create', {
    code: saved.code, items: saved.items.length, pttypes: saved.pttypes, hipdata_codes: saved.hipdataCodes,
  });
  res.status(originalCode ? 200 : 201).json({ code: saved.code });
}

router.post('/', requireRole('admin'), asyncHandler((req, res) => saveFund(req, res, null)));
router.put('/:code', requireRole('admin'), asyncHandler((req, res) => saveFund(req, res, req.params.code)));

router.delete('/:code', requireRole('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM funds WHERE code = $1', [req.params.code]);
  if (!rowCount) throw new HttpError(404, 'ไม่พบกองทุน');
  await audit(req, 'fund_delete', { code: req.params.code });
  res.json({ ok: true });
}));

export default router;
