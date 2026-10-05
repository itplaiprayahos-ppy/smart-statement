import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { money } from '../utils/format.js';

const SOURCE_LABEL = { nondrug: 'ค่าบริการ', drug: 'ยา' };
const blankFund = () => ({
  originalCode: null, code: '', name: '', columnsText: '', sort_order: 0, is_active: true, items: [], pttypes: [],
});

/** เลือกสิทธิการรักษาของ HOSxP ที่เข้าเงื่อนไขกองทุน (ไม่เลือก = ทุกสิทธิ) */
function PttypePicker({ list, error, value, onChange }) {
  const [filter, setFilter] = useState('');
  const selected = new Set(value);
  const known = new Set(list.map((p) => p.pttype));
  const shown = list.filter((p) => {
    const q = filter.trim().toLowerCase();
    return !q || p.pttype.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)
      || (p.hipdata_code || '').toLowerCase() === q;
  });
  const toggle = (code) => onChange(selected.has(code) ? value.filter((c) => c !== code) : [...value, code]);

  return (
    <div className="panel">
      <div className="panel-title mb-1">สิทธิการรักษาที่เข้าเงื่อนไข ({value.length ? `${value.length} สิทธิ` : 'ทุกสิทธิ'})</div>
      <p className="small muted">visit ต้องมีสิทธิตามที่เลือกจึงจะนับเข้ากองทุนนี้ ถ้าไม่เลือกเลยจะนับทุกสิทธิ แสดงเฉพาะสิทธิที่ใช้งานอยู่ใน HOSxP</p>
      {error && <div className="alert alert-warning py-2 small">{error}</div>}
      {value.filter((c) => !known.has(c)).length > 0 && list.length > 0 && (
        <div className="small text-warning-emphasis mb-2">
          สิทธิที่เลือกไว้แต่ไม่พบหรือเลิกใช้แล้วใน HOSxP: {value.filter((c) => !known.has(c)).join(', ')}{' '}
          <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={() => onChange(value.filter((c) => known.has(c)))}>นำออก</button>
        </div>
      )}
      <div className="d-flex gap-2 mb-2">
        <input className="form-control form-control-sm" placeholder="ค้นหารหัส ชื่อสิทธิ หรือกลุ่ม เช่น UCS" value={filter}
          onChange={(e) => setFilter(e.target.value)} aria-label="ค้นหาสิทธิ" />
        <button type="button" className="btn btn-sm btn-outline-primary text-nowrap"
          onClick={() => onChange([...new Set([...value, ...shown.map((p) => p.pttype)])])} disabled={!shown.length}>
          เลือกที่แสดงทั้งหมด
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary text-nowrap" onClick={() => onChange([])} disabled={!value.length}>
          ล้าง
        </button>
      </div>
      <div className="scroll-box">
        <table className="table table-sm table-hover data-table">
          <thead><tr><th /><th>รหัส</th><th>ชื่อสิทธิ</th><th>กลุ่ม</th></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.pttype} onClick={() => toggle(p.pttype)} style={{ cursor: 'pointer' }}>
                <td style={{ width: 36 }}>
                  <input type="checkbox" className="form-check-input" checked={selected.has(p.pttype)} readOnly
                    aria-label={`เลือกสิทธิ ${p.pttype} ${p.name}`} />
                </td>
                <td style={{ width: 60 }}>{p.pttype}</td>
                <td className="wrap">{p.name}</td>
                <td className="small-id">{p.hipdata_code}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={4} className="muted text-center py-3">ไม่พบสิทธิ</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FundSettingsPage() {
  const [funds, setFunds] = useState([]);
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('nondrug');
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [pttypeList, setPttypeList] = useState([]);
  const [pttypeError, setPttypeError] = useState('');

  const loadList = useCallback(() => api.get('/funds').then((r) => setFunds(r.data)).catch(showError), []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    api.get('/funds/pttypes')
      .then((r) => setPttypeList(r.data))
      .catch((err) => setPttypeError(err?.response?.data?.message || 'อ่านรายการสิทธิจาก HOSxP ไม่สำเร็จ'));
  }, []);

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
        pttypes: data.pttypes || [],
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
      setResults(data); // { items, limited }
    } catch (err) {
      showError(err, 'ค้นหาไม่สำเร็จ');
    } finally {
      setSearching(false);
    }
  };

  const addItem = (it) => update({ items: [...form.items, { icode: it.icode, item_name: it.name, source: it.source, required: false }] });
  const addAll = () => {
    const have = new Set(form.items.map((x) => x.icode));
    const fresh = results.items.filter((it) => !have.has(it.icode))
      .map((it) => ({ icode: it.icode, item_name: it.name, source: it.source, required: false }));
    update({ items: [...form.items, ...fresh] });
  };
  const removeItem = (icode) => update({ items: form.items.filter((x) => x.icode !== icode) });
  const toggleRequired = (icode) => update({
    items: form.items.map((x) => (x.icode === icode ? { ...x, required: !x.required } : x)),
  });

  const save = async () => {
    const body = {
      code: form.code, name: form.name, sort_order: Number(form.sort_order) || 0, is_active: form.is_active,
      stm_columns: form.columnsText.split('\n').map((s) => s.trim()).filter(Boolean),
      items: form.items,
      pttypes: form.pttypes,
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
          <p>visit จะนับเข้ากองทุนเมื่อมีรายการค่าบริการหรือยาที่ตั้งไว้อย่างน้อย 1 รายการ และสิทธิการรักษาตรงตามที่เลือก</p>
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
                <div className="small-id">{f.pttypes?.length ? `สิทธิ ${f.pttypes.join(', ')}` : 'ทุกสิทธิ'}</div>
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
                      onChange={(e) => update({ columnsText: e.target.value })} placeholder="เช่น HC" />
                    <div className="form-text">
                      ใส่ชื่อกองทุนตามหัวตารางแถวที่ 13 ของไฟล์ REP เช่น HC, AE, INST, DMIS, PP บรรทัดละ 1 ชื่อ
                      ระบบรวมทุกคอลัมน์ย่อยใต้ชื่อนั้นให้ (HC = HC + DRUG) ยกเว้นกลุ่มที่มี “ยอดชดเชยที่จ่ายจริง” จะใช้เฉพาะคอลัมน์นั้น
                      ถ้าต้องการคอลัมน์เดียว ใส่ชื่อเต็มแบบ “กลุ่ม / คอลัมน์ย่อย” นำเข้าไฟล์ใหม่ทุกครั้งหลังแก้
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

              <PttypePicker list={pttypeList} error={pttypeError} value={form.pttypes} onChange={(pttypes) => update({ pttypes })} />

              <div className="panel">
                <div className="panel-title mb-1">
                  รายการที่เข้าเงื่อนไข ({form.items.length})
                  {form.items.some((x) => x.required) && (
                    <span className="small muted fw-normal"> รายการจำเป็น {form.items.filter((x) => x.required).length}</span>
                  )}
                </div>
                <p className="small muted">
                  visit ที่มีรายการใดรายการหนึ่งจะเข้าเกณฑ์กองทุน ติ๊ก “จำเป็น” ที่รายการที่ต้องเบิกคู่กันเสมอ
                  ระบบจะแจ้งว่า visit ที่เคลมไม่สำเร็จขาดรายการจำเป็นตัวไหน
                </p>
                <div className="scroll-box mb-3">
                  {form.items.length === 0 ? (
                    <div className="empty">ยังไม่มีรายการ ค้นหาจาก HOSxP ด้านล่างแล้วกด “เพิ่ม”</div>
                  ) : (
                    <table className="table table-sm data-table">
                      <thead><tr><th>icode</th><th>ชื่อรายการ</th><th>ประเภท</th><th className="text-center">จำเป็น</th><th /></tr></thead>
                      <tbody>
                        {form.items.map((it) => (
                          <tr key={it.icode}>
                            <td>{it.icode}</td>
                            <td className="wrap">{it.item_name}</td>
                            <td>{SOURCE_LABEL[it.source]}</td>
                            <td className="text-center">
                              <input type="checkbox" className="form-check-input" checked={!!it.required}
                                onChange={() => toggleRequired(it.icode)} aria-label={`รายการจำเป็น ${it.item_name}`} />
                            </td>
                            <td className="text-end">
                              <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeItem(it.icode)} title="นำออก">
                                <i className="bi bi-x-lg" /><span className="visually-hidden">นำออก</span>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

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

                <div className="d-flex justify-content-between align-items-center mt-3 mb-2">
                  <span className="small muted">
                    {results
                      ? `พบ ${results.items.length.toLocaleString('th-TH')} รายการ${results.limited ? ' (แสดงสูงสุด 2,000 รายการ ระบุคำค้นให้แคบลง)' : ''}`
                      : 'ผลการค้นหาจะแสดงที่นี่'}
                  </span>
                  {results?.items.length > 0 && (
                    <button type="button" className="btn btn-sm btn-outline-primary" onClick={addAll}
                      disabled={results.items.every((it) => added.has(it.icode))}>
                      เพิ่มทั้งหมดที่พบ
                    </button>
                  )}
                </div>
                <div className="scroll-box">
                  {!results || results.items.length === 0 ? (
                    <div className="empty">{results ? 'ไม่พบรายการ' : 'พิมพ์ icode หรือชื่อรายการ แล้วกดค้นหา'}</div>
                  ) : (
                    <table className="table table-sm table-hover data-table">
                      <thead><tr><th>icode</th><th>ชื่อรายการ</th><th className="num">ราคา</th><th /></tr></thead>
                      <tbody>
                        {results.items.map((it) => (
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
