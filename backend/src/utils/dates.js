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

/** เดือนภาษาไทย (ชื่อเต็มและย่อ) -> เลขเดือน */
const TH_MONTHS = [
  ['มกราคม', 'ม.ค.'], ['กุมภาพันธ์', 'ก.พ.'], ['มีนาคม', 'มี.ค.'], ['เมษายน', 'เม.ย.'], ['พฤษภาคม', 'พ.ค.'], ['มิถุนายน', 'มิ.ย.'],
  ['กรกฎาคม', 'ก.ค.'], ['สิงหาคม', 'ส.ค.'], ['กันยายน', 'ก.ย.'], ['ตุลาคม', 'ต.ค.'], ['พฤศจิกายน', 'พ.ย.'], ['ธันวาคม', 'ธ.ค.'],
];
const monthOf = (word) => {
  const w = word.replace(/\s+/g, '');
  const bare = (x) => x.replace(/\./g, '');
  const i = TH_MONTHS.findIndex(([full, short]) => w === full || w === short || bare(w) === bare(short));
  return i < 0 ? null : i + 1;
};

/** ปี 2 หลัก: 40-99 = พ.ศ. 25xx (เช่น 69 = 2569), 00-39 = ค.ศ. 20xx (เช่น 26 = 2026) */
const year2 = (yy) => (yy >= 40 ? 2500 + yy : 2000 + yy);

export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // เซลล์วันที่ที่ไลบรารีแปลงเป็น Date อาจคลาดจากเที่ยงคืนไปไม่กี่วินาที/นาที (เขตเวลาเก่าของไทย +06:42)
    // ทำให้กลายเป็นวันก่อนหน้า 23:5x จึงปัดขึ้นเฉพาะเวลาหลัง 23:30 (เวลาอื่นถือเป็นวันเดิม)
    const d = new Date(value.getTime());
    if (d.getHours() * 60 + d.getMinutes() >= 23 * 60 + 30) d.setDate(d.getDate() + 1);
    return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  if (typeof value === 'number') {
    // Excel serial date (1900 date system)
    // เซลล์วันที่ที่พิมพ์ปี พ.ศ. ลงไปตรง ๆ (เช่น 15/09/2569) Excel เก็บเป็นปี 2569 -> serial ประมาณ 244,000 แล้วค่อยลบ 543 ปี
    if (value < 20000 || value > 2958465) return null;
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  // เลขไทย ๐-๙ -> 0-9
  const s = String(value).trim().replace(/[๐-๙]/g, (c) => String(c.charCodeAt(0) - 0x0E50));
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return toIso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return toIso(+m[3], +m[2], +m[1]);
  // วว/ดด/ปป เช่น 15/09/69 (พ.ศ.)
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/);
  if (m) return toIso(year2(+m[3]), +m[2], +m[1]);
  // ชื่อเดือนภาษาไทย เช่น 15 ก.ย. 2569, 15 กันยายน 69, 15ก.ย.69
  m = s.match(/^(\d{1,2})\s*([ก-๙.]+?)\s*(\d{4}|\d{2})(?!\d)/);
  if (m) {
    const mo = monthOf(m[2]);
    if (mo) return toIso(m[3].length === 2 ? year2(+m[3]) : +m[3], mo, +m[1]);
  }
  if (/^\d{8}$/.test(s)) {
    // ddmmyyyy (เช่น 15092569) หรือ yyyymmdd (เช่น 25690915)
    const a = toIso(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    return a || toIso(+s.slice(4, 8), +s.slice(2, 4), +s.slice(0, 2));
  }
  return null;
}

/** ตรวจรูปแบบ YYYY-MM-DD จาก query string */
export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDate(s) === s;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
