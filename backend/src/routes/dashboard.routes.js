import { Router } from 'express';
import { db } from '../config/db.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  const [lines, his, lastImport, lastPull] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS count, MIN(service_date) AS date_min, MAX(service_date) AS date_max
              FROM nhso_lines WHERE claim_type = 'OPD'`),
    db.query(`SELECT COUNT(*)::int AS count, MIN(vstdate) AS date_min, MAX(vstdate) AS date_max
              FROM his_opd_visits`),
    db.query(`SELECT b.file_name, b.created_at, u.username FROM import_batches b
              LEFT JOIN users u ON u.id = b.imported_by ORDER BY b.created_at DESC LIMIT 1`),
    db.query(`SELECT l.date_from, l.date_to, l.row_count, l.created_at, u.username FROM his_pull_logs l
              LEFT JOIN users u ON u.id = l.pulled_by ORDER BY l.created_at DESC LIMIT 1`),
  ]);
  res.json({
    nhso: lines.rows[0],
    his: his.rows[0],
    lastImport: lastImport.rows[0] || null,
    lastPull: lastPull.rows[0] || null,
  });
}));

export default router;
