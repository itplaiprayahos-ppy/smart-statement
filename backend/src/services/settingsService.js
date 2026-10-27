import { db } from '../config/db.js';

/* =====================================================================
 * รายการที่ทะเบียนห้อง/แผนกจะรวมหรือไม่รวมก็ได้ (optional_fee_items)
 *  - ค่าบริการที่ติดอัตโนมัติ เช่น "ค่าบริการผู้ป่วยนอก" 50 บาท ที่ HOSxP คิดทุก visit
 *  - ยา: เลือกเป็นรายการ (drugitems) หรือ "ยาทั้งหมด" (ทุก icode ที่อยู่ใน drugitems)
 * ระบบเทียบยอดทะเบียนกับ HOSxP ทั้งแบบรวมและไม่รวมรายการเหล่านี้ ตรงแบบใดแบบหนึ่งถือว่าตรง
 * เก็บเป็น { items: [{icode, name, price, source}], allDrugs: boolean } (รุ่นก่อนเก็บเป็นอาร์เรย์ของรายการ)
 * ===================================================================== */
const KEY = 'optional_fee_items';

export async function getOptionalFeeItems() {
  const { rows: [r] } = await db.query('SELECT value, updated_at FROM app_settings WHERE key = $1', [KEY]);
  const v = r?.value;
  const items = Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : [];
  return { items, allDrugs: !Array.isArray(v) && v?.allDrugs === true, updatedAt: r?.updated_at || null };
}

/** ค่าที่ใช้ตอนดึง HOSxP: icode ที่เลือก และยกเว้นยาทั้งหมดหรือไม่ */
export async function optionalFeeConfig() {
  const s = await getOptionalFeeItems();
  return { icodes: s.items.map((i) => String(i.icode)), allDrugs: s.allDrugs };
}

export async function optionalFeeIcodes() {
  return (await optionalFeeConfig()).icodes;
}

export async function saveOptionalFeeItems(items, userId, allDrugs = undefined) {
  const clean = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((i) => {
    const icode = String(i?.icode || '').trim();
    if (!icode || icode.length > 20 || seen.has(icode)) return;
    seen.add(icode);
    clean.push({
      icode,
      name: String(i.name || '').slice(0, 300) || null,
      price: i.price != null && i.price !== '' ? Number(i.price) : null,
      source: i.source === 'drug' ? 'drug' : 'nondrug',
    });
  });
  const keepDrugs = allDrugs === undefined ? (await getOptionalFeeItems()).allDrugs : allDrugs === true;
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KEY, JSON.stringify({ items: clean, allDrugs: keepDrugs }), userId],
  );
  return getOptionalFeeItems();
}
