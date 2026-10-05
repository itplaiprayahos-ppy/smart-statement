import jwt from 'jsonwebtoken';
import { env, isProd } from '../config/env.js';
import { db } from '../config/db.js';
import { HttpError } from '../utils/http.js';

export const COOKIE_NAME = 'cr_token';

export function cookieOptions() {
  return {
    httpOnly: true,           // JavaScript ฝั่งเบราว์เซอร์อ่าน token ไม่ได้ ลดความเสี่ยง XSS
    sameSite: 'strict',       // กัน CSRF
    secure: isProd,           // production ควรใช้ HTTPS
    maxAge: env.jwtExpiresHours * 3600 * 1000,
    path: '/',
  };
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: `${env.jwtExpiresHours}h`,
  });
}

/** ต้อง login และบัญชียังเปิดใช้งานอยู่ */
export async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw new HttpError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    }

    // ตรวจกับฐานข้อมูลทุกครั้ง เพื่อให้การปิดบัญชี/เปลี่ยน role มีผลทันที
    const { rows } = await db.query(
      'SELECT id, username, full_name, role, is_active FROM users WHERE id = $1',
      [payload.sub],
    );
    const user = rows[0];
    if (!user || !user.is_active) throw new HttpError(401, 'บัญชีนี้ถูกปิดการใช้งาน');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** จำกัดสิทธิ์ตาม role เช่น requireRole('admin') */
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new HttpError(403, 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้'));
  }
  next();
};
