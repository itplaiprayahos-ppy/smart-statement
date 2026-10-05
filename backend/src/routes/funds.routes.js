import { Router } from 'express';
import { db, withTransaction } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { listPttypes, searchItems } from '../services/hosxpService.js';

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
    res.json(await listPttypes());
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
  return {
    code, name, cols, items, pttypes,
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
           updated_at = now()
         WHERE code = $6`,
        [f.code, f.name, JSON.stringify(f.cols), f.sort_order, f.is_active, originalCode, JSON.stringify(f.pttypes)],
      );
      if (!rowCount) throw new HttpError(404, 'ไม่พบกองทุน');
    } else {
      await client.query(
        'INSERT INTO funds (code, name, stm_columns, sort_order, is_active, pttypes) VALUES ($1, $2, $3, $4, $5, $6)',
        [f.code, f.name, JSON.stringify(f.cols), f.sort_order, f.is_active, JSON.stringify(f.pttypes)],
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
    code: saved.code, items: saved.items.length, pttypes: saved.pttypes,
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
