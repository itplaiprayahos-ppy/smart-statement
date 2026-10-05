const moneyFmt = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('th-TH');

export const money = (v) => (v === null || v === undefined ? '–' : moneyFmt.format(Number(v)));
export const int = (v) => intFmt.format(Number(v || 0));

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY (พ.ศ.)' */
export function thaiDate(iso) {
  if (!iso) return '–';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${Number(y) + 543}`;
}

export function thaiDateTime(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

const pad = (n) => String(n).padStart(2, '0');
export const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** ช่วงวันที่ของเดือนก่อนหน้า (ค่าเริ่มต้นของการกระทบยอด) */
export function lastMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { dateFrom: toIso(first), dateTo: toIso(last) };
}

export const STATUS_META = {
  MATCHED:     { label: 'ตรงกัน',               color: 'var(--st-matched)',  hex: '#2f7d4f', hint: 'พบทั้งสองฝั่งและยอดเท่ากัน' },
  AMOUNT_DIFF: { label: 'ยอดต่าง',              color: 'var(--st-diff)',     hex: '#b7791f', hint: 'พบทั้งสองฝั่ง แต่ยอดไม่เท่ากัน' },
  DENIED:      { label: 'ถูกปฏิเสธ / ติด C',     color: 'var(--st-denied)',   hex: '#b42318', hint: 'สปสช. ส่งรหัสข้อผิดพลาดกลับมา' },
  MULTIPLE:    { label: 'หลายครั้งในวันเดียว',     color: 'var(--st-multiple)', hex: '#6b4fa0', hint: 'ระบบจับคู่ตามลำดับยอดเงิน ควรตรวจสอบ' },
  NOT_IN_STM:  { label: 'ไม่พบใน Statement',     color: 'var(--st-not-stm)',  hex: '#5b6b73', hint: 'มีใน HOSxP แต่ยังไม่มีผลจาก สปสช.' },
  NOT_IN_HIS:  { label: 'ไม่พบใน HOSxP',        color: 'var(--st-not-his)',  hex: '#2563a6', hint: 'มีใน Statement แต่หาใน HOSxP ไม่เจอ' },
};
export const STATUS_ORDER = Object.keys(STATUS_META);

export const FUNDS = [
  { value: 'UCS', label: 'UC บัตรทอง (UCS)' },
  { value: 'OFC', label: 'ข้าราชการ (OFC)' },
  { value: 'LGO', label: 'อปท. (LGO)' },
  { value: 'SSS', label: 'ประกันสังคม (SSS)' },
  { value: '', label: 'ทุกสิทธิ' },
];

/* ---------- ปีงบประมาณ (1 ต.ค. – 30 ก.ย.) ---------- */

/** ปีงบประมาณ พ.ศ. ของวันที่ที่ระบุ เช่น 5 ต.ค. 2569 -> ปีงบ 2570 */
export function fiscalYearOf(date = new Date()) {
  const y = date.getFullYear() + 543;
  return date.getMonth() >= 9 ? y + 1 : y; // เดือน ต.ค. (index 9) ขึ้นปีงบใหม่
}

/** ปีงบ พ.ศ. -> ช่วงวันที่ ค.ศ. เช่น 2569 -> 2025-10-01 ถึง 2026-09-30 */
export function fiscalYearRange(fyBE) {
  const endYear = fyBE - 543;
  return { dateFrom: `${endYear - 1}-10-01`, dateTo: `${endYear}-09-30` };
}

/** ปีงบปัจจุบันย้อนหลัง n ปี สำหรับตัวเลือก */
export function fiscalYearOptions(n = 5) {
  const cur = fiscalYearOf();
  return Array.from({ length: n }, (_, i) => cur - i);
}

/** จำนวนวันในช่วง (นับรวมวันแรกและวันสุดท้าย) */
export const daysInRange = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

export const MAX_RANGE_DAYS = 366;

/** ตัวเลือกช่วงเวลาด่วน: เดือนที่แล้ว และปีงบประมาณย้อนหลัง 5 ปี */
export const PERIODS = [
  { value: 'last-month', label: 'เดือนที่แล้ว', range: lastMonthRange },
  ...fiscalYearOptions(5).map((fy) => ({
    value: `fy-${fy}`,
    label: `ปีงบ ${fy}`,
    range: () => fiscalYearRange(fy),
  })),
];

export function periodOf({ dateFrom, dateTo }) {
  const hit = PERIODS.find((p) => {
    const r = p.range();
    return r.dateFrom === dateFrom && r.dateTo === dateTo;
  });
  return hit ? hit.value : 'custom';
}

/** ตรวจช่วงวันที่ฝั่งหน้าเว็บ คืนข้อความผิดพลาด หรือ null */
export function rangeErrorOf({ dateFrom, dateTo }) {
  if (!dateFrom || !dateTo) return 'กรุณาเลือกวันที่ให้ครบทั้งสองช่อง';
  if (dateFrom > dateTo) return 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด';
  if (daysInRange(dateFrom, dateTo) > MAX_RANGE_DAYS) return `เลือกช่วงวันที่ได้ไม่เกิน ${MAX_RANGE_DAYS} วัน (1 ปีงบประมาณ)`;
  return null;
}

/** สถานะการเบิกรายกองทุน */
export const FUND_STATUS_META = {
  PAID:     { label: 'ได้รับเงิน',              color: 'var(--st-matched)', hint: 'ส่งเบิกแล้วและได้รับเงินกองทุนนี้' },
  NOT_PAID: { label: 'ไม่ได้รับเงินกองทุนนี้',     color: 'var(--st-diff)',    hint: 'พบใน Statement แต่ยอดกองทุนนี้เป็น 0' },
  DENIED:   { label: 'ถูกปฏิเสธ / ติด C',        color: 'var(--st-denied)',  hint: 'สปสช. ส่งรหัสข้อผิดพลาดกลับมา' },
  NOT_SENT: { label: 'ไม่พบใน Statement',       color: 'var(--st-not-stm)', hint: 'ยังไม่ส่งเบิก หรือยังไม่มีผลจาก สปสช.' },
};
/** สถานะของ visit ที่เข้าเกณฑ์ (ไม่รวมผลตรวจย้อนกลับ) */
export const FUND_STATUS_ORDER = Object.keys(FUND_STATUS_META);

/** ผลตรวจย้อนกลับ: ได้รับเงินกองทุน แต่ไม่เข้าเกณฑ์ตามการตั้งค่า */
export const EXTRA_PAID_META = {
  label: 'ได้รับเงินแต่ไม่เข้าเกณฑ์', color: 'var(--st-not-his)',
  hint: 'สปสช. จ่ายเงินกองทุนนี้ แต่ visit ไม่มีรายการหรือสิทธิตามที่ตั้งค่า',
};
export const ALL_FUND_STATUS_META = { ...FUND_STATUS_META, EXTRA_PAID: EXTRA_PAID_META };

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** 'YYYY-MM' -> 'ต.ค. 68' */
export function thaiMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${TH_MONTHS[m - 1]} ${String(y + 543).slice(2)}`;
}

/** รายการเดือน 'YYYY-MM' ทั้งหมดในช่วงวันที่ */
export function monthsBetween(dateFrom, dateTo) {
  const out = [];
  let [y, m] = dateFrom.split('-').map(Number);
  const end = dateTo.slice(0, 7);
  for (let i = 0; i < 24; i += 1) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > end) break;
    out.push(ym);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '–');

/* ---------- ตัวชี้วัด ---------- */
export const rate = (part, whole) => (whole ? (part / whole) * 100 : null);

/** สีตามเป้าหมาย: ถึงเป้า = เขียว, ต่ำกว่าเป้าไม่เกิน 10 จุด = เหลือง, ต่ำกว่านั้น = แดง */
export function kpiLevel(value, target) {
  if (value === null || value === undefined) return 'none';
  if (value >= target) return 'good';
  if (value >= target - 10) return 'warn';
  return 'bad';
}

export const fmtRate = (v) => (v === null || v === undefined ? '–' : `${v.toFixed(1)}%`);
