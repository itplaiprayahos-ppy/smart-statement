// แปลงค่าวันที่หลายรูปแบบจากไฟล์ Excel ให้เป็น 'YYYY-MM-DD' (ค.ศ.)
// รองรับ: Date object, Excel serial number, 'dd/mm/yyyy', 'yyyy-mm-dd', ปี พ.ศ.

const pad = (n) => String(n).padStart(2, '0');

function toIso(y, m, d) {
  if (y > 2400) y -= 543; // พ.ศ. -> ค.ศ.
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // เช่น 31/02
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toIso(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number') {
    // Excel serial date (1900 date system)
    if (value < 20000 || value > 120000) return null;
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  const s = String(value).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return toIso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return toIso(+m[3], +m[2], +m[1]);
  if (/^\d{8}$/.test(s)) return toIso(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
  return null;
}

/** ตรวจรูปแบบ YYYY-MM-DD จาก query string */
export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDate(s) === s;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
