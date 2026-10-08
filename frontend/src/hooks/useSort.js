import { useMemo, useState } from 'react';

/** เทียบค่าแบบเข้าใจภาษาไทยและตัวเลข ค่าว่างอยู่ท้ายเสมอ */
export function compareValues(a, b) {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const na = typeof a === 'number' ? a : (typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a.trim()) ? Number(a) : NaN);
  const nb = typeof b === 'number' ? b : (typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b.trim()) ? Number(b) : NaN);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'th', { numeric: true, sensitivity: 'base' });
}

/** สถานะการเรียง: { key, dir } กดคอลัมน์เดิมสลับทิศ กดคอลัมน์ใหม่เริ่มน้อยไปมาก */
export function useSortState(initial = { key: null, dir: 'asc' }) {
  const [sort, setSort] = useState(initial);
  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  return [sort, toggle, setSort];
}

/**
 * เรียงข้อมูลในหน้าเว็บ (ตารางที่ไม่แบ่งหน้า)
 * accessors: { key: (row) => ค่าที่ใช้เรียง } ถ้าไม่ระบุใช้ row[key]
 */
export function useSort(rows, initial, accessors = {}) {
  const [sort, toggle, setSort] = useSortState(initial);
  const sorted = useMemo(() => {
    if (!rows || !sort.key) return rows || [];
    const get = accessors[sort.key] || ((r) => r[sort.key]);
    const sign = sort.dir === 'desc' ? -1 : 1;
    return [...rows]
      .map((r, i) => [r, i])
      .sort(([a, ia], [b, ib]) => {
        const va = get(a); const vb = get(b);
        const emptyA = va === null || va === undefined || va === '';
        const emptyB = vb === null || vb === undefined || vb === '';
        if (emptyA || emptyB) return emptyA === emptyB ? ia - ib : emptyA ? 1 : -1; // ค่าว่างท้ายเสมอ ทั้งสองทิศ
        return sign * compareValues(va, vb) || ia - ib;
      })
      .map(([r]) => r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  return { sorted, sort, toggle, setSort };
}
