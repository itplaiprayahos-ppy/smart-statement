import { money } from '../utils/format.js';

/** แสดงผลต่างยอดเงิน: ลบเป็นสีแดง บวกเป็นสีน้ำเงิน */
export default function Diff({ value }) {
  if (value === null || value === undefined) return <span className="muted">–</span>;
  if (Math.abs(value) < 0.005) return <span className="muted">0.00</span>;
  return <span className={value < 0 ? 'diff-neg' : 'diff-pos'}>{value > 0 ? '+' : ''}{money(value)}</span>;
}
