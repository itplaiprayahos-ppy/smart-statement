import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { money } from '../utils/format.js';

const SOURCE_LABEL = { nondrug: 'ค่าบริการ', drug: 'ยา' };
const blankFund = () => ({ originalCode: null, code: '', name: '', columnsText: '', sort_order: 0, is_active: true, items: [] });

export default function FundSettingsPage() {
  const [funds, setFunds] = useState([]);
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('nondrug');
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const loadList = useCallback(() => api.get('/funds').then((r) => setFunds(r.data)).catch(showError), []);
  useEffect(() => { loadList(); }, [loadList]);

  const confirmDiscard = async () => !dirty || confirmAction({
    title: 'ยังไม่ได้บันทึกการแก้ไข', text: 'ต้องการทิ้งการแก้ไขนี้หรือไม่', confirmText: 'ทิ้งการแก้ไข', danger: true,
  });

  const open = async (code) => {
    if (!(await confirmDiscard())) return;
    setResults(null);
    if (!code) { setForm(blankFund()); setDirty(false); return; }
    try {
      const { data } = await api.get(`/funds/${code}`);
      setForm({
        originalCode: data.code, code: data.code, name: data.name, sort_order: data.sort_order,
        is_active: data.is_active, columnsText: (data.stm_columns || []).join('\n'), items: data.items,
      });
      setDirty(false);
    } catch (err) {
      showError(err);
    }
  };

  const update = (patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };

  const search = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return showError('พิมพ์คำค้นหาอย่างน้อย 2 ตัวอักษร');
    setSearching(true);
    try {
      const { data } = await api.get('/funds/items/search', { params: { source, q: q.trim() } });
      setResults(data);
    } catch (err) {
      showError(err, 'ค้นหาไม่สำเร็จ');
    } finally {
      setSearching(false);
    }
  };

  const addItem = (it) => update({ items: [...form.items, { icode: it.icode, item_name: it.name, source: it.source }] });
  const removeItem = (icode) => update({ items: form.items.filter((x) => x.icode !== icode) });

  const save = async () => {
    const body = {
      code: form.code, name: form.name, sort_order: Number(form.sort_order) || 0, is_active: form.is_active,
      stm_columns: form.columnsText.split('\n').map((s) => s.trim()).filter(Boolean),
      items: form.items,
    };
    setBusy(true);
    try {
      const { data } = form.originalCode
        ? await api.put(`/funds/${form.originalCode}`, body)
        : await api.post('/funds', body);
      notifySuccess('บันทึกกองทุนแล้ว');
      setDirty(false);
      await loadList();
      setForm((f) => ({ ...f, originalCode: data.code, code: data.code }));
    } catch (err) {
      showError(err, 'บันทึกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: `ลบกองทุน ${form.code}?`, text: 'รายการที่ตั้งค่าไว้ในกองทุนนี้จะถูกลบด้วย', confirmText: 'ลบกองทุน', danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/funds/${form.originalCode}`);
      notifySuccess('ลบกองทุนแล้ว');
      setForm(null);
      setDirty(false);
      loadList();
    } catch (err) {
      showError(err);
    }
  };

  const added = new Set(form?.items.map((x) => x.icode));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ตั้งค่ากองทุน</h1>
          <p>กำหนดรายการค่าบริการหรือยาของแต่ละกองทุน visit ที่มีรายการเหล่านี้อย่างน้อย 1 รายการจะถูกนับเข้ากองทุนนั้น</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => open(null)}>
          <i className="bi bi-plus-lg me-1" />เพิ่มกองทุน
        </button>
      </div>

      <div className="row g-3">
        <div className="col-lg-4">
          <div className="list-group fund-list">
            {funds.map((f) => (
              <button key={f.code} type="button"
                className={`list-group-item list-group-item-action ${form?.originalCode === f.code ? 'active' : ''}`}
                onClick={() => open(f.code)}>
                <div className="d-flex justify-content-between">
                  <strong>{f.code}</strong>
                  <span className={f.item_count ? 'small muted' : 'small text-warning-emphasis'}>
                    {f.item_count ? `${f.item_count} รายการ` : 'ยังไม่มีรายการ'}
                  </span>
                </div>
                <div className="small">{f.name}{!f.is_active && <span className="muted"> (ปิดใช้งาน)</span>}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="col-lg-8">
          {!form ? (
            <div className="panel muted">เลือกกองทุนทางซ้ายเพื่อแก้ไข หรือกด “เพิ่มกองทุน”</div>
          ) : (
            <>
              <div className="panel">
                <div className="row g-3">
                  <div className="col-md-3">
                    <label className="form-label" htmlFor="fs-code">รหัส</label>
                    <input id="fs-code" className="form-control" value={form.code} onChange={(e) => update({ code: e.target.value.toUpperCase() })} />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label" htmlFor="fs-name">ชื่อกองทุน</label>
                    <input id="fs-name" className="form-control" value={form.name} onChange={(e) => update({ name: e.target.value })} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label" htmlFor="fs-sort">ลำดับแสดงผล</label>
                    <input id="fs-sort" type="number" className="form-control" value={form.sort_order} onChange={(e) => update({ sort_order: e.target.value })} />
                  </div>
                  <div className="col-12">
                    <label className="form-label" htmlFor="fs-cols">คอลัมน์ยอดที่ได้รับในไฟล์ REP</label>
                    <textarea id="fs-cols" className="form-control" rows={2} value={form.columnsText}
                      onChange={(e) => update({ columnsText: e.target.value })} placeholder="เช่น HC / HC" />
                    <div className="form-text">
                      บรรทัดละ 1 คอลัมน์ ถ้าหลายคอลัมน์ระบบจะรวมยอดให้ หัวตารางหลายชั้นเขียนแบบ “กลุ่ม / คอลัมน์ย่อย”
                      คัดลอกชื่อที่ถูกต้องได้จาก “หัวคอลัมน์ทั้งหมดในไฟล์” ในหน้าตรวจไฟล์ นำเข้าไฟล์ใหม่หลังแก้คอลัมน์
                    </div>
                  </div>
                  <div className="col-12">
                    <div className="form-check">
                      <input id="fs-active" type="checkbox" className="form-check-input" checked={form.is_active} onChange={(e) => update({ is_active: e.target.checked })} />
                      <label className="form-check-label" htmlFor="fs-active">เปิดใช้งานกองทุนนี้</label>
                    </div>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-title">รายการที่เข้าเงื่อนไข ({form.items.length})</div>
                {form.items.length === 0 ? (
                  <p className="muted">ยังไม่มีรายการ ค้นหาจาก HOSxP ด้านล่างแล้วกด “เพิ่ม”</p>
                ) : (
                  <div className="table-wrap mb-3">
                    <table className="table table-sm data-table">
                      <thead><tr><th>icode</th><th>ชื่อรายการ</th><th>ประเภท</th><th /></tr></thead>
                      <tbody>
                        {form.items.map((it) => (
                          <tr key={it.icode}>
                            <td>{it.icode}</td>
                            <td className="wrap">{it.item_name}</td>
                            <td>{SOURCE_LABEL[it.source]}</td>
                            <td className="text-end">
                              <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeItem(it.icode)} title="นำออก">
                                <i className="bi bi-x-lg" /><span className="visually-hidden">นำออก</span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <form className="row g-2 align-items-end" onSubmit={search}>
                  <div className="col-sm-4">
                    <label className="form-label" htmlFor="fs-src">ค้นหาจาก</label>
                    <select id="fs-src" className="form-select" value={source} onChange={(e) => { setSource(e.target.value); setResults(null); }}>
                      <option value="nondrug">ค่าบริการ (nondrugitems)</option>
                      <option value="drug">ยา (drugitems)</option>
                    </select>
                  </div>
                  <div className="col-sm-8">
                    <label className="form-label" htmlFor="fs-q">icode หรือชื่อรายการ</label>
                    <div className="input-group">
                      <input id="fs-q" className="form-control" value={q} onChange={(e) => setQ(e.target.value)} />
                      <button type="submit" className="btn btn-outline-primary" disabled={searching}>
                        {searching ? 'กำลังค้นหา…' : 'ค้นหา'}
                      </button>
                    </div>
                  </div>
                </form>

                {results && (
                  <div className="item-results mt-3">
                    {results.length === 0 ? <p className="muted mb-0">ไม่พบรายการ</p> : (
                      <table className="table table-sm table-hover data-table">
                        <tbody>
                          {results.map((it) => (
                            <tr key={it.icode}>
                              <td>{it.icode}</td>
                              <td className="wrap">{it.name}</td>
                              <td className="num">{it.price !== null && it.price !== undefined ? money(it.price) : ''}</td>
                              <td className="text-end">
                                <button type="button" className="btn btn-sm btn-outline-primary" disabled={added.has(it.icode)} onClick={() => addItem(it)}>
                                  {added.has(it.icode) ? 'เพิ่มแล้ว' : 'เพิ่ม'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>

              <div className="d-flex justify-content-between align-items-center">
                <span className="small muted">หลังเพิ่มรายการใหม่ ต้องดึงข้อมูล HOSxP ใหม่จึงจะเห็น visit ของรายการนั้น</span>
                <div className="d-flex gap-2">
                  {form.originalCode && <button type="button" className="btn btn-outline-danger" onClick={remove}>ลบกองทุน</button>}
                  <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>บันทึก</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
