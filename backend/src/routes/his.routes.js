import { Router } from 'express';
import { db } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { daysBetween, isIsoDate } from '../utils/dates.js';
import { pullOpd, testHosxpConnection } from '../services/hosxpService.js';

const router = Router();
/** เลือกช่วงวันที่ได้สูงสุด 1 ปีงบประมาณ (366 วันรองรับปีอธิกสุรทิน) */
export const MAX_DAYS = 366;

export function readDateRange(src, maxDays = MAX_DAYS) {
  const { dateFrom, dateTo } = src;
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) throw new HttpError(400, 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  const days = daysBetween(dateFrom, dateTo);
  if (days < 0) throw new HttpError(400, 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
  if (days + 1 > maxDays) throw new HttpError(400, `เลือกช่วงวันที่ได้ไม่เกิน ${maxDays} วัน (1 ปีงบประมาณ)`);
  return { dateFrom, dateTo };
}

router.get('/status', requireRole('admin'), asyncHandler(async (_req, res) => {
  try {
    res.json({ ok: true, ...(await testHosxpConnection()) });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

router.post('/opd/pull', asyncHandler(async (req, res) => {
  const range = readDateRange(req.body || {});
  let result;
  try {
    result = await pullOpd({ ...range, userId: req.user.id });
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === '28P01') {
      throw new HttpError(502, `เชื่อมต่อฐานข้อมูล HOSxP ไม่ได้: ${err.message}`);
    }
    throw err;
  }
  await audit(req, 'his_pull_opd', { ...range, rows: result.rowCount, months: result.months });
  res.json(result);
}));

router.get('/opd/pull-logs', asyncHandler(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT l.*, u.username AS pulled_by_name FROM his_pull_logs l
     LEFT JOIN users u ON u.id = l.pulled_by
     WHERE l.claim_type = 'OPD' ORDER BY l.created_at DESC LIMIT 20`,
  );
  res.json(rows);
}));

export default router;
