import { Router } from 'express';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { exportOpd, reconcileOpd, STATUSES } from '../services/reconService.js';
import { exportFunds, FUND_STATUSES, reconcileFunds } from '../services/fundService.js';
import { readDateRange } from './his.routes.js';

const router = Router();

function readOptions(q) {
  const range = readDateRange(q);
  if (q.status && !STATUSES.includes(q.status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  if (q.fund && !/^[A-Z0-9]{2,10}$/.test(q.fund)) throw new HttpError(400, 'รหัสกองทุนไม่ถูกต้อง');
  return {
    ...range,
    fund: q.fund || null,
    compare: q.compare === 'compensated' ? 'compensated' : 'claim',
    onlyClaimable: q.onlyClaimable !== '0',
    status: q.status || null,
    search: q.search || null,
    page: q.page,
    pageSize: q.pageSize,
  };
}

router.get('/opd', asyncHandler(async (req, res) => {
  const opts = readOptions(req.query);
  const result = await reconcileOpd(opts);
  await audit(req, 'recon_view_opd', { dateFrom: opts.dateFrom, dateTo: opts.dateTo, status: opts.status });
  res.json(result);
}));

router.get('/opd/export', asyncHandler(async (req, res) => {
  const opts = readOptions(req.query);
  const { buffer, count } = await exportOpd(opts);
  await audit(req, 'recon_export_opd', { dateFrom: opts.dateFrom, dateTo: opts.dateTo, rows: count });
  const name = `recon_opd_${opts.dateFrom}_${opts.dateTo}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buffer);
}));

function readFundOptions(q) {
  const base = readOptions({ ...q, status: undefined });
  if (q.fundStatus && !FUND_STATUSES.includes(q.fundStatus)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  if (q.fundCode && !/^[A-Z0-9_]{2,20}$/.test(q.fundCode)) throw new HttpError(400, 'รหัสกองทุนไม่ถูกต้อง');
  return { ...base, fundCode: q.fundCode || null, fundStatus: q.fundStatus || null };
}

router.get('/funds', asyncHandler(async (req, res) => {
  const opts = readFundOptions(req.query);
  const result = await reconcileFunds(opts);
  await audit(req, 'recon_view_funds', { dateFrom: opts.dateFrom, dateTo: opts.dateTo, fundCode: opts.fundCode });
  res.json(result);
}));

router.get('/funds/export', asyncHandler(async (req, res) => {
  const opts = readFundOptions(req.query);
  const { buffer, count } = await exportFunds(opts);
  await audit(req, 'recon_export_funds', { dateFrom: opts.dateFrom, dateTo: opts.dateTo, rows: count });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="recon_funds_${opts.dateFrom}_${opts.dateTo}.xlsx"`);
  res.send(buffer);
}));

export default router;
