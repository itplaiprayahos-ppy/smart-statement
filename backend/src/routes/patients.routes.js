import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { exportPatients, listPatients, PROBLEMS } from '../services/patientService.js';
import { readDateRange } from './his.routes.js';
import { readSort } from '../utils/sort.js';

/* รายชื่อคนไข้: รวมกระทบยอด OPD, แยกกองทุน OPD และเทียบ 3 แหล่งไว้หน้าเดียว */
const router = Router();

/** รหัสห้อง/กองทุน คั่นด้วยจุลภาค (เลือกได้หลายรายการ) */
const codes = (v) => {
  const list = [...new Set(String(v || '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (list.length > 100 || list.some((x) => !/^[\w.-]{1,30}$/.test(x))) throw new HttpError(400, 'รหัสห้อง/กองทุนไม่ถูกต้อง');
  return list.length ? list : null;
};

function readOpts(q) {
  const step = q.step ? Number(q.step) : null;
  if (step !== null && ![1, 2, 3, 4].includes(step)) throw new HttpError(400, 'ขั้นตอนไม่ถูกต้อง');
  if (q.problem && !PROBLEMS[q.problem]) throw new HttpError(400, 'ประเภทปัญหาไม่ถูกต้อง');
  return {
    ...readDateRange(q), point: codes(q.point), fund: codes(q.fund), step, problem: q.problem || null,
    search: typeof q.search === 'string' ? q.search.slice(0, 100) : null, page: q.page, pageSize: q.pageSize, fresh: q.fresh === '1', ...readSort(q),
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const opts = readOpts(req.query);
  const data = await listPatients(opts);
  await audit(req, 'patients_list', { dateFrom: opts.dateFrom, dateTo: opts.dateTo });
  res.json(data);
}));

router.get('/export', asyncHandler(async (req, res) => {
  const opts = readOpts(req.query);
  const { buffer, count } = await exportPatients(opts);
  await audit(req, 'patients_export', { rows: count, dateFrom: opts.dateFrom, dateTo: opts.dateTo });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="patients_${opts.dateFrom}_${opts.dateTo}.xlsx"`);
  res.send(buffer);
}));

export default router;
