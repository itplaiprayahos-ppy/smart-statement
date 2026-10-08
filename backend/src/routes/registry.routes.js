import { Router } from 'express';
import multer from 'multer';
import { db } from '../config/db.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { parseRegistry } from '../services/registryParser.js';
import {
  compareRegistry, COMPARE_STATUSES, exportCompare, importRegistry, previewRegistry, registryTemplate, saveAlias, unknownItems,
} from '../services/registryService.js';
import { readDateRange } from './his.routes.js';
import { readSort } from '../utils/sort.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const fileNameOf = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

async function readFund(code) {
  const { rows: [f] } = await db.query('SELECT code, name FROM funds WHERE code = $1', [String(code || '')]);
  if (!f) throw new HttpError(400, 'ไม่พบกองทุน');
  return f;
}

function parseFile(req) {
  if (!req.file) throw new HttpError(400, 'กรุณาเลือกไฟล์');
  if (!/\.(xlsx|xls)$/i.test(fileNameOf(req.file))) throw new HttpError(400, 'รองรับเฉพาะไฟล์ .xlsx หรือ .xls');
  try {
    return parseRegistry(req.file.buffer);
  } catch (err) {
    throw new HttpError(400, `อ่านไฟล์ไม่ได้: ${err.message}`);
  }
}

router.post('/preview', upload.single('file'), asyncHandler(async (req, res) => {
  const fund = await readFund(req.body.fundCode);
  const parsed = parseFile(req);
  const { records, unknownItems: unknown } = parsed.missingRequired.length ? { records: [], unknownItems: [] }
    : await previewRegistry(fund.code, parsed);
  res.json({
    fileName: fileNameOf(req.file),
    fund,
    sheetName: parsed.sheetName,
    headerRowNumber: parsed.headerRowNumber,
    columns: parsed.columns,
    missingRequired: parsed.missingRequired,
    totalRows: parsed.totalRows,
    validRows: records.length,
    errorCount: parsed.errorCount,
    errors: parsed.errors.slice(0, 50),
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    unknownItems: unknown,
    sample: records.slice(0, 10),
  });
}));

router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  const fund = await readFund(req.body.fundCode);
  const parsed = parseFile(req);
  if (parsed.missingRequired.length) throw new HttpError(400, `ไม่พบคอลัมน์: ${parsed.missingRequired.join(', ')}`);
  if (!parsed.records.length) throw new HttpError(400, 'ไม่พบรายการที่นำเข้าได้ในไฟล์');
  const result = await importRegistry({ fundCode: fund.code, fileName: fileNameOf(req.file), parsed, userId: req.user.id });
  await audit(req, 'registry_import', { fund: fund.code, ...result });
  res.status(201).json(result);
}));

router.get('/batches', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.id, b.fund_code, b.file_name, b.date_from, b.date_to, b.total_rows, b.valid_rows, b.error_rows, b.created_at,
            u.full_name AS uploaded_by_name, b.uploaded_by,
            (SELECT COUNT(*)::int FROM registry_rows r WHERE r.batch_id = b.id) AS current_rows
     FROM registry_batches b LEFT JOIN users u ON u.id = b.uploaded_by
     WHERE ($1::text IS NULL OR b.fund_code = $1) ORDER BY b.created_at DESC LIMIT 50`,
    [req.query.fundCode || null],
  );
  res.json(rows);
}));

router.get('/batches/:id/errors', asyncHandler(async (req, res) => {
  const { rows: [b] } = await db.query('SELECT errors FROM registry_batches WHERE id = $1', [Number(req.params.id)]);
  if (!b) throw new HttpError(404, 'ไม่พบการอัปโหลด');
  res.json(b.errors);
}));

router.delete('/batches/:id', asyncHandler(async (req, res) => {
  const { rows: [b] } = await db.query('SELECT id, uploaded_by FROM registry_batches WHERE id = $1', [Number(req.params.id)]);
  if (!b) throw new HttpError(404, 'ไม่พบการอัปโหลด');
  if (req.user.role !== 'admin' && b.uploaded_by !== req.user.id) throw new HttpError(403, 'ลบได้เฉพาะไฟล์ที่ตนเองอัปโหลด');
  await db.query('DELETE FROM registry_batches WHERE id = $1', [b.id]);
  await audit(req, 'registry_delete', { batchId: b.id });
  res.json({ ok: true });
}));

router.get('/unknown-items', asyncHandler(async (req, res) => {
  const fund = await readFund(req.query.fundCode);
  res.json(await unknownItems(fund.code));
}));

router.post('/aliases', asyncHandler(async (req, res) => {
  const { text, icode, itemName } = req.body || {};
  if (!text || !icode) throw new HttpError(400, 'กรุณาเลือกรายการ');
  res.json(await saveAlias({ text: String(text), icode: String(icode), itemName, userId: req.user.id }));
}));

router.get('/template', asyncHandler(async (req, res) => {
  const fund = await readFund(req.query.fundCode);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="registry_template_${fund.code}.xlsx"`);
  res.send(await registryTemplate(fund.code));
}));

function readCompare(q) {
  const range = readDateRange(q);
  if (q.status && !COMPARE_STATUSES[q.status]) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  return { ...range, fundCode: q.fundCode, status: q.status || null, search: q.search, page: q.page, pageSize: q.pageSize, ...readSort(q) };
}

router.get('/compare', asyncHandler(async (req, res) => {
  const opts = readCompare(req.query);
  await readFund(opts.fundCode);
  const data = await compareRegistry(opts);
  await audit(req, 'registry_compare', { fund: opts.fundCode, dateFrom: opts.dateFrom, dateTo: opts.dateTo });
  res.json(data);
}));

router.get('/compare/export', asyncHandler(async (req, res) => {
  const opts = readCompare(req.query);
  const fund = await readFund(opts.fundCode);
  const { buffer, count } = await exportCompare(opts);
  await audit(req, 'registry_export', { fund: fund.code, rows: count });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="compare_${fund.code}_${opts.dateFrom}_${opts.dateTo}.xlsx"`);
  res.send(buffer);
}));

export default router;
