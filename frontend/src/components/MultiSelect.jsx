import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * dropdown เลือกได้หลายรายการ (ติ๊กถูก)
 * options: [{ value, label, hint? }] · value: array ของค่าที่เลือก · ว่าง = ทั้งหมด
 */
export default function MultiSelect({ id, options, value, onChange, allLabel = 'ทั้งหมด', unit = 'รายการ' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  const selected = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const shown = q.trim()
    ? options.filter((o) => `${o.label} ${o.value} ${o.hint || ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    : options;
  const picked = options.filter((o) => selected.has(o.value));
  const summary = picked.length === 0 ? allLabel
    : picked.length === 1 ? picked[0].label
      : `${picked.length} ${unit}`;

  const toggle = (v) => onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div className="msel" ref={box}>
      <button id={id} type="button" className={`form-select msel-btn ${picked.length ? 'has-value' : ''}`}
        aria-haspopup="listbox" aria-expanded={open} title={picked.map((o) => o.label).join(', ') || allLabel}
        onClick={() => setOpen((o) => !o)}>
        <span className="msel-text">{summary}</span>
      </button>
      {open && (
        <div className="msel-menu" role="listbox" aria-multiselectable="true">
          {options.length > 6 && (
            <input className="form-control form-control-sm mb-1" placeholder="ค้นหา" value={q} autoFocus
              onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="msel-actions">
            <button type="button" className="btn btn-link btn-sm p-0" onClick={() => onChange([])} disabled={!picked.length}>
              ล้าง ({allLabel})
            </button>
            {shown.length > 1 && (
              <button type="button" className="btn btn-link btn-sm p-0"
                onClick={() => onChange([...new Set([...value, ...shown.map((o) => o.value)])])}>เลือกทั้งหมดที่เห็น</button>
            )}
          </div>
          <div className="msel-list">
            {shown.map((o) => (
              <label key={o.value} className="msel-opt" role="option" aria-selected={selected.has(o.value)}>
                <input type="checkbox" className="form-check-input" checked={selected.has(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}{o.hint && <small className="muted ms-1">{o.hint}</small>}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="muted small px-2 py-1">ไม่พบ</div>}
          </div>
        </div>
      )}
    </div>
  );
}
