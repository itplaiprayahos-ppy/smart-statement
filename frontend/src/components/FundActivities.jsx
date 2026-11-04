import { useState } from 'react';
import api from '../api/client.js';
import { showError } from '../utils/alert.js';
import { money } from '../utils/format.js';

/**
 * กิจกรรมย่อยของกองทุน (เช่น PP: ทดสอบการตั้งครรภ์ / ฝากครรภ์ / อัลตร้าซาวน์)
 * แต่ละกิจกรรม = รายการค่าบริการ/ยา (มีรายการใดก็ได้ หรือต้องครบทุกรายการ) + รหัสโรค ICD-10 ของตัวเอง
 * value: [{ name, items: [{icode, item_name, source}], items_mode, icd10Text, icd10_scope, is_active }]
 */
export const blankActivity = () => ({ name: '', items: [], items_mode: 'any', icd10Text: '', icd10_scope: 'any', is_active: true });

function ItemSearch({ onAdd, have }) {
  const [source, setSource] = useState('nondrug');
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const find = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return showError('พิมพ์คำค้นหาอย่างน้อย 2 ตัวอักษร');
    setBusy(true);
    try {
      const { data } = await api.get('/funds/items/search', { params: { source, q: q.trim() } });
      setResults(data.items.slice(0, 50));
    } catch (err) { showError(err, 'ค้นหาไม่สำเร็จ'); } finally { setBusy(false); }
  };
  return (
    <div>
      <form className="d-flex flex-wrap gap-2" onSubmit={find}>
        <select className="form-select form-select-sm" style={{ width: 'auto' }} value={source}
          onChange={(e) => { setSource(e.target.value); setResults(null); }} aria-label="ประเภทรายการ">
          <option value="nondrug">ค่าบริการ</option>
          <option value="drug">ยา</option>
        </select>
        <div className="input-group input-group-sm flex-grow-1" style={{ minWidth: 200 }}>
          <input className="form-control" placeholder="icode หรือชื่อรายการ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหารายการของกิจกรรม" />
          <button type="submit" className="btn btn-outline-primary" disabled={busy}>{busy ? 'กำลังค้นหา…' : 'ค้นหา'}</button>
        </div>
      </form>
      {results && (
        <div className="list-group list-group-flush small mt-1 act-results">
          {results.length === 0 && <div className="list-group-item muted">ไม่พบรายการ</div>}
          {results.map((it) => (
            <button key={it.icode} type="button" className="list-group-item list-group-item-action py-1" disabled={have.has(it.icode)}
              onClick={() => onAdd({ icode: it.icode, item_name: it.name, source })}>
              {it.icode} {it.name} {it.price != null && <span className="muted">({money(it.price)})</span>}
              {have.has(it.icode) && <span className="muted"> · เพิ่มแล้ว</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Activity({ a, idx, total, parseIcd, onChange, onRemove, onMove }) {
  const set = (patch) => onChange({ ...a, ...patch });
  const codes = parseIcd(a.icd10Text);
  const have = new Set(a.items.map((x) => x.icode));
  return (
    <div className={`act-card ${a.is_active ? '' : 'off'}`}>
      <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
        <span className="act-no">{idx + 1}</span>
        <input className="form-control form-control-sm flex-grow-1" style={{ minWidth: 200 }} value={a.name}
          placeholder="ชื่อกิจกรรม เช่น ทดสอบการตั้งครรภ์" onChange={(e) => set({ name: e.target.value })} aria-label={`ชื่อกิจกรรมที่ ${idx + 1}`} />
        <div className="form-check form-switch mb-0">
          <input id={`act-on-${idx}`} type="checkbox" className="form-check-input" checked={a.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
          <label className="form-check-label small" htmlFor={`act-on-${idx}`}>ใช้งาน</label>
        </div>
        <div className="btn-group btn-group-sm">
          <button type="button" className="btn btn-outline-secondary" disabled={idx === 0} onClick={() => onMove(-1)} title="เลื่อนขึ้น"><i className="bi bi-arrow-up" /></button>
          <button type="button" className="btn btn-outline-secondary" disabled={idx === total - 1} onClick={() => onMove(1)} title="เลื่อนลง"><i className="bi bi-arrow-down" /></button>
          <button type="button" className="btn btn-outline-danger" onClick={onRemove} title="ลบกิจกรรม"><i className="bi bi-trash" /></button>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-7">
          <div className="small fw-semibold mb-1">1. รายการค่าบริการ/ยา ({a.items.length})</div>
          <div className="d-flex flex-wrap gap-3 small mb-2">
            {[['any', 'มีรายการใดรายการหนึ่ง'], ['all', 'ต้องมีครบทุกรายการ']].map(([v, l]) => (
              <label key={v} className="form-check mb-0">
                <input type="radio" className="form-check-input" name={`act-mode-${idx}`} checked={a.items_mode === v} onChange={() => set({ items_mode: v })} />
                <span className="form-check-label">{l}</span>
              </label>
            ))}
          </div>
          <div className="d-flex flex-wrap gap-1 mb-2">
            {a.items.length === 0 && <span className="small text-warning-emphasis">ยังไม่มีรายการ (ต้องมีอย่างน้อย 1 รายการ)</span>}
            {a.items.map((it) => (
              <span key={it.icode} className="reg-tag ok">
                <span className="muted me-1">{it.source === 'drug' ? 'ยา' : 'ค่าบริการ'}</span>{it.icode} {it.item_name}
                <button type="button" className="btn btn-link btn-sm p-0 ms-1 text-danger" aria-label={`เอา ${it.item_name} ออก`}
                  onClick={() => set({ items: a.items.filter((x) => x.icode !== it.icode) })}><i className="bi bi-x-lg" /></button>
              </span>
            ))}
          </div>
          <ItemSearch have={have} onAdd={(it) => set({ items: [...a.items, it] })} />
        </div>
        <div className="col-lg-5">
          <div className="small fw-semibold mb-1">2. รหัสโรค ICD-10 ({codes.length ? `${codes.length} รายการ` : 'ไม่กรอง'})</div>
          <textarea className="form-control form-control-sm mb-1" rows={2} value={a.icd10Text} placeholder="เช่น Z32.0, Z32.1 หรือช่วง Z34-Z35"
            onChange={(e) => set({ icd10Text: e.target.value })} aria-label={`ICD-10 ของกิจกรรมที่ ${idx + 1}`} />
          {codes.length > 0 && <div className="d-flex flex-wrap gap-1 mb-1">{codes.map((c) => <span key={c} className="reg-tag">{c}</span>)}</div>}
          <div className="d-flex flex-wrap gap-3 small">
            {[['any', 'โรคหลักหรือโรครอง'], ['pdx', 'เฉพาะโรคหลัก (PDX)']].map(([v, l]) => (
              <label key={v} className="form-check mb-0">
                <input type="radio" className="form-check-input" name={`act-scope-${idx}`} checked={a.icd10_scope === v} onChange={() => set({ icd10_scope: v })} />
                <span className="form-check-label">{l}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FundActivities({ value, onChange, parseIcd }) {
  const list = value || [];
  const setAt = (i, a) => onChange(list.map((x, j) => (j === i ? a : x)));
  const move = (i, d) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="panel">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-1">
        <div className="panel-title mb-0">กิจกรรมย่อย ({list.length})</div>
        <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => onChange([...list, blankActivity()])}>
          <i className="bi bi-plus-lg me-1" />เพิ่มกิจกรรม
        </button>
      </div>
      <p className="small muted">
        ใช้เมื่อกองทุนมีหลายกิจกรรมที่เงื่อนไขต่างกัน เช่น PP: ทดสอบการตั้งครรภ์ (Lab UPT + Z32.0/Z32.1), ฝากครรภ์, อัลตร้าซาวน์
        visit เข้าเกณฑ์กองทุนเมื่อผ่านกิจกรรมใดกิจกรรมหนึ่งครบทั้งรายการและรหัสโรคของกิจกรรมนั้น
        {list.some((a) => a.is_active) && <strong> เมื่อมีกิจกรรมที่ใช้งาน ระบบใช้เงื่อนไขของกิจกรรมแทน "รายการที่เข้าเงื่อนไข" ด้านบน</strong>}
        {' '}สิทธิการรักษาและ ICD-10 ระดับกองทุน (ถ้าใส่) ยังใช้กับทุกกิจกรรม ยอดได้รับเงินยังนับที่ระดับกองทุน
      </p>
      {list.length === 0 && <div className="empty">ยังไม่มีกิจกรรมย่อย กองทุนนี้คัดด้วยรายการระดับกองทุนตามเดิม</div>}
      {list.map((a, i) => (
        <Activity key={i} a={a} idx={i} total={list.length} parseIcd={parseIcd}
          onChange={(x) => setAt(i, x)} onRemove={() => onChange(list.filter((_, j) => j !== i))} onMove={(d) => move(i, d)} />
      ))}
    </div>
  );
}
