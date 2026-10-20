import { db } from '../config/db.js';

/* =====================================================================
 * ค่าบริการที่ติดอัตโนมัติ (optional_fee_items)
 * เช่น "ค่าบริการผู้ป่วยนอก" 50 บาท ที่ HOSxP คิดทุก visit
 * ทะเบียนห้อง/แผนกจะรวมหรือไม่รวมก็ได้: เทียบยอดทั้งแบบรวมและไม่รวม ตรงแบบใดแบบหนึ่งถือว่าตรง
 * ===================================================================== */
const KEY = 'optional_fee_items';

export async function getOptionalFeeItems() {
  const { rows: [r] } = await db.query('SELECT value, updated_at FROM app_settings WHERE key = $1', [KEY]);
  return { items: Array.isArray(r?.value) ? r.value : [], updatedAt: r?.updated_at || null };
}

export async function optionalFeeIcodes() {
  return (await getOptionalFeeItems()).items.map((i) => String(i.icode));
}

export async function saveOptionalFeeItems(items, userId) {
  const clean = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((i) => {
    const icode = String(i?.icode || '').trim();
    if (!icode || icode.length > 20 || seen.has(icode)) return;
    seen.add(icode);
    clean.push({ icode, name: String(i.name || '').slice(0, 300) || null, price: i.price != null && i.price !== '' ? Number(i.price) : null });
  });
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify(clean), userId],
  );
  return getOptionalFeeItems();
}
