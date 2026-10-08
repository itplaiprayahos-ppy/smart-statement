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

/** เรียงอาร์เรย์ในฝั่งเซิร์ฟเวอร์ (ใช้กับผลที่คำนวณใน JS) ค่าว่างอยู่ท้ายเสมอ */
export function sortRows(rows, getters, { sort, dir } = {}) {
  const get = sort ? getters[sort] : null;
  if (!get) return rows;
  const sign = dir === 'desc' ? -1 : 1;
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
  return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
    const va = get(a); const vb = get(b);
    const ea = va === null || va === undefined || va === ''; const eb = vb === null || vb === undefined || vb === '';
    if (ea || eb) return ea === eb ? ia - ib : ea ? 1 : -1;
    const na = num(va); const nb = num(vb);
    const c = !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb
      : String(va).localeCompare(String(vb), 'th', { numeric: true, sensitivity: 'base' });
    return sign * c || ia - ib;
  }).map(([r]) => r);
}
