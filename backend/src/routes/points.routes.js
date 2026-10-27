import { Router } from 'express';
import multer from 'multer';
import { db } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { readSort } from '../utils/sort.js';
import { parseRegistry } from '../services/registryParser.js';
import {
  comparePoint, departments, departmentsInfo, ensurePoint, exportPoint, importPointRegistry, listPoints, POINT_STATUSES, pointTemplate,
  suggestDepCodes,
} from '../services/pointService.js';
import { getOptionalFeeItems, saveOptionalFeeItems } from '../services/settingsService.js';
import { readDateRange } from './his.routes.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const fileNameOf = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

async function readPoint(code) {
  const { rows: [p] } = await db.query('SELECT * FROM service_points WHERE code = $1', [String(code || '')]);
  if (!p) throw new HttpError(400, 'ไม่พบห้อง/แผนก');
  return p;
}

/* ---------- ตั้งค่าห้อง/แผนก ---------- */
router.get('/', asyncHandler(async (req, res) => res.json(await listPoints(req.user.id))));

// ?info=1 ส่งที่มาของรายชื่อด้วย (hosxp / pulled / none) ?refresh=1 โหลดใหม่ ไม่ใช้แคช
router.get('/departments', asyncHandler(async (req, res) => {
  const info = await departmentsInfo({ refresh: req.query.refresh === '1' });
  res.json(req.query.info === '1'
    ? { list: info.list, source: info.source, error: info.error || null }
    : info.list);
}));

/* ---------- ค่าบริการอัตโนมัติ/ยา ที่ทะเบียนจะรวมหรือไม่รวมก็ได้ ---------- */
router.get('/optional-fees', asyncHandler(async (_req, res) => res.json(await getOptionalFeeItems())));
router.put('/optional-fees', requireRole('admin'), asyncHandler(async (req, res) => {
  const allDrugs = typeof req.body?.allDrugs === 'boolean' ? req.body.allDrugs : undefined;
  const result = await saveOptionalFeeItems(req.body?.items, req.user.id, allDrugs);
  await audit(req, 'optional_fees_update', { icodes: result.items.map((i) => i.icode), allDrugs: result.allDrugs });
  res.json(result);
}));

function readBody(b = {}) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) throw new HttpError(400, 'รหัสห้อง/แผนกใช้ A-Z, 0-9, _ ยาว 2-20 ตัว');
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'กรุณาใส่ชื่อห้อง/แผนก');
  const depCodes = [...new Set((Array.isArray(b.dep_codes) ? b.dep_codes : []).map((d) => String(d).trim()).filter(Boolean))];
  if (depCodes.some((d) => d.length > 20)) throw new HttpError(400, 'รหัสแผนกไม่ถูกต้อง');
  return { code, name, depCodes, sortOrder: Number(b.sort_order) || 0, isActive: b.is_active !== false };
}

router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const p = readBody(req.body);
  try {
    await db.query('INSERT INTO service_points (code, name, dep_codes, sort_order, is_active) VALUES ($1, $2, $3, $4, $5)',
      [p.code, p.name, JSON.stringify(p.depCodes), p.sortOrder, p.isActive]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'รหัสห้อง/แผนกนี้มีอยู่แล้ว');
    throw err;
  }
  await audit(req, 'point_create', { code: p.code });
  res.status(201).json({ code: p.code });
}));

router.put('/:code', requireRole('admin'), asyncHandler(async (req, res) => {
  const p = readBody(req.body);
  const { rowCount } = await db.query(
    `UPDATE service_points SET code = $1, name = $2, dep_codes = $3, sort_order = $4, is_active = $5, updated_at = now()
     WHERE code = $6`, [p.code, p.name, JSON.stringify(p.depCodes), p.sortOrder, p.isActive, req.params.code],
  );
  if (!rowCount) throw new HttpError(404, 'ไม่พบห้อง/แผนก');
  await audit(req, 'point_update', { code: p.code });
  res.json({ code: p.code });
}));

