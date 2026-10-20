import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { money, thaiDateTime } from '../utils/format.js';

const blank = { originalCode: null, code: '', name: '', dep_codes: [], sort_order: 0, is_active: true };

/**
 * ค่าบริการที่ติดอัตโนมัติ เช่น ค่าบริการผู้ป่วยนอก 50 บาท
 * ทะเบียนของห้อง/แผนกจะรวมหรือไม่รวมรายการเหล่านี้ก็ได้ ระบบเทียบทั้ง 2 แบบ ตรงแบบใดแบบหนึ่งถือว่าตรง
 */
function OptionalFees() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.get('/points/optional-fees').then((r) => setItems(r.data.items)).catch(() => {}); }, []);
  const save = async (next) => {
    try {
      const { data } = await api.put('/points/optional-fees', { items: next });
      setItems(data.items); setSaved(true); notifySuccess('บันทึกแล้ว');
    } catch (err) { showError(err); }
  };
  const find = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    try {
      const { data } = await api.get('/funds/items/search', { params: { source: 'nondrug', q: q.trim() } });
      setResults(data.items.slice(0, 30));
    } catch (err) { showError(err, 'ค้นหาใน HOSxP ไม่สำเร็จ'); }
  };
  return (
    <div className="panel">
      <div className="panel-title mb-1">ค่าบริการที่ติดอัตโนมัติ (ทะเบียนจะรวมหรือไม่รวมก็ได้)</div>
      <p className="small muted mb-2">
        เช่น ค่าบริการผู้ป่วยนอก ที่ HOSxP คิดทุกครั้งที่มารับบริการ ระบบเทียบยอดทะเบียนกับ HOSxP ทั้งแบบรวมและไม่รวมรายการเหล่านี้
        ตรงแบบใดแบบหนึ่งถือว่าตรง ใช้กับทุกห้อง/แผนก
      </p>
      <div className="d-flex flex-wrap gap-2 mb-2">
        {items.length === 0 && <span className="small muted">ยังไม่ได้เลือกรายการ</span>}
        {items.map((it) => (
          <span key={it.icode} className="reg-tag ok">
            {it.icode} {it.name}{it.price != null && <span className="amt">{money(it.price)}</span>}
            <button type="button" className="btn btn-link btn-sm p-0 ms-1 text-danger" aria-label={`เอา ${it.name} ออก`}
              onClick={() => save(items.filter((x) => x.icode !== it.icode))}><i className="bi bi-x-lg" /></button>
          </span>
        ))}
      </div>
      <form className="input-group input-group-sm" style={{ maxWidth: 420 }} onSubmit={find}>
        <input className="form-control" placeholder="ค้นหารายการใน HOSxP เช่น ค่าบริการผู้ป่วยนอก" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหารายการค่าบริการ" />
        <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
      </form>
      {results && (
        <div className="list-group list-group-flush small mt-1" style={{ maxWidth: 520 }}>
          {results.length === 0 && <div className="list-group-item muted">ไม่พบรายการ</div>}
          {results.map((it) => (
            <button key={it.icode} type="button" className="list-group-item list-group-item-action py-1"
              disabled={items.some((x) => x.icode === it.icode)}
              onClick={() => { save([...items, { icode: it.icode, name: it.name, price: it.price }]); setResults(null); setQ(''); }}>
              {it.icode} {it.name} {it.price != null && <span className="muted">({money(it.price)})</span>}
            </button>
          ))}
        </div>
      )}
      {saved && <div className="small text-warning-emphasis mt-2"><i className="bi bi-arrow-repeat me-1" />ดึงข้อมูล HOSxP ใหม่ (แถบด้านบน หรือหน้าเทียบ 3 แหล่ง) เพื่อให้ระบบแยกยอดรายการเหล่านี้</div>}
    </div>
  );
}

