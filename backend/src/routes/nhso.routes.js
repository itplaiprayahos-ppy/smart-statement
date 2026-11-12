import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';
import { INSCLS, getSession, nhsoSyncEnabled, relistSession, startImport, startSession, stopSession, zipDownloads } from '../services/nhsoService.js';

/** นำเข้าได้ครั้งละไม่เกินกี่ไฟล์ (กันดึงถี่/ยาวเกินไป) */
const MAX_IMPORT_FILES = 60;

/**
 * ดึงไฟล์ REP จากเว็บ e-Claim (ระยะที่ 1 อ่านรายการ + ระยะที่ 2 ดาวน์โหลดและนำเข้า)
 *   POST   /api/nhso/sync        { type: 'REP', month: 1-12, year: พ.ศ. หรือ ค.ศ. } เปิดเบราว์เซอร์ให้สแกน ThaiD
 *   GET    /api/nhso/sync/:id    โพลสถานะ: starting | waiting_login | listing | ready | error | closed
 *   POST   /api/nhso/sync/:id/import  { repNos: [...] } ดาวน์โหลด+นำเข้าไฟล์ OP ที่เลือก
 *   DELETE /api/nhso/sync/:id    ปิดเซสชัน/เบราว์เซอร์
 * ใช้ได้เฉพาะ admin และ user (บทบาทผู้บริหารถูกกันที่ app.js อยู่แล้ว)
 */
const router = Router();

// ปิดใช้งานได้ (NHSO_SYNC_ENABLED=false) และค่าเริ่มต้นคือปิดใน production เพราะต้องเปิดเบราว์เซอร์บนเครื่องเซิร์ฟเวอร์
router.use((_req, _res, next) => (nhsoSyncEnabled()
  ? next()
  : next(new HttpError(404, 'ฟีเจอร์ดึงไฟล์จาก e-Claim ปิดใช้งานอยู่ (ตั้ง NHSO_SYNC_ENABLED=true ใน .env เพื่อเปิด)'))));

// ผลลัพธ์มีข้อมูลการเบิกของหน่วยบริการ ห้ามให้เบราว์เซอร์หรือพร็อกซีเก็บแคช
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// บทบาทที่ใช้ได้ ตั้งใน .env ได้ เช่น NHSO_SYNC_ROLES=admin (ค่าเริ่มต้น admin,user เท่ากับสิทธิ์นำเข้าไฟล์)
const ROLES = String(process.env.NHSO_SYNC_ROLES || 'admin,user').split(',').map((x) => x.trim()).filter(Boolean);
router.use(requireRole(...ROLES));

// จำกัดความถี่: เริ่มเซสชันใหม่ 6 ครั้ง / 10 นาที, การโพลสถานะ/นำเข้า 120 ครั้ง / นาที
const startLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false,
  message: { message: 'เริ่มดึงไฟล์บ่อยเกินไป กรุณารอสักครู่' },
});
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
  message: { message: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่' },
});
router.use(generalLimiter);

