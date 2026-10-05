import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { buildReport, countReport, REPORT_TYPES } from '../services/reportService.js';
import { readDateRange } from './his.routes.js';

const router = Router();

router.get('/types', (_req, res) => {
  res.json(Object.entries(REPORT_TYPES).map(([key, t]) => ({ key, title: t.title, description: t.description })));
});

function readOptions(q) {
  const range = readDateRange(q);
  if (!REPORT_TYPES[q.type]) throw new HttpError(400, 'ประเภทรายงานไม่ถูกต้อง');
  if (q.fund && !/^[A-Z0-9]{2,10}$/.test(q.fund)) throw new HttpError(400, 'รหัสกลุ่มสิทธิไม่ถูกต้อง');
  const fundCodes = String(q.fundCodes || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fundCodes.some((c) => !/^[A-Z0-9_]{2,20}$/.test(c))) throw new HttpError(400, 'รหัสกองทุนไม่ถูกต้อง');
  return {
    ...range, type: q.type, fund: q.fund || null, fundCodes, split: q.split !== '0',
    compare: 'claim', onlyClaimable: false,
  };
}

router.get('/funds/count', asyncHandler(async (req, res) => {
  res.json(await countReport(readOptions(req.query)));
}));

router.get('/funds', asyncHandler(async (req, res) => {
  const opts = readOptions(req.query);
  const { buffer, count } = await buildReport(opts, req.user);
  await audit(req, 'report_export', { type: opts.type, dateFrom: opts.dateFrom, dateTo: opts.dateTo, fundCodes: opts.fundCodes, rows: count });
  const name = `report_${opts.type}_${opts.dateFrom}_${opts.dateTo}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buffer);
}));

export default router;
