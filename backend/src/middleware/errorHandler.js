import multer from 'multer';
import { isProd } from '../config/env.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกินกำหนด' : err.message;
    return res.status(400).json({ message });
  }

  const status = err.status || 500;
  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);

  // ตาราง/คอลัมน์ไม่มี = ฐานข้อมูลเก่ากว่าโปรแกรม (ลืมรัน migrate) บอกวิธีแก้ให้ชัด ไม่ซ่อนเป็นข้อความทั่วไป
  const schemaOutdated = err.code === '42703' || err.code === '42P01';
  const message = schemaOutdated
    ? 'ฐานข้อมูลยังไม่ตรงกับเวอร์ชันของโปรแกรม กรุณาให้ผู้ดูแลระบบรัน npm run migrate ในโฟลเดอร์ backend แล้วเปิดเซิร์ฟเวอร์ใหม่'
    : (status >= 500 && isProd ? 'เกิดข้อผิดพลาดภายในระบบ' : err.message);

  res.status(status).json({
    message,
    ...(err.details ? { details: err.details } : {}),
  });
}

export function notFound(req, res) {
  res.status(404).json({ message: `ไม่พบ ${req.method} ${req.originalUrl}` });
}
