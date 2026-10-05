import { Router } from 'express';
import multer from 'multer';
import { db } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { parseExcel } from '../services/excelParser.js';
import { saveImport } from '../services/importService.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(), // ไม่เขียนไฟล์ข้อมูลผู้ป่วยลงดิสก์
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new HttpError(400, 'รองรับเฉพาะไฟล์ .xlsx และ .xls'), ok);
  },
});

// multer อ่านชื่อไฟล์เป็น latin1 แปลงกลับเป็น UTF-8 เพื่อให้ชื่อไฟล์ภาษาไทยถูกต้อง
const fileNameOf = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

async function loadFunds() {
  const { rows } = await db.query('SELECT code, stm_columns FROM funds WHERE is_active ORDER BY sort_order, code');
  return rows;
}

async function loadProfile(mappingId) {
  const { rows } = await db.query('SELECT * FROM column_mappings WHERE id = $1 AND is_active', [Number(mappingId)]);
  if (!rows[0]) throw new HttpError(400, 'กรุณาเลือกรูปแบบไฟล์ที่ใช้งานอยู่');
  return rows[0];
}

function requireFile(req) {
  if (!req.file) throw new HttpError(400, 'กรุณาเลือกไฟล์ Excel');
}

/** อ่านไฟล์เพื่อแสดงตัวอย่าง ยังไม่บันทึก */
router.post('/preview', upload.single('file'), asyncHandler(async (req, res) => {
  requireFile(req);
  const profile = await loadProfile(req.body.mappingId);
  const parsed = parseExcel(req.file.buffer, profile, await loadFunds());
  res.json({
    fileName: fileNameOf(req.file),
    sheetName: parsed.sheetName,
    sheetNames: parsed.sheetNames,
    headerRowNumber: parsed.headerRowNumber,
    matchedColumns: parsed.matchedColumns,
    fundColumns: parsed.fundColumns,
    headers: parsed.headers,
    headerDepth: parsed.headerDepth,
    missingRequired: parsed.missingRequired,
    totalRows: parsed.totalRows,
    validRows: parsed.records.length,
    errorCount: parsed.errorCount,
    errors: parsed.errors.slice(0, 50),
    sample: parsed.records.slice(0, 10).map(({ raw, line_key, ...r }) => r),
  });
}));

/** นำเข้าจริง */
router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  requireFile(req);
  const profile = await loadProfile(req.body.mappingId);
  const parsed = parseExcel(req.file.buffer, profile, await loadFunds());
  if (parsed.missingRequired.length) {
    throw new HttpError(400, `ไฟล์ขาดคอลัมน์ที่จำเป็น: ${parsed.missingRequired.join(', ')}`);
  }
  if (!parsed.records.length) throw new HttpError(400, 'ไม่พบรายการที่นำเข้าได้ในไฟล์');

  const fileName = fileNameOf(req.file);
  const result = await saveImport({ fileName, profile, parsed, userId: req.user.id });
  await audit(req, 'import', { fileName, batchId: result.batchId, rows: parsed.records.length });
  res.status(201).json(result);
}));

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.id, b.file_name, b.claim_type, b.total_rows, b.inserted_rows, b.updated_rows,
            b.error_rows, b.created_at, m.name AS mapping_name, u.username AS imported_by,
            (SELECT COUNT(*)::int FROM nhso_lines l WHERE l.batch_id = b.id) AS current_rows,
            (SELECT MIN(service_date) FROM nhso_lines l WHERE l.batch_id = b.id) AS date_min,
            (SELECT MAX(service_date) FROM nhso_lines l WHERE l.batch_id = b.id) AS date_max
     FROM import_batches b
     LEFT JOIN column_mappings m ON m.id = b.mapping_id
     LEFT JOIN users u ON u.id = b.imported_by
     WHERE ($1::text IS NULL OR b.claim_type = $1)
     ORDER BY b.created_at DESC LIMIT 100`,
    [req.query.claimType || null],
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM import_batches WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'ไม่พบประวัติการนำเข้า');
  res.json(rows[0]);
}));

router.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await db.query('DELETE FROM import_batches WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'ไม่พบประวัติการนำเข้า');
  await audit(req, 'import_delete', { batchId: id });
  res.json({ ok: true });
}));

export default router;
