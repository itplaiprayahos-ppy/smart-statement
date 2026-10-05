import { db } from '../config/db.js';

/** บันทึกว่าใครทำอะไรกับข้อมูลผู้ป่วย (ไม่ทำให้ request ล้มถ้าบันทึกไม่สำเร็จ) */
export async function audit(req, action, detail = {}) {
  try {
    await db.query(
      'INSERT INTO access_logs (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)',
      [req.user?.id ?? null, action, JSON.stringify(detail), req.ip],
    );
  } catch (err) {
    console.error('audit log failed:', err.message);
  }
}