router.delete('/:code', requireRole('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM service_points WHERE code = $1', [req.params.code]);
  if (!rowCount) throw new HttpError(404, 'ไม่พบห้อง/แผนก');
  await audit(req, 'point_delete', { code: req.params.code });
  res.json({ ok: true });
}));

/* ---------- ทะเบียนของห้อง/แผนก ---------- */
function parseFile(req) {
  if (!req.file) throw new HttpError(400, 'กรุณาเลือกไฟล์');
  if (!/\.(xlsx|xls)$/i.test(fileNameOf(req.file))) throw new HttpError(400, 'รองรับเฉพาะไฟล์ .xlsx หรือ .xls');
  let parsed;
  try { parsed = parseRegistry(req.file.buffer); } catch (err) { throw new HttpError(400, `อ่านไฟล์ไม่ได้: ${err.message}`); }
  return parsed;
}

/** ข้อมูลพรีวิวไฟล์ทะเบียน (ใช้ร่วมกันทั้งแบบเลือกแผนกตอนอัปโหลด และแบบระบุห้อง/แผนกเดิม) */
function previewPayload(req, parsed) {
  const noAmount = parsed.records.filter((r) => r.price === null || r.price === undefined);
  return {
    noAmountRows: noAmount.length,       // แถวที่ไม่มียอดเงิน: เทียบเฉพาะว่ามีค่าใช้จ่ายของห้องนี้ใน HOSxP หรือไม่
    fileName: fileNameOf(req.file),
    sheetName: parsed.sheetName, headerRowNumber: parsed.headerRowNumber, columns: parsed.columns,
    missingRequired: parsed.missingRequired, totalRows: parsed.totalRows,
    validRows: parsed.records.length,
    errorCount: parsed.errorCount,
    errors: parsed.errors.slice(0, 50),
    dateFrom: parsed.dateFrom, dateTo: parsed.dateTo,
    totalAmount: parsed.records.reduce((a, r) => a + Number(r.price || 0), 0),
  };
}

/** อ่านแผนกที่ผู้ใช้เลือกตอนอัปโหลด (dep_codes เป็น JSON หรือคั่นด้วยจุลภาค) */
async function readDepCodes(body) {
  let raw = body?.dep_codes;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = raw.split(','); }
  }
  const codes = [...new Set((Array.isArray(raw) ? raw : []).map((d) => String(d).trim()).filter(Boolean))];
  if (!codes.length) throw new HttpError(400, 'กรุณาเลือกห้อง/แผนก อย่างน้อย 1 แผนก');
  if (codes.some((d) => !/^[\w-]{1,20}$/.test(d))) throw new HttpError(400, 'รหัสแผนกไม่ถูกต้อง');
  const known = new Set((await departments()).map((d) => String(d.code)));
  const unknown = known.size ? codes.filter((c) => !known.has(c)) : [];
  if (unknown.length) throw new HttpError(400, `ไม่พบแผนก: ${unknown.join(', ')}`);
  return codes;
}

// ไม่ต้องตั้งค่าห้อง/แผนกล่วงหน้า: เลือกแผนกตอนอัปโหลด ระบบหา/สร้างห้อง/แผนกให้เอง
router.post('/registry/preview', upload.single('file'), asyncHandler(async (req, res) => {
  const parsed = parseFile(req);
  const suggested = await suggestDepCodes([fileNameOf(req.file), parsed.titleText, ...(parsed.sheetNames || [])]);
  res.json({ ...previewPayload(req, parsed), suggestedDepCodes: suggested });
}));

router.post('/registry', upload.single('file'), asyncHandler(async (req, res) => {
  const depCodes = await readDepCodes(req.body);
  const parsed = parseFile(req);
  if (parsed.missingRequired.length) throw new HttpError(400, `ไม่พบคอลัมน์: ${parsed.missingRequired.join(', ')}`);
  // ตรวจว่ามีรายการนำเข้าได้ก่อน แล้วค่อยสร้างห้อง/แผนกอัตโนมัติ (ไม่ทิ้งห้องเปล่าไว้เมื่ออัปโหลดไม่สำเร็จ)
  if (!parsed.records.length) throw new HttpError(400, 'ไม่พบรายการที่นำเข้าได้ในไฟล์');
  const point = await ensurePoint(depCodes);
  const result = await importPointRegistry({ point: point.code, fileName: fileNameOf(req.file), parsed, userId: req.user.id });
  await audit(req, 'point_registry_import', { point: point.code, depCodes, created: point.created, rows: result.inserted });
  res.status(201).json({ ...result, point: { code: point.code, name: point.name, dep_codes: point.dep_codes, created: point.created } });
}));

