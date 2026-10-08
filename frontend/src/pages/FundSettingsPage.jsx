import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import SortTh from '../components/SortTh.jsx';
import { useSort } from '../hooks/useSort.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { money } from '../utils/format.js';

const SOURCE_LABEL = { nondrug: 'ค่าบริการ', drug: 'ยา' };
/** [ค่า, ชื่อสั้น, คำอธิบาย, ไอคอน] */
const MATCH_MODES = [
  ['items', 'ค่าบริการ', 'มีรายการค่าบริการ/ยาที่กำหนด', 'bi-receipt'],
  ['rights', 'สิทธิการรักษา', 'ทุก visit ของสิทธิที่เลือก', 'bi-person-vcard'],
  ['icd', 'ICD-10', 'ทุก visit ที่มีรหัสโรคที่กำหนด', 'bi-clipboard2-pulse'],
];

const blankFund = () => ({
  originalCode: null, code: '', name: '', columnsText: '', sort_order: 0, is_active: true, items: [], pttypes: [],
  hipdata_codes: ['UCS'], target_send: 95, target_success: 90, target_complete: 95, track_only: false,
  match_mode: 'items', icd10Text: '', icd10_scope: 'any',
});

/** "H25.1, z515, C00 - C96" -> ["H251", "Z515", "C00-C96"] (รหัสเดี่ยวหรือช่วง) */
const parseIcd = (text) => [...new Set(String(text || '').toUpperCase().replace(/\./g, '')
  .replace(/\s*[-–]\s*/g, '-').split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean))];
const ICD_RE = /^[A-Z][0-9][0-9A-Z]{0,5}$/;
const icdValid = (c) => {
  const parts = c.split('-');
  if (parts.length === 1) return ICD_RE.test(c);
  return parts.length === 2 && ICD_RE.test(parts[0]) && ICD_RE.test(parts[1]) && parts[0] <= parts[1];
};

/**
 * สิทธิการรักษาที่เข้าเงื่อนไขกองทุน: ติ๊กรหัสสิทธิ (pttype) ที่ต้องการ
 * ปุ่มกลุ่มสิทธิ (hipdata_code) ใช้กรองตาราง แล้วกด "เลือกที่แสดงทั้งหมด" เพื่อเลือกทั้งกลุ่ม
 * ไม่เลือกเลย = ทุกสิทธิ (ยกเว้นกลุ่มที่ไม่นับเสมอ)
 */