/** ตั้งค่าห้อง/แผนก: ชื่อห้อง/แผนก + dep_code ของ HOSxP ที่ใช้รวมยอดค่าใช้จ่ายของจุดนั้น */
export default function ServicePointsPage() {
  const [points, setPoints] = useState([]);
  const [depts, setDepts] = useState([]);
  const [form, setForm] = useState(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { api.get('/points').then((r) => setPoints(r.data)).catch(showError); }, []);
  useEffect(() => {
    load();
    api.get('/points/departments').then((r) => setDepts(r.data)).catch((err) => showError(err, 'โหลดรายชื่อแผนกจาก HOSxP ไม่สำเร็จ'));
  }, [load]);

  const ownerOf = useMemo(() => {
    const m = new Map();
    points.forEach((p) => (p.dep_codes || []).forEach((d) => m.set(String(d), p)));
    return m;
  }, [points]);
  const deptName = (code) => depts.find((d) => String(d.code) === String(code))?.name;

  const open = (p) => setForm(p ? { ...blank, ...p, originalCode: p.code, dep_codes: (p.dep_codes || []).map(String) } : { ...blank });
  const toggleDep = (code) => setForm((f) => ({
    ...f, dep_codes: f.dep_codes.includes(code) ? f.dep_codes.filter((d) => d !== code) : [...f.dep_codes, code],
  }));

  const save = async () => {
    setBusy(true);
    try {
      const body = { code: form.code, name: form.name, dep_codes: form.dep_codes, sort_order: form.sort_order, is_active: form.is_active };
      if (form.originalCode) await api.put(`/points/${form.originalCode}`, body);
      else await api.post('/points', body);
      notifySuccess('บันทึกแล้ว');
      setForm(null);
      load();
    } catch (err) { showError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmAction({ title: `ลบห้อง/แผนก ${form.name}?`, text: 'ทะเบียนที่อัปโหลดของห้องนี้จะถูกลบด้วย', confirmText: 'ลบ', danger: true }))) return;
    try { await api.delete(`/points/${form.originalCode}`); notifySuccess('ลบแล้ว'); setForm(null); load(); } catch (err) { showError(err); }
  };

  const q = filter.trim().toLowerCase();
  const shown = depts.filter((d) => !q || String(d.code).toLowerCase().includes(q) || (d.name || '').toLowerCase().includes(q));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>จัดการห้อง/แผนก</h1>
          <p>ไม่ต้องตั้งค่าก่อนใช้งาน: ระบบสร้างให้เองตอนอัปโหลดทะเบียน (ผู้ใช้เลือกห้อง/แผนกในหน้าต่างอัปโหลด) หน้านี้ใช้เปลี่ยนชื่อ รวมหรือแยกแผนก และกำหนดผู้รับผิดชอบเท่านั้น</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open(null)}><i className="bi bi-plus-lg me-1" />เพิ่มห้อง/แผนก</button>
      </div>

      <OptionalFees />

      <div className="row g-3">
        <div className="col-lg-4">
          <div className="list-group fund-list">
            {points.length === 0 && <div className="list-group-item muted">ยังไม่มีห้อง/แผนก</div>}
            {points.map((p) => (
              <button key={p.code} type="button" className={`list-group-item list-group-item-action text-start ${form?.originalCode === p.code ? 'active' : ''}`} onClick={() => open(p)}>
                <div className="d-flex justify-content-between">
                  <strong>{p.name}</strong>
                  {!p.is_active && <span className="small muted">ปิดใช้งาน</span>}
                </div>
                <div className="small-id">
                  {p.dep_codes?.length ? p.dep_codes.map((d) => `${d}${deptName(d) ? ` ${deptName(d)}` : ''}`).join(', ') : <span className="text-warning-emphasis">ยังไม่ได้เลือกแผนก</span>}
                </div>
                <div className="small-id">
                  {p.responsible ? `ผู้รับผิดชอบ: ${p.responsible}` : 'ยังไม่กำหนดผู้รับผิดชอบ'}
                  {p.last_upload && ` · อัปโหลดล่าสุด ${thaiDateTime(p.last_upload)}`}
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="col-lg-8">
          {!form ? <div className="panel muted">เลือกห้อง/แผนกทางซ้าย หรือกด “เพิ่มห้อง/แผนก”</div> : (
            <div className="panel">
              <div className="row g-3 mb-3">
                <div className="col-sm-3">
                  <label className="form-label" htmlFor="sp-code">รหัส</label>
                  <input id="sp-code" className="form-control" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="เช่น DENT" />
                </div>
                <div className="col-sm-6">
                  <label className="form-label" htmlFor="sp-name">ชื่อห้อง/แผนก</label>
                  <input id="sp-name" className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="เช่น ทันตกรรม" />
                </div>
                <div className="col-sm-3">
                  <label className="form-label" htmlFor="sp-sort">ลำดับ</label>
                  <input id="sp-sort" type="number" className="form-control" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} />
                </div>
              </div>

              <div className="panel-title mb-1">แผนกใน HOSxP ที่นับเป็นห้อง/แผนกนี้ ({form.dep_codes.length})</div>
              <p className="small muted mb-2">ยอด HOSxP ของห้องนี้ = ผลรวมค่าใช้จ่ายใน visit ที่บันทึกจากแผนกที่เลือก เลือกได้หลายแผนก</p>
              <input className="form-control form-control-sm mb-2" placeholder="ค้นหารหัสหรือชื่อแผนก" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="ค้นหาแผนก" />
              <div className="scroll-box mb-3">
                <table className="table table-sm table-hover data-table">
                  <thead><tr><th /><th>dep_code</th><th>ชื่อแผนก</th><th>ใช้กับห้อง/แผนก</th></tr></thead>
                  <tbody>
                    {shown.map((d) => {
                      const code = String(d.code);
                      const other = ownerOf.get(code);
                      const usedElsewhere = other && other.code !== form.originalCode;
                      return (
                        <tr key={code} onClick={() => toggleDep(code)} style={{ cursor: 'pointer' }}>
                          <td style={{ width: 36 }}><input type="checkbox" className="form-check-input" readOnly checked={form.dep_codes.includes(code)} aria-label={`เลือก ${code}`} /></td>
                          <td>{code}</td>
                          <td>{d.name || <span className="muted">–</span>}</td>
                          <td className={usedElsewhere ? 'text-warning-emphasis small' : 'small muted'}>{usedElsewhere ? other.name : ''}</td>
                        </tr>
                      );
                    })}
                    {shown.length === 0 && <tr><td colSpan={4} className="muted text-center py-3">ไม่พบแผนก</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="form-check mb-3">
                <input id="sp-active" type="checkbox" className="form-check-input" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                <label className="form-check-label" htmlFor="sp-active">เปิดใช้งาน</label>
              </div>
              <div className="d-flex justify-content-end gap-2 sticky-actions">
                {form.originalCode && <button type="button" className="btn btn-outline-danger me-auto" onClick={remove}>ลบห้อง/แผนก</button>}
                <button type="button" className="btn btn-light" onClick={() => setForm(null)}>ยกเลิก</button>
                <button type="button" className="btn btn-primary" disabled={busy || !form.code || !form.name} onClick={save}>บันทึก</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
