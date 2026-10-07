import { Router } from 'express';
import { db } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import {
  deleteErrorCode, importErrorCodes, parseErrorCodeText, saveErrorCode,
} from '../services/errorCodeService.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await db.query(
    `SELECT code, description, guidance, updated_at FROM error_codes
     WHERE ($1 = '' OR code LIKE $1 || '%' OR description ILIKE '%' || $1 || '%')
     ORDER BY (code ~ '^[0-9]+$') DESC, lpad(code, 6, '0')`,
    [q],
  );
  res.json(rows);
}));

/** ตรวจข้อความที่วาง (ยังไม่บันทึก) */
router.post('/parse', requireRole('admin'), (req, res) => {
  const items = parseErrorCodeText(req.body?.text);
  res.json({ count: items.length, sample: items.slice(0, 10) });
});

router.post('/import', requireRole('admin'), asyncHandler(async (req, res) => {
  const items = parseErrorCodeText(req.body?.text);
  if (!items.length) throw new HttpError(400, 'ไม่พบรหัสข้อผิดพลาดในข้อความที่วาง (แต่ละแถวต้องขึ้นต้นด้วยรหัส และคั่นคอลัมน์ด้วยแท็บ)');
  const n = await importErrorCodes(items);
  await audit(req, 'error_codes_import', { count: n });
  res.json({ imported: n });
}));

router.put('/:code', requireRole('admin'), asyncHandler(async (req, res) => {
  const raw = String(req.params.code).trim().toUpperCase();
  const code = /^C\d{1,5}$/.test(raw) ? raw.slice(1) : raw;
  if (!/^(\d{1,5}|[A-Z]{2}\d{1,3})$/.test(code)) throw new HttpError(400, 'รหัสต้องเป็นตัวเลข หรือตัวอักษร 2 ตัวตามด้วยตัวเลข เช่น 438, AP1');
  const description = String(req.body?.description || '').trim();
  if (!description) throw new HttpError(400, 'กรุณาใส่รายละเอียด');
  await saveErrorCode(code, description, String(req.body?.guidance || '').trim());
  res.json({ ok: true });
}));

router.delete('/:code', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!(await deleteErrorCode(req.params.code))) throw new HttpError(404, 'ไม่พบรหัส');
  res.json({ ok: true });
}));

export default router;