router.get('/template', (_req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="registry_template_point.xlsx"');
  res.send(pointTemplate());
});

router.post('/:code/registry/preview', upload.single('file'), asyncHandler(async (req, res) => {
  const point = await readPoint(req.params.code);
  const parsed = parseFile(req);
  res.json({ ...previewPayload(req, parsed), point: { code: point.code, name: point.name } });
}));

router.post('/:code/registry', upload.single('file'), asyncHandler(async (req, res) => {
  const point = await readPoint(req.params.code);
  const parsed = parseFile(req);
  if (parsed.missingRequired.length) throw new HttpError(400, `ไม่พบคอลัมน์: ${parsed.missingRequired.join(', ')}`);
  const result = await importPointRegistry({ point: point.code, fileName: fileNameOf(req.file), parsed, userId: req.user.id });
  if (!result.inserted) throw new HttpError(400, 'ไม่พบรายการที่นำเข้าได้ในไฟล์');
  await audit(req, 'point_registry_import', { point: point.code, inserted: result.inserted });
  res.status(201).json({ inserted: result.inserted, replaced: result.replaced, errorCount: result.errors.length });
}));

router.get('/:code/batches', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.id, b.file_name, b.date_from, b.date_to, b.valid_rows, b.error_rows, b.created_at, b.uploaded_by,
            u.full_name AS uploaded_by_name,
            (SELECT COUNT(*)::int FROM point_registry_rows r WHERE r.batch_id = b.id) AS current_rows
     FROM point_registry_batches b LEFT JOIN users u ON u.id = b.uploaded_by
     WHERE b.point_code = $1 ORDER BY b.created_at DESC LIMIT 50`, [req.params.code],
  );
  res.json(rows);
}));

router.delete('/batches/:id', asyncHandler(async (req, res) => {
  const { rows: [b] } = await db.query('SELECT id, uploaded_by FROM point_registry_batches WHERE id = $1', [Number(req.params.id)]);
  if (!b) throw new HttpError(404, 'ไม่พบการอัปโหลด');
  if (req.user.role !== 'admin' && b.uploaded_by !== req.user.id) throw new HttpError(403, 'ลบได้เฉพาะไฟล์ที่ตนเองอัปโหลด');
  await db.query('DELETE FROM point_registry_batches WHERE id = $1', [b.id]);
  await audit(req, 'point_registry_delete', { batchId: b.id });
  res.json({ ok: true });
}));

router.get('/:code/template', asyncHandler(async (req, res) => {
  const point = await readPoint(req.params.code);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="point_template_${point.code}.xlsx"`);
  res.send(pointTemplate(point));
}));

function readCompare(q) {
  const range = readDateRange(q);
  if (q.status && !POINT_STATUSES[q.status]) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  return { ...range, status: q.status || null, search: q.search, page: q.page, pageSize: q.pageSize, ...readSort(q) };
}

router.get('/:code/compare', asyncHandler(async (req, res) => {
  const point = await readPoint(req.params.code);
  const opts = readCompare(req.query);
  const data = await comparePoint({ ...opts, point });
  await audit(req, 'point_compare', { point: point.code, dateFrom: opts.dateFrom, dateTo: opts.dateTo });
  res.json(data);
}));

router.get('/:code/compare/export', asyncHandler(async (req, res) => {
  const point = await readPoint(req.params.code);
  const opts = readCompare(req.query);
  const { buffer, count } = await exportPoint({ ...opts, point });
  await audit(req, 'point_export', { point: point.code, rows: count });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="point_${point.code}_${opts.dateFrom}_${opts.dateTo}.xlsx"`);
  res.send(buffer);
}));

export default router;
