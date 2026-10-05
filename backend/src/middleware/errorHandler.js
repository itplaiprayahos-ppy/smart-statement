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

  res.status(status).json({
    message: status >= 500 && isProd ? 'เกิดข้อผิดพลาดภายในระบบ' : err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}

export function notFound(req, res) {
  res.status(404).json({ message: `ไม่พบ ${req.method} ${req.originalUrl}` });
}