function PttypePicker({ list, error, value, onChange, excluded, note }) {
  const [filter, setFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState([]);
  const selected = new Set(value);
  const known = new Set(list.map((p) => p.pttype));
  const usable = (p) => !excluded.includes(p.hipdata_code);
  const allGroups = [...new Set(list.map((p) => p.hipdata_code || ''))].filter(Boolean).sort();
  const inGroup = (g) => list.filter((p) => p.hipdata_code === g);

  const q = filter.trim().toLowerCase();
  const rows = list.filter((p) => (!groupFilter.length || groupFilter.includes(p.hipdata_code))
    && (!q || p.pttype.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)));
  const ptSort = useSort(rows, undefined, { picked: (p) => (selected.has(p.pttype) ? 0 : 1), name: (p) => p.name, group: (p) => p.hipdata_code });
  const shownUsable = rows.filter(usable).map((p) => p.pttype);
  const toggle = (code) => onChange(selected.has(code) ? value.filter((c) => c !== code) : [...value, code]);
  const toggleGroup = (g) => setGroupFilter((f) => (f.includes(g) ? f.filter((x) => x !== g) : [...f, g]));

  return (
    <div className="panel">
      <div className="panel-title mb-1">
        สิทธิการรักษาที่เข้าเงื่อนไข ({value.length ? `${value.length} รหัสสิทธิ` : 'ทุกสิทธิ'})
      </div>
      <p className="small muted mb-2">
        ติ๊กรหัสสิทธิที่ต้องการ กดปุ่มกลุ่มสิทธิเพื่อกรองตาราง แล้วกด “เลือกที่แสดงทั้งหมด” เพื่อเลือกทั้งกลุ่ม
        ไม่เลือกเลย = ทุกสิทธิ รหัสสิทธิที่เพิ่มใหม่ใน HOSxP ภายหลังต้องมาติ๊กเพิ่ม
      </p>
      {error && <div className="alert alert-warning py-2 small">{error}</div>}
      {note && <div className="alert alert-info py-2 small">{note}</div>}

      <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
        <span className="small muted">กรองกลุ่มสิทธิ:</span>
        {allGroups.map((g) => {
          const isExcluded = excluded.includes(g);
          const n = inGroup(g).length;
          const picked = inGroup(g).filter((p) => selected.has(p.pttype)).length;
          return (
            <button key={g} type="button" className={`chip ${groupFilter.includes(g) ? 'active' : ''}`}
              onClick={() => toggleGroup(g)} aria-pressed={groupFilter.includes(g)}
              title={isExcluded ? 'กลุ่มนี้ไม่นับเข้ากองทุนเสมอ (EXCLUDED_HIPDATA)' : `เลือกแล้ว ${picked} จาก ${n} รหัส`}>
              {g} <span className="opacity-75">({isExcluded ? n : `${picked}/${n}`})</span>
              {isExcluded && <i className="bi bi-slash-circle ms-1" aria-hidden="true" />}
            </button>
          );
        })}
        {groupFilter.length > 0 && (
          <button type="button" className="btn btn-sm btn-link" onClick={() => setGroupFilter([])}>แสดงทุกกลุ่ม</button>
        )}
      </div>
      {excluded.length > 0 && (
        <p className="small muted mb-2">
          <i className="bi bi-slash-circle me-1" />
          กลุ่ม {excluded.join(', ')} ไม่นับเข้ากองทุนใดเสมอ (เช่น ชำระเงินเอง) ตั้งค่าได้ที่ EXCLUDED_HIPDATA ในไฟล์ .env
        </p>
      )}
      {value.filter((c) => !known.has(c)).length > 0 && list.length > 0 && (
        <div className="small text-warning-emphasis mb-2">
          รหัสที่เลือกไว้แต่ไม่พบหรือเลิกใช้แล้วใน HOSxP: {value.filter((c) => !known.has(c)).join(', ')}{' '}
          <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={() => onChange(value.filter((c) => known.has(c)))}>นำออก</button>
        </div>
      )}

      <div className="d-flex flex-wrap gap-2 mb-2">
        <input className="form-control form-control-sm" style={{ flex: '1 1 200px' }} placeholder="ค้นหารหัสหรือชื่อสิทธิ"
          value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="ค้นหาสิทธิ" />
        <button type="button" className="btn btn-sm btn-outline-primary text-nowrap" disabled={!shownUsable.length}
          onClick={() => onChange([...new Set([...value, ...shownUsable])])}>
          เลือกที่แสดงทั้งหมด ({shownUsable.length})
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary text-nowrap"
          disabled={!rows.some((p) => selected.has(p.pttype))}
          onClick={() => { const shown = new Set(rows.map((p) => p.pttype)); onChange(value.filter((c) => !shown.has(c))); }}>
          ยกเลิกที่แสดง
        </button>
        <button type="button" className="btn btn-sm btn-link text-nowrap" disabled={!value.length} onClick={() => onChange([])}>
          ล้างทั้งหมด
        </button>
      </div>
      <div className="scroll-box">
        <table className="table table-sm table-hover data-table">
          <thead>
            <tr>
              <SortTh k="picked" sort={ptSort.sort} onSort={ptSort.toggle} title="เรียงที่เลือกไว้ขึ้นก่อน">{' '}</SortTh>
              <SortTh k="pttype" sort={ptSort.sort} onSort={ptSort.toggle}>รหัส</SortTh>
              <SortTh k="name" sort={ptSort.sort} onSort={ptSort.toggle}>ชื่อสิทธิ</SortTh>
              <SortTh k="group" sort={ptSort.sort} onSort={ptSort.toggle}>กลุ่ม</SortTh>
            </tr>
          </thead>
          <tbody>
            {ptSort.sorted.map((p) => (
              <tr key={p.pttype} onClick={usable(p) ? () => toggle(p.pttype) : undefined}
                style={usable(p) ? { cursor: 'pointer' } : undefined} className={usable(p) ? '' : 'muted'}>
                <td style={{ width: 36 }}>
                  <input type="checkbox" className="form-check-input" checked={selected.has(p.pttype)} readOnly
                    disabled={!usable(p)} aria-label={`เลือกสิทธิ ${p.pttype} ${p.name}`} />
                </td>
                <td style={{ width: 60 }}>{p.pttype}</td>
                <td className="wrap">{p.name}</td>
                <td className="small-id">{p.hipdata_code}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="muted text-center py-3">ไม่พบสิทธิ</td></tr>}
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
  const itemSort = useSort(form?.items, undefined, { item_name: (it) => it.item_name, required: (it) => (it.required ? 0 : 1) });
  const resultSort = useSort(results?.items, undefined, { price: (it) => (it.price == null ? null : Number(it.price)) });
  const [searching, setSearching] = useState(false);
  const [pttypeList, setPttypeList] = useState([]);
  const [pttypeNote, setPttypeNote] = useState(null);
  const [excludedHipdata, setExcludedHipdata] = useState([]);
  const [pttypeError, setPttypeError] = useState('');

  const loadList = useCallback(() => api.get('/funds').then((r) => setFunds(r.data)).catch(showError), []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    api.get('/funds/pttypes')
      .then((r) => { setPttypeList(r.data.pttypes); setExcludedHipdata(r.data.excludedHipdata || []); })
      .catch((err) => setPttypeError(err?.response?.data?.message || 'อ่านรายการสิทธิจาก HOSxP ไม่สำเร็จ'));
  }, []);

  const confirmDiscard = async () => !dirty || confirmAction({
    title: 'ยังไม่ได้บันทึกการแก้ไข', text: 'ต้องการทิ้งการแก้ไขนี้หรือไม่', confirmText: 'ทิ้งการแก้ไข', danger: true,
  });

  const open = async (code) => {
    if (!(await confirmDiscard())) return;
    setResults(null);
    const codesOf = (groups) => pttypeList
      .filter((p) => groups.includes(p.hipdata_code) && !excludedHipdata.includes(p.hipdata_code)).map((p) => p.pttype);
    if (!code) {
      setForm({ ...blankFund(), pttypes: codesOf(['UCS']), hipdata_codes: [] });
      setPttypeNote(null);
      setDirty(false);
      return;
    }
    try {
      const { data } = await api.get(`/funds/${code}`);
      // กองทุนที่ตั้งไว้แบบกลุ่มสิทธิ (รุ่นก่อน): ติ๊กรหัสสิทธิในกลุ่มนั้นให้ เมื่อบันทึกจะเก็บเป็นรายการรหัส
      const legacyGroups = !(data.pttypes || []).length && (data.hipdata_codes || []).length && !data.track_only
        ? data.hipdata_codes : null;
      setPttypeNote(legacyGroups && pttypeList.length
        ? `กองทุนนี้ตั้งไว้แบบกลุ่มสิทธิ ${legacyGroups.join(', ')} ระบบติ๊กรหัสสิทธิในกลุ่มนั้นให้แล้ว เมื่อกดบันทึกจะเก็บเป็นรายการรหัสสิทธิ`
        : null);
      setForm({
        originalCode: data.code, code: data.code, name: data.name, sort_order: data.sort_order,
        is_active: data.is_active, columnsText: (data.stm_columns || []).join('\n'), items: data.items,
        pttypes: legacyGroups && pttypeList.length ? codesOf(legacyGroups) : (data.pttypes || []),
        hipdata_codes: legacyGroups && !pttypeList.length ? legacyGroups : [],
        track_only: !!data.track_only,
        match_mode: data.match_mode || 'items',
        icd10Text: (data.icd10_codes || []).join(', '),
        icd10_scope: data.icd10_scope || 'any',
        target_send: Number(data.target_send), target_success: Number(data.target_success),
        target_complete: Number(data.target_complete),
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
    if (!form.track_only && form.match_mode === 'icd' && !parseIcd(form.icd10Text).length) {
      return showError('วิธีคัดแบบ ICD-10 ต้องใส่รหัสโรคอย่างน้อย 1 รายการ');
    }
    const body = {
      code: form.code, name: form.name, sort_order: Number(form.sort_order) || 0, is_active: form.is_active,
      stm_columns: form.columnsText.split('\n').map((s) => s.trim()).filter(Boolean),
      items: form.items,
      pttypes: form.pttypes,
      // รายการรหัสสิทธิเป็นตัวกำหนด (ไม่ใช้กลุ่มสิทธิแล้ว) ยกเว้นยังโหลดรายการสิทธิจาก HOSxP ไม่ได้
      hipdata_codes: pttypeList.length ? [] : form.hipdata_codes,
      track_only: form.track_only,
      match_mode: form.match_mode,
      icd10_codes: form.match_mode === 'rights' ? [] : parseIcd(form.icd10Text),
      icd10_scope: form.icd10_scope,
      target_send: form.target_send, target_success: form.target_success, target_complete: form.target_complete,
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
          <p>แต่ละกองทุนเลือกวิธีคัด visit ได้ 3 แบบ: ค่าบริการ, สิทธิการรักษา หรือ ICD-10 และกรองด้วยสิทธิการรักษาที่เลือก</p>
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
                  <span className={f.item_count || f.track_only || f.match_mode !== 'items' ? 'small muted' : 'small text-warning-emphasis'}>
                    {f.track_only ? 'ติดตามยอดรับ' : f.match_mode === 'rights' ? 'คัดตามสิทธิ' : f.match_mode === 'icd' ? 'คัดตาม ICD-10' : f.item_count ? `${f.item_count} รายการ` : 'ยังไม่มีรายการ'}
                  </span>
                </div>
                <div className="small">{f.name}{!f.is_active && <span className="muted"> (ปิดใช้งาน)</span>}</div>
                {!f.track_only && (
                  <div className="small-id">
                    {f.pttypes?.length ? `${f.pttypes.length} รหัสสิทธิ` : f.hipdata_codes?.length ? `กลุ่ม ${f.hipdata_codes.join(', ')}` : 'ทุกสิทธิ'}
                  </div>
                )}
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
                      ใส่ชื่อคอลัมน์ตามหัวตารางของไฟล์ REP (ชีต Detail) บรรทัดละ 1 ชื่อ หลายบรรทัดระบบรวมยอดให้
                      เขียนแบบ “กลุ่ม / คอลัมน์ย่อย” เช่น ค่าใช้จ่ายสูง (HC) / OPHC ถ้าใส่เฉพาะหัวกลุ่ม ระบบรวมทุกคอลัมน์ย่อยใต้กลุ่มนั้น
                      คัดลอกชื่อที่ถูกต้องได้จาก “หัวคอลัมน์ทั้งหมดในไฟล์” ในหน้าตรวจไฟล์ นำเข้าไฟล์ใหม่ทุกครั้งหลังแก้
                    </div>
                  </div>
                  {!form.track_only && (
                  <div className="col-12">
                    <div className="form-label mb-1">เป้าหมายตัวชี้วัด (%) ใช้แสดงสีในแดชบอร์ดภาพรวม</div>
                    <div className="row g-2">
                      {[['target_send', 'อัตราการส่งเบิก'], ['target_success', 'อัตราเคลมสำเร็จ'], ['target_complete', 'ความครบถ้วนของข้อมูล']].map(([k, label]) => (
                        <div className="col-sm-4" key={k}>
                          <div className="input-group input-group-sm">
                            <span className="input-group-text">{label}</span>
                            <input type="number" min="0" max="100" step="0.5" className="form-control" value={form[k]}
                              onChange={(e) => update({ [k]: e.target.value })} aria-label={`เป้าหมาย${label}`} />
                            <span className="input-group-text">%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  )}
                  <div className="col-12">
                    <div className="form-check mb-1">
                      <input id="fs-track" type="checkbox" className="form-check-input" checked={form.track_only}
                        onChange={(e) => update({ track_only: e.target.checked })} />
                      <label className="form-check-label" htmlFor="fs-track">
                        ติดตามยอดรับอย่างเดียว <span className="small muted">(ไม่ต้องตั้งรายการและสิทธิ นับเฉพาะยอดที่ได้รับจาก REP เช่น FS, DRUG)</span>
                      </label>
                    </div>
                    <div className="form-check">
                      <input id="fs-active" type="checkbox" className="form-check-input" checked={form.is_active} onChange={(e) => update({ is_active: e.target.checked })} />
                      <label className="form-check-label" htmlFor="fs-active">เปิดใช้งานกองทุนนี้</label>
                    </div>
                  </div>
                </div>
              </div>

              {!form.track_only && (<>
              <div className="panel">
                <div className="panel-title mb-2">วิธีคัด visit เข้ากองทุน</div>
                <div className="match-modes" role="radiogroup" aria-label="วิธีคัด visit เข้ากองทุน">
                  {MATCH_MODES.map(([v, label, hint, icon]) => (
                    <label key={v} className={`match-mode ${form.match_mode === v ? 'active' : ''}`}>
                      <input type="radio" name="match_mode" className="visually-hidden" checked={form.match_mode === v}
                        onChange={() => update({ match_mode: v })} />
                      <i className={`bi ${icon}`} aria-hidden="true" />
                      <span><span className="title">{label}</span><span className="desc">{hint}</span></span>
                    </label>
                  ))}
                </div>
                <div className="small muted mt-2">ทุกแบบกรองด้วยสิทธิการรักษาที่เลือกด้านล่าง</div>
              </div>

              <PttypePicker key={form.originalCode || 'new'} list={pttypeList} error={pttypeError} value={form.pttypes}
                onChange={(pttypes) => update({ pttypes })} excluded={excludedHipdata} note={pttypeNote} />

              {form.match_mode !== 'rights' && (
              <div className="panel">
                <div className="panel-title mb-1">
                  {form.match_mode === 'icd' ? 'รหัสโรค ICD-10 ที่นับเข้ากองทุน' : 'กรองเพิ่มด้วยรหัสโรค ICD-10'} ({parseIcd(form.icd10Text).length ? `${parseIcd(form.icd10Text).length} รายการ` : 'ไม่กรอง'})
                </div>
                <p className="small muted mb-2">
                  {form.match_mode === 'icd' ? 'ต้องใส่อย่างน้อย 1 รายการ ' : 'ไม่บังคับ ใช้ร่วมกับรายการค่าบริการ '}
                  visit ต้องมีรหัสโรคตรงอย่างน้อย 1 รายการ ใส่ได้ทั้งรหัสเดี่ยวและช่วง
                  เช่น <code>H25</code> นับ H250 ถึง H259, <code>C00-C96</code> นับทุกรหัสตั้งแต่ C000 ถึง C969
                  มีหรือไม่มีจุดก็ได้ คั่นแต่ละรายการด้วยจุลภาค เว้นวรรค หรือขึ้นบรรทัดใหม่
                </p>
                <textarea className="form-control mb-2" rows={2} value={form.icd10Text} placeholder="เช่น C00-C96, D37-D48, Z51.5"
                  onChange={(e) => update({ icd10Text: e.target.value })} aria-label="รหัส ICD-10" />
                {parseIcd(form.icd10Text).length > 0 && (
                  <div className="d-flex flex-wrap gap-1 mb-2">
                    {parseIcd(form.icd10Text).map((c) => (
                      <span key={c} className={`badge ${icdValid(c) ? 'text-bg-light border' : 'text-bg-danger'}`}
                        title={icdValid(c) ? (c.includes('-') ? `ช่วง ${c.replace('-', ' ถึง ')}` : `ขึ้นต้นด้วย ${c}`) : 'รูปแบบไม่ถูกต้อง (ช่วงต้องเรียงจากน้อยไปมาก)'}>
                        {c.includes('-') ? c.replace('-', ' – ') : c}
                      </span>
                    ))}
                  </div>
                )}
                <div className="d-flex flex-wrap gap-3">
                  {[['any', 'โรคหลักหรือโรครอง'], ['pdx', 'เฉพาะโรคหลัก (PDX)']].map(([v, label]) => (
                    <div className="form-check" key={v}>
                      <input id={`icd-${v}`} type="radio" name="icd10_scope" className="form-check-input"
                        checked={form.icd10_scope === v} onChange={() => update({ icd10_scope: v })} />
                      <label className="form-check-label" htmlFor={`icd-${v}`}>{label}</label>
                    </div>
                  ))}
                </div>
              </div>
              )}

              {form.match_mode === 'items' && (
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
                      <thead>
                        <tr>
                          <SortTh k="icode" sort={itemSort.sort} onSort={itemSort.toggle}>icode</SortTh>
                          <SortTh k="item_name" sort={itemSort.sort} onSort={itemSort.toggle}>ชื่อรายการ</SortTh>
                          <SortTh k="source" sort={itemSort.sort} onSort={itemSort.toggle}>ประเภท</SortTh>
                          <SortTh k="required" sort={itemSort.sort} onSort={itemSort.toggle} className="text-center">จำเป็น</SortTh>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {itemSort.sorted.map((it) => (
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
                      <thead>
                        <tr>
                          <SortTh k="icode" sort={resultSort.sort} onSort={resultSort.toggle}>icode</SortTh>
                          <SortTh k="name" sort={resultSort.sort} onSort={resultSort.toggle}>ชื่อรายการ</SortTh>
                          <SortTh k="price" sort={resultSort.sort} onSort={resultSort.toggle} className="num">ราคา</SortTh>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {resultSort.sorted.map((it) => (
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

              )}
              </>)}

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
