import { useEffect, useRef, useState } from 'react';

/** '2026-09-01' -> '01/09/2569' */
export function isoToThai(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${Number(y) + 543}`;
}

/** '01/09/2569' หรือ '1/9/2026' -> '2026-09-01' (ปีมากกว่า 2400 ถือเป็น พ.ศ.) / ไม่ถูกต้อง -> null */
export function thaiToIso(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]); const mo = Number(m[2]); let y = Number(m[3]);
  if (y > 2400) y -= 543;
  if (y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** ใส่ "/" ให้อัตโนมัติขณะพิมพ์: 01092569 -> 01/09/2569 (พิมพ์ / เองหรือไม่ก็ได้) */
export function mask(raw, prev = '') {
  const clean = String(raw).replace(/[^\d/]/g, '');
  if (clean.length < prev.length) return clean; // กำลังลบ: ไม่จัดรูปแบบ ให้ลบได้ตามปกติ
  const parts = clean.split('/');
  if (parts.length === 1) {
    const dg = clean.slice(0, 8);
    if (dg.length > 4) return `${dg.slice(0, 2)}/${dg.slice(2, 4)}/${dg.slice(4)}`;
    if (dg.length > 2) return `${dg.slice(0, 2)}/${dg.slice(2)}`;
    return dg;
  }
  let [d, m = '', y = ''] = parts;
  if (parts.length === 2 && m.length > 2) { y = m.slice(2); m = m.slice(0, 2); }
  if (parts.length === 2 && !y) return `${d}/${m}`;
  return `${d}/${m}/${y.replace(/\//g, '').slice(0, 4)}`;
}

/**
 * ช่องวันที่รูปแบบ วว/ดด/ปปปป (พ.ศ.) ไม่ขึ้นกับภาษาของเบราว์เซอร์
 * พิมพ์เอง หรือกดปุ่มปฏิทิน value / onChange เป็น ISO (YYYY-MM-DD) เหมือน <input type="date">
 */
export default function ThaiDateInput({ id, value, onChange, className = '', ariaLabel }) {
  const [text, setText] = useState(isoToThai(value));
  const [invalid, setInvalid] = useState(false);
  const pickerRef = useRef(null);

  useEffect(() => { setText(isoToThai(value)); setInvalid(false); }, [value]);

  const handleText = (e) => {
    const next = mask(e.target.value, text);
    setText(next);
    const iso = thaiToIso(next);
    if (iso) { setInvalid(false); if (iso !== value) onChange(iso); }
  };
  const handleBlur = () => {
    if (!text.trim()) { setText(isoToThai(value)); return; }
    const iso = thaiToIso(text);
    if (!iso) { setInvalid(true); setTimeout(() => { setText(isoToThai(value)); setInvalid(false); }, 1500); }
    else setText(isoToThai(iso));
  };
  const openPicker = () => {
    const el = pickerRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') { try { el.showPicker(); return; } catch { /* บางเบราว์เซอร์ไม่รองรับ */ } }
    el.focus(); el.click();
  };

  return (
    <div className={`input-group thai-date ${className}`}>
      <input id={id} type="text" inputMode="numeric" className={`form-control ${invalid ? 'is-invalid' : ''}`}
        placeholder="วว/ดด/ปปปป" value={text} onChange={handleText} onBlur={handleBlur}
        aria-label={ariaLabel} title={invalid ? 'วันที่ไม่ถูกต้อง ใช้รูปแบบ วว/ดด/ปปปป เช่น 01/09/2569' : 'วว/ดด/ปปปป (พ.ศ.)'} />
      <button type="button" className="btn btn-outline-secondary" onClick={openPicker} title="เลือกจากปฏิทิน" tabIndex={-1}>
        <i className="bi bi-calendar3" aria-hidden="true" /><span className="visually-hidden">เลือกจากปฏิทิน</span>
      </button>
      <input ref={pickerRef} type="date" className="thai-date-native" value={value || ''} tabIndex={-1} aria-hidden="true"
        onChange={(e) => e.target.value && onChange(e.target.value)} />
    </div>
  );
}