router.post('/sync', startLimiter, asyncHandler(async (req, res) => {
  const { type = 'REP' } = req.body || {};
  const month = Number(req.body?.month);
  let year = Number(req.body?.year);
  const inscl = String(req.body?.inscl || 'ucs').toLowerCase();
  if (!INSCLS[inscl]) throw new HttpError(400, 'สิทธิไม่ถูกต้อง');
  if (type !== 'REP') throw new HttpError(400, 'ตอนนี้รองรับเฉพาะ REP (STM ยังไม่รองรับ)');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new HttpError(400, 'เดือนต้องเป็นเลข 1–12');
  if (!Number.isInteger(year)) throw new HttpError(400, 'ปีไม่ถูกต้อง');
  if (year < 2400) year += 543; // รับทั้ง ค.ศ. และ พ.ศ.
  if (year < 2550 || year > 2600) throw new HttpError(400, 'ปีไม่ถูกต้อง');

  let session;
  try {
    session = await startSession({ type, month, year, inscl, ownerId: req.user.id });
  } catch (err) {
    if (err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
  await audit(req, 'nhso_sync_start', { type, inscl, month, year });
  res.status(202).json(session);
}));

/** เปลี่ยนสิทธิ/เดือน/ปี ในเซสชันเดิมที่ล็อกอินอยู่ (ไม่ต้องสแกน ThaiD ใหม่) */
router.post('/sync/:id/list', asyncHandler(async (req, res) => {
  const inscl = String(req.body?.inscl || 'ucs').toLowerCase();
  const month = Number(req.body?.month);
  let year = Number(req.body?.year);
  if (!INSCLS[inscl]) throw new HttpError(400, 'สิทธิไม่ถูกต้อง');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new HttpError(400, 'เดือนต้องเป็นเลข 1–12');
  if (!Number.isInteger(year)) throw new HttpError(400, 'ปีไม่ถูกต้อง');
  if (year < 2400) year += 543;
  if (year < 2550 || year > 2600) throw new HttpError(400, 'ปีไม่ถูกต้อง');
  let session;
  try {
    session = await relistSession(req.params.id, req.user.id, { type: 'REP', inscl, month, year });
  } catch (err) {
    if (err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
  await audit(req, 'nhso_sync_relist', { inscl, month, year });
  res.status(202).json(session);
}));

router.get('/sync/:id', asyncHandler(async (req, res) => {
  const session = getSession(req.params.id, req.user.id);
  if (!session) throw new HttpError(404, 'ไม่พบเซสชัน (อาจถูกปิดแล้ว)');
  res.json(session);
}));

/**
 * นำเข้าไฟล์ที่เลือก { repNos: ['690900086', ...] } (เฉพาะ OP) ทำงานเบื้องหลัง ดูผลที่ GET /sync/:id (importResults)
 * ดาวน์โหลดทีละไฟล์ มีหน่วงเวลา ไฟล์อยู่ในหน่วยความจำ ไม่เขียนลงดิสก์
 */
router.post('/sync/:id/import', asyncHandler(async (req, res) => {
  const repNos = Array.isArray(req.body?.repNos) ? req.body.repNos.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!repNos.length) throw new HttpError(400, 'กรุณาเลือกไฟล์ที่จะนำเข้า');
  if (repNos.length > MAX_IMPORT_FILES) throw new HttpError(400, `นำเข้าได้ครั้งละไม่เกิน ${MAX_IMPORT_FILES} ไฟล์`);
  let session;
  try {
    session = await startImport(req.params.id, {
      repNos,
      userId: req.user.id,
      onFinish: (summary) => audit(req, 'nhso_import', { repNos, ...summary }),
    });
  } catch (err) {
    if (err.status) throw new HttpError(err.status, err.message);
    throw err;
  }
  await audit(req, 'nhso_import_start', { repNos });
  res.status(202).json(session);
}));

/** ดาวน์โหลดไฟล์ REP ที่โหลดมาในเซสชันนี้เป็น zip (ไฟล์อยู่ในหน่วยความจำจนกว่าเซสชันจะปิด) */
router.get('/sync/:id/files.zip', asyncHandler(async (req, res) => {
  const zip = zipDownloads(req.params.id, req.user.id);
  if (!zip) throw new HttpError(404, 'ไม่มีไฟล์ให้บันทึก (เซสชันอาจปิดแล้ว)');
  await audit(req, 'nhso_zip_download', {});
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zip.name}"` });
  res.send(zip.data);
}));

router.delete('/sync/:id', asyncHandler(async (req, res) => {
  const ok = await stopSession(req.params.id, req.user.id);
  if (!ok) throw new HttpError(404, 'ไม่พบเซสชัน (อาจถูกปิดแล้ว)');
  await audit(req, 'nhso_sync_stop', {});
  res.json({ ok: true });
}));

export default router;
