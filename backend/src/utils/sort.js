/**
 * การเรียงตารางฝั่งเซิร์ฟเวอร์ (ตารางแบ่งหน้า)
 * รับเฉพาะชื่อคอลัมน์ที่อยู่ใน map (whitelist) แล้วแปลงเป็นนิพจน์ SQL จึงไม่เปิดช่อง SQL injection
 */
export const readSort = (q) => ({
  sort: typeof q.sort === 'string' && /^[a-z_]{1,20}$/.test(q.sort) ? q.sort : null,
  dir: q.dir === 'desc' ? 'desc' : 'asc',
});

export function orderBy(map, { sort, dir } = {}, fallback) {
  const expr = sort ? map[sort] : null;
  if (!expr) return `ORDER BY ${fallback}`;
  return `ORDER BY ${expr} ${dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${fallback}`;
}

// ใช้ Intl.Collator ตัวเดียว เร็วกว่า localeCompare หลายเท่าเมื่อเรียงหลักแสนแถว
const collator = new Intl.Collator('th', { numeric: true, sensitivity: 'base' });

/** เรียงอาร์เรย์ในฝั่งเซิร์ฟเวอร์ (ใช้กับผลที่คำนวณใน JS) ค่าว่างอยู่ท้ายเสมอ */
export function sortRows(rows, getters, { sort, dir } = {}) {
  const get = sort ? getters[sort] : null;
  if (!get) return rows;
  const sign = dir === 'desc' ? -1 : 1;
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
  // คำนวณค่าที่ใช้เรียงครั้งเดียวต่อแถว (ไม่เรียก get/num ซ้ำทุกครั้งที่เปรียบเทียบ)
  return rows.map((r, i) => {
    const v = get(r);
    const empty = v === null || v === undefined || v === '';
    return { r, i, empty, n: empty ? NaN : num(v), s: empty ? '' : String(v) };
  }).sort((a, b) => {
    if (a.empty || b.empty) return a.empty === b.empty ? a.i - b.i : a.empty ? 1 : -1;
    const c = !Number.isNaN(a.n) && !Number.isNaN(b.n) ? a.n - b.n : collator.compare(a.s, b.s);
    return sign * c || a.i - b.i;
  }).map((x) => x.r);
}
