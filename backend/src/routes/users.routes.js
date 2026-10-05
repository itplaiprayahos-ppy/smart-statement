import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../config/db.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { audit } from '../utils/audit.js';

const router = Router();
router.use(requireRole('admin'));

const ROLES = ['admin', 'user'];
const COLUMNS = 'id, username, full_name, role, is_active, last_login_at, created_at';

function checkPassword(pw) {
  if (!pw || String(pw).length < 8) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
}

router.get('/', asyncHandler(async (_req, res) => {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users ORDER BY username`);
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { username, password, full_name, role = 'user' } = req.body || {};
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username || '')) {
    throw new HttpError(400, 'ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ความยาว 3–50 ตัว');
  }
  if (!ROLES.includes(role)) throw new HttpError(400, 'role ไม่ถูกต้อง');
  checkPassword(password);

  const hash = await bcrypt.hash(String(password), 12);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [username, hash, full_name || null, role],
    );
    await audit(req, 'user_create', { username, role });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
    throw err;
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { full_name, role, is_active } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, 'role ไม่ถูกต้อง');
  if (id === req.user.id && (role === 'user' || is_active === false)) {
    throw new HttpError(400, 'ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเองได้');
  }

  const { rows } = await db.query(
    `UPDATE users SET
       full_name = COALESCE($2, full_name),
       role      = COALESCE($3, role),
       is_active = COALESCE($4, is_active),
       updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, full_name ?? null, role ?? null, typeof is_active === 'boolean' ? is_active : null],
  );
  if (!rows[0]) throw new HttpError(404, 'ไม่พบผู้ใช้');
  await audit(req, 'user_update', { id, role, is_active });
  res.json(rows[0]);
}));

router.post('/:id/reset-password', asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  checkPassword(password);
  const hash = await bcrypt.hash(String(password), 12);
  const { rowCount } = await db.query(
    'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
    [hash, Number(req.params.id)],
  );
  if (!rowCount) throw new HttpError(404, 'ไม่พบผู้ใช้');
  await audit(req, 'user_reset_password', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

export default router;
