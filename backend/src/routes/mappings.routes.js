import { Router } from 'express';
import { db } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { FIELD_DEFS, validateMapping } from '../services/excelParser.js';

const router = Router();

router.get('/fields', (_req, res) => res.json(FIELD_DEFS));

router.get('/', asyncHandler(async (req, res) => {
  const activeOnly = req.query.active === '1';
  const { rows } = await db.query(
    `SELECT * FROM column_mappings ${activeOnly ? 'WHERE is_active' : ''} ORDER BY name`,
  );
  res.json(rows);
}));

function readBody(body = {}) {
  const { name, claim_type = 'OPD', header_row = null, sheet_name = null, mapping, is_active = true } = body;
  if (!name?.trim()) throw new HttpError(400, 'กรุณาตั้งชื่อรูปแบบไฟล์');
  if (!['OPD', 'IPD'].includes(claim_type)) throw new HttpError(400, 'ประเภทต้องเป็น OPD หรือ IPD');
  const err = validateMapping(mapping);
  if (err) throw new HttpError(400, err);
  const hr = header_row === '' || header_row === null ? null : Number(header_row);
  if (hr !== null && (!Number.isInteger(hr) || hr < 1)) throw new HttpError(400, 'แถวหัวตารางต้องเป็นจำนวนเต็มตั้งแต่ 1');
  return [name.trim(), claim_type, hr, sheet_name?.trim() || null, JSON.stringify(mapping), !!is_active];
}

router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO column_mappings (name, claim_type, header_row, sheet_name, mapping, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      readBody(req.body),
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'มีรูปแบบไฟล์ชื่อนี้แล้ว');
    throw err;
  }
}));

router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE column_mappings SET name = $2, claim_type = $3, header_row = $4, sheet_name = $5,
       mapping = $6, is_active = $7, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [Number(req.params.id), ...readBody(req.body)],
  );
  if (!rows[0]) throw new HttpError(404, 'ไม่พบรูปแบบไฟล์');
  res.json(rows[0]);
}));

router.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM column_mappings WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'ไม่พบรูปแบบไฟล์');
  res.json({ ok: true });
}));

export default router;
