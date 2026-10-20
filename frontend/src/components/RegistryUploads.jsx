import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import Modal from './Modal.jsx';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { notifySuccess, showError, showSuccess } from '../utils/alert.js';
import { int, money, thaiDate } from '../utils/format.js';

/* =====================================================================
 * อัปโหลดทะเบียน (ใช้ในหน้าเทียบ 3 แหล่ง)
 *  - ทะเบียนห้อง/แผนก: ยอดรวมต่อคนไข้ต่อวันของแต่ละห้อง เลือกห้องตอนอัปโหลด
 *  - ทะเบียนกองทุน: รายการค่าบริการของกองทุน เลือกกองทุนตอนอัปโหลด
 * ===================================================================== */
/* ---------- อัปโหลดทะเบียน: เลือกห้อง/แผนก ตอนอัปโหลด ไม่ต้องตั้งค่าล่วงหน้า ---------- */
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((c, i) => c === [...b].sort()[i]);

export function PointUploadModal({ points, initialDepCodes = [], onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [depts, setDepts] = useState([]);
  const [deptInfo, setDeptInfo] = useState(null);     // { source: hosxp | pulled | none, error }
  const [manual, setManual] = useState('');
  const [depCodes, setDepCodes] = useState(initialDepCodes || []);
  const [guessed, setGuessed] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDepts = useCallback((refresh = false) => api.get('/points/departments', { params: { info: 1, refresh: refresh ? 1 : undefined } })
    .then((r) => { setDepts(r.data.list); setDeptInfo({ source: r.data.source, error: r.data.error }); })
    .catch(() => setDeptInfo({ source: 'none', error: 'other' })), []);
  useEffect(() => { loadDepts(); }, [loadDepts]);
  const fd = (f) => { const d = new FormData(); d.append('file', f); return d; };
  const addManual = () => {
    const code = manual.trim();
    if (!/^[\w-]{1,20}$/.test(code)) { showError('รหัสแผนกใช้ตัวอักษร ตัวเลข หรือ - ยาวไม่เกิน 20 ตัว'); return; }
    setDepts((l) => (l.some((d) => String(d.code) === code) ? l : [...l, { code, name: null }]));
    setDepCodes((l) => (l.includes(code) ? l : [...l, code]));
    setManual('');
  };

  const pick = async (f) => {
    setFile(f); setPreview(null); setGuessed(false);
    if (!f) return;
    setBusy(true);
    try {
      const { data } = await api.post('/points/registry/preview', fd(f));
      setPreview(data);
      if (data.suggestedDepCodes?.length) { setDepCodes(data.suggestedDepCodes); setGuessed(true); }
    } catch (err) { showError(err, 'อ่านไฟล์ไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const doImport = async () => {
    setBusy(true);
    try {
      const body = fd(file); body.append('dep_codes', JSON.stringify(depCodes));
      const { data } = await api.post('/points/registry', body);
      await showSuccess('นำเข้าทะเบียนแล้ว',
        `${data.point.name}: ${int(data.inserted)} รายการ (แทนที่รายการเดิม ${int(data.replaced)} รายการ)`
        + (data.point.created ? '<br>สร้างห้อง/แผนกใหม่ให้อัตโนมัติ' : ''));
      notifyDataChanged(); onDone(data.point.code);
    } catch (err) { showError(err, 'นำเข้าไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const usedBy = (code) => points.filter((p) => (p.dep_codes || []).map(String).includes(String(code)));
  const toggle = (code) => { setGuessed(false); setDepCodes((l) => (l.includes(code) ? l.filter((c) => c !== code) : [...l, code])); };
  const q = filter.trim().toLowerCase();
  const shown = depts.filter((d) => !q || String(d.code).toLowerCase().includes(q) || (d.name || '').toLowerCase().includes(q));
  const target = points.find((p) => sameSet((p.dep_codes || []).map(String), depCodes));
  const names = depCodes.map((c) => depts.find((d) => String(d.code) === c)?.name || c).join(' + ');
  const overlap = !target && depCodes.length > 1 && depCodes.flatMap(usedBy).length > 0;
  const ok = preview && !preview.missingRequired.length && preview.validRows > 0 && depCodes.length > 0;

  return (
    <Modal show title="อัปโหลดทะเบียนห้อง/แผนก" onClose={onClose} size="modal-lg"
      footer={(<>
        <button type="button" className="btn btn-light" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!ok || busy} onClick={doImport}>
          {busy && <span className="spinner-border spinner-border-sm me-1" />}นำเข้า {ok ? `${int(preview.validRows)} รายการ` : ''}
        </button>
      </>)}>
      <label className="form-label fw-medium" htmlFor="pt-file">1. เลือกไฟล์ทะเบียน</label>
      <input id="pt-file" type="file" className="form-control mb-1" accept=".xlsx,.xls" disabled={busy} onChange={(e) => pick(e.target.files[0])} />
      <p className="small muted">
        คอลัมน์ที่ต้องมี: วันที่รับบริการ และ HN (หรือเลขบัตรประชาชน) ส่วนยอดรวม (บาท) ใส่หรือไม่ก็ได้
        (ใส่: เทียบยอดเงินกับ HOSxP / ไม่ใส่: เทียบเฉพาะว่ามีค่าใช้จ่ายของห้องนี้ใน HOSxP) ถ้าลงหลายแถวต่อคนต่อวัน ระบบรวมยอดให้
        HN ไม่ครบ 9 หลักเติม 0 ให้อัตโนมัติ · <a href="/api/points/template">ดาวน์โหลดแม่แบบทะเบียนห้อง/แผนก</a>
      </p>
      {busy && !preview && <div className="text-center py-2"><span className="spinner-border text-secondary" /></div>}
      {preview && (preview.missingRequired.length ? (
        <div className="alert alert-danger py-2">ไม่พบคอลัมน์: {preview.missingRequired.join(', ')}</div>
      ) : (
        <ul className="list-unstyled small mb-3">
          <li><i className="bi bi-table me-1" />ชีต “{preview.sheetName}” หัวตารางแถวที่ {preview.headerRowNumber}: {Object.values(preview.columns).join(', ')}</li>
          <li><i className="bi bi-calendar-range me-1" />ช่วงวันที่ {thaiDate(preview.dateFrom)} – {thaiDate(preview.dateTo)}</li>
          <li><i className="bi bi-check2 me-1" />นำเข้าได้ {int(preview.validRows)} จาก {int(preview.totalRows)} แถว
            {preview.validRows > preview.noAmountRows && <> ยอดรวม {money(preview.totalAmount)} บาท</>}</li>
          {preview.noAmountRows > 0 && (
            <li className="text-info-emphasis"><i className="bi bi-info-circle me-1" />
              {preview.noAmountRows === preview.validRows ? 'ไฟล์นี้ไม่มียอดเงิน' : `${int(preview.noAmountRows)} แถวไม่มียอดเงิน`}
              {' '}จะเทียบเฉพาะว่าคนไข้มีค่าใช้จ่ายของห้อง/แผนกนี้ใน HOSxP หรือไม่ (ไม่เทียบยอดเงิน)
            </li>
          )}
          {preview.errorCount > 0 && (
            <li className="text-warning-emphasis"><i className="bi bi-exclamation-triangle me-1" />แถวที่มีปัญหา {int(preview.errorCount)} แถว จะไม่ถูกนำเข้า
              ({preview.errors.slice(0, 3).map((e) => `แถว ${e.row}: ${e.message}`).join(', ')})</li>
          )}
        </ul>
      ))}

      <label className="form-label fw-medium">2. เลือกห้อง/แผนก ที่ทะเบียนนี้เป็นของ</label>
      {deptInfo && deptInfo.source !== 'hosxp' && (
        <div className="alert alert-warning py-2 small mb-2">
          <i className="bi bi-exclamation-triangle me-1" />
          {deptInfo.source === 'none'
            ? 'ยังไม่มีรายชื่อแผนก'
            : 'อ่านชื่อแผนกจาก HOSxP ไม่ได้ จึงแสดงเฉพาะรหัสแผนกที่พบในข้อมูลที่ดึงมาแล้ว'}
          {deptInfo.error === 'permission' && <> สาเหตุ: ยังไม่ได้ให้สิทธิ์อ่านตาราง kskdepartment (<code>GRANT SELECT ON kskdepartment TO claim_reader;</code>)</>}
          {deptInfo.source === 'none' && <> ให้ดึงข้อมูล HOSxP ก่อน หรือพิมพ์รหัสแผนกด้านล่าง</>}
          <button type="button" className="btn btn-sm btn-outline-secondary ms-2" onClick={() => loadDepts(true)}>
            <i className="bi bi-arrow-clockwise me-1" />โหลดรายชื่อแผนกใหม่
          </button>
        </div>
      )}
      {guessed && (
        <div className="alert alert-info py-1 small mb-2">
          <i className="bi bi-magic me-1" />ระบบเลือกให้จากชื่อไฟล์หรือหัวรายงาน กรุณาตรวจว่าถูกต้อง
        </div>
      )}
      <input className="form-control form-control-sm mb-2" placeholder="ค้นหารหัสหรือชื่อแผนก" value={filter}
        onChange={(e) => setFilter(e.target.value)} aria-label="ค้นหาแผนก" />
      <div className="scroll-box mb-2" style={{ height: 200 }}>
        <table className="table table-sm table-hover data-table">
          <tbody>
            {shown.map((d) => {
              const code = String(d.code); const used = usedBy(code);
              return (
                <tr key={code} style={{ cursor: 'pointer' }} onClick={() => toggle(code)}>
                  <td style={{ width: 36 }}><input type="checkbox" className="form-check-input" readOnly checked={depCodes.includes(code)} aria-label={`เลือกแผนก ${code} ${d.name || ''}`} /></td>
                  <td style={{ width: 70 }}>{code}</td>
                  <td className="wrap">{d.name || <span className="muted">ไม่ทราบชื่อ</span>}</td>
                  <td className="small muted">{used.length ? `มีทะเบียนแล้ว: ${used.map((u) => u.name).join(', ')}` : ''}</td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={4} className="muted text-center py-3">
              {depts.length ? 'ไม่พบแผนกที่ค้นหา' : 'ยังไม่มีรายชื่อแผนก พิมพ์รหัสแผนกเองได้ที่ช่องด้านล่าง'}
            </td></tr>}
          </tbody>
        </table>
      </div>
      <div className="input-group input-group-sm mb-2" style={{ maxWidth: 360 }}>
        <input className="form-control" placeholder="ไม่เห็นห้อง/แผนกที่ต้องการ? พิมพ์รหัสแผนก" value={manual}
          onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
          aria-label="พิมพ์รหัสแผนกเอง" />
        <button type="button" className="btn btn-outline-secondary" onClick={addManual} disabled={!manual.trim()}>เพิ่ม</button>
      </div>
      <div className="small">
        {depCodes.length === 0 && <span className="text-danger"><i className="bi bi-exclamation-circle me-1" />เลือกห้อง/แผนกอย่างน้อย 1 รายการ</span>}
        {depCodes.length > 0 && target && (
          <span className="text-success"><i className="bi bi-check-circle me-1" />บันทึกเข้าห้อง/แผนกเดิม: <strong>{target.name}</strong>
            {' '}(แทนที่ทะเบียนเดิมในช่วงวันที่ของไฟล์)</span>
        )}
        {depCodes.length > 0 && !target && (
          <span><i className="bi bi-plus-circle me-1" />จะสร้างห้อง/แผนกใหม่ให้อัตโนมัติ: <strong>{names}</strong></span>
        )}
        {overlap && <div className="text-warning-emphasis mt-1">บางแผนกที่เลือกมีทะเบียนของตัวเองอยู่แล้ว การเลือกหลายแผนกพร้อมกันจะเป็นห้อง/แผนกชุดใหม่แยกต่างหาก</div>}
      </div>
    </Modal>
  );
}


/* ---------- อัปโหลดทะเบียน ---------- */
export function FundUploadModal({ funds, initialFund, onClose, onDone }) {
  const [fundCode, setFundCode] = useState(initialFund || '');
  const fund = funds.find((f) => f.code === fundCode);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f, code = fundCode) => {
    setFile(f); setPreview(null);
    if (!f || !code) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('fundCode', code); fd.append('file', f);
      const { data } = await api.post('/registry/preview', fd);
      setPreview(data);
    } catch (err) { showError(err, 'อ่านไฟล์ไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const doImport = async () => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('fundCode', fund.code); fd.append('file', file);
      const { data } = await api.post('/registry', fd);
      await showSuccess('นำเข้าทะเบียนแล้ว', `${int(data.inserted)} รายการ (แทนที่รายการเดิม ${int(data.replaced)} รายการ)`
        + (data.visitLevel ? `<br>${int(data.visitLevel)} แถวไม่มีรายการค่าบริการ เทียบระดับ visit` : '')
        + (data.unknown ? `<br>มีรายการที่ยังไม่รู้จัก ${int(data.unknown)} แถว กรุณาจับคู่รายการ` : ''));
      notifyDataChanged();
      onDone(data);
    } catch (err) { showError(err, 'นำเข้าไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const ok = fund && preview && !preview.missingRequired.length && preview.validRows > 0;
  return (
    <Modal show title="อัปโหลดทะเบียนกองทุน" onClose={onClose} size="modal-lg"
      footer={(<>
        <button type="button" className="btn btn-light" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!ok || busy} onClick={doImport}>
          {busy && <span className="spinner-border spinner-border-sm me-1" />}นำเข้า {ok ? `${int(preview.validRows)} รายการ` : ''}
        </button>
      </>)}>
      <label className="form-label fw-medium" htmlFor="fu-fund">1. เลือกกองทุน</label>
      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <select id="fu-fund" className="form-select" style={{ maxWidth: 360 }} value={fundCode} disabled={busy}
          onChange={(e) => { setFundCode(e.target.value); if (file) pick(file, e.target.value); }}>
          <option value="" disabled>เลือกกองทุน</option>
          {funds.map((f) => <option key={f.code} value={f.code}>{f.code} {f.name}</option>)}
        </select>
        {fund && <a className="small" href={`/api/registry/template?fundCode=${fund.code}`}>ดาวน์โหลดแม่แบบทะเบียน {fund.code}</a>}
      </div>
      <label className="form-label fw-medium" htmlFor="fu-file">2. เลือกไฟล์ทะเบียน</label>
      <input id="fu-file" type="file" className="form-control mb-2" accept=".xlsx,.xls" disabled={busy || !fund} onChange={(e) => pick(e.target.files[0])} />
      <p className="small muted">
        คอลัมน์ที่ต้องมี: วันที่ให้บริการ และ HN (หรือเลขบัตรประชาชน) ส่วนรายการค่าบริการและราคาใส่หรือไม่ก็ได้
        (ใส่: เทียบละเอียดถึงระดับรายการ / ไม่ใส่: เทียบระดับ visit) ระบบหาแถวหัวตารางเอง
        การนำเข้าจะ <strong>แทนที่ทะเบียนของกองทุนนี้ในช่วงวันที่ที่ไฟล์ครอบคลุม</strong> แก้ไฟล์ใน Excel แล้วอัปโหลดซ้ำได้
      </p>
      {busy && !preview && <div className="text-center py-3"><span className="spinner-border text-secondary" /></div>}
      {preview && (
        <>
          {preview.missingRequired.length > 0 ? (
            <div className="alert alert-danger py-2">ไม่พบคอลัมน์: {preview.missingRequired.join(', ')}</div>
          ) : (
            <ul className="list-unstyled mb-2 small">
              <li><i className="bi bi-table me-1" />ชีต “{preview.sheetName}” หัวตารางแถวที่ {preview.headerRowNumber}:{' '}
                {Object.entries(preview.columns).map(([, v]) => v).join(', ')}</li>
              <li><i className="bi bi-calendar-range me-1" />ช่วงวันที่ในไฟล์ {thaiDate(preview.dateFrom)} – {thaiDate(preview.dateTo)}
                {' '}(รายการเดิมของกองทุนนี้ในช่วงนี้จะถูกแทนที่)</li>
              <li><i className="bi bi-check2 me-1" />นำเข้าได้ {int(preview.validRows)} จาก {int(preview.totalRows)} แถว</li>
              {preview.visitLevelRows > 0 && (
                <li><i className="bi bi-person-check me-1" />
                  {preview.visitLevelRows === preview.validRows ? 'ไฟล์นี้ไม่มีรายการค่าบริการ' : `${int(preview.visitLevelRows)} แถวไม่มีรายการค่าบริการ`}
                  {' '}จะเทียบระดับ visit (มี visit ไหม เข้าเกณฑ์กองทุนไหม ได้รับเงินไหม)
                </li>
              )}
            </ul>
          )}
          {preview.errorCount > 0 && (
            <div className="alert alert-warning py-2 small mb-2">
              แถวที่มีปัญหา {int(preview.errorCount)} แถว (จะไม่ถูกนำเข้า):
              <ul className="mb-0">{preview.errors.slice(0, 5).map((e) => <li key={e.row}>แถว {e.row}: {e.message}</li>)}</ul>
              {preview.errorCount > 5 && '…'}
            </div>
          )}
          {preview.unknownItems.length > 0 && (
            <div className="alert alert-info py-2 small mb-0">
              ชื่อรายการที่ยังไม่รู้จัก {preview.unknownItems.length} ชื่อ (นำเข้าได้ แล้วจับคู่ภายหลัง):{' '}
              {preview.unknownItems.slice(0, 5).map((u) => `${u.text} (${u.count})`).join(', ')}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/* ---------- จับคู่ชื่อรายการ ---------- */
export function MatchItemsModal({ fund, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [fundItems, setFundItems] = useState([]);
  const [search, setSearch] = useState({});
  const [results, setResults] = useState({});

  const load = useCallback(() => {
    api.get('/registry/unknown-items', { params: { fundCode: fund.code } }).then((r) => setList(r.data)).catch(showError);
  }, [fund.code]);
  useEffect(() => {
    load();
    api.get(`/funds/${fund.code}`).then((r) => setFundItems(r.data.items || [])).catch(() => {});
  }, [load, fund.code]);

  const choose = async (text, icode, itemName) => {
    try {
      const { data } = await api.post('/registry/aliases', { text, icode, itemName });
      notifySuccess(`จับคู่แล้ว ${int(data.updated)} แถว`);
      load(); onDone();
    } catch (err) { showError(err); }
  };
  const find = async (text) => {
    const q = (search[text] || '').trim();
    if (q.length < 2) return;
    try {
      const [a, b] = await Promise.all([
        api.get('/funds/items/search', { params: { source: 'nondrug', q } }),
        api.get('/funds/items/search', { params: { source: 'drug', q } }),
      ]);
      setResults((r) => ({ ...r, [text]: [...a.data.items, ...b.data.items].slice(0, 30) }));
    } catch (err) { showError(err, 'ค้นหาใน HOSxP ไม่สำเร็จ'); }
  };

  return (
    <Modal show title="จับคู่ชื่อรายการในทะเบียนกับรายการใน HOSxP" onClose={onClose} size="modal-lg"
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>เสร็จ</button>}>
      <p className="small muted">จับคู่ครั้งเดียว ระบบจำไว้ใช้กับการอัปโหลดครั้งต่อไปทุกกองทุน</p>
      {!list ? <div className="text-center py-3"><span className="spinner-border text-secondary" /></div>
        : list.length === 0 ? <p className="mb-0 text-success"><i className="bi bi-check-circle me-1" />จับคู่ครบทุกรายการแล้ว</p>
          : list.map((u) => (
            <div key={u.item_key} className="match-item">
              <div className="fw-medium">“{u.text}” <span className="small muted">{int(u.count)} แถว</span></div>
              <div className="d-flex flex-wrap gap-2 mt-1">
                <select className="form-select form-select-sm" style={{ maxWidth: 320 }} defaultValue=""
                  onChange={(e) => { const it = fundItems.find((x) => x.icode === e.target.value); if (it) choose(u.text, it.icode, it.item_name); }}>
                  <option value="" disabled>เลือกจากรายการของกองทุน {fund.code}</option>
                  {fundItems.map((it) => <option key={it.icode} value={it.icode}>{it.icode} {it.item_name}</option>)}
                </select>
                <div className="input-group input-group-sm" style={{ maxWidth: 320 }}>
                  <input className="form-control" placeholder="หรือค้นหาใน HOSxP" value={search[u.text] || ''}
                    onChange={(e) => setSearch((s) => ({ ...s, [u.text]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') find(u.text); }} />
                  <button type="button" className="btn btn-outline-primary" onClick={() => find(u.text)}>ค้นหา</button>
                </div>
              </div>
              {results[u.text]?.length > 0 && (
                <div className="list-group list-group-flush mt-1 small">
                  {results[u.text].map((it) => (
                    <button key={`${it.source}-${it.icode}`} type="button" className="list-group-item list-group-item-action py-1"
                      onClick={() => choose(u.text, it.icode, it.name)}>
                      {it.icode} {it.name} {it.price != null && <span className="muted">({money(it.price)})</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
    </Modal>
  );
}


/* ---------- เลือกชนิดทะเบียนก่อนอัปโหลด ---------- */
export function UploadChooser({ onPick, onClose }) {
  const opts = [
    ['point', 'bi-door-open', 'ทะเบียนห้อง/แผนก', 'ยอดรวมต่อคนไข้ของห้อง เช่น ทันตกรรม กายภาพบำบัด (ยอดเงินใส่หรือไม่ก็ได้)'],
    ['fund', 'bi-diagram-3', 'ทะเบียนกองทุน', 'รายการค่าบริการของกองทุน เช่น AE, PP (ใส่ชื่อรายการและราคาได้)'],
  ];
  return (
    <Modal show title="อัปโหลดทะเบียน" onClose={onClose}
      footer={<button type="button" className="btn btn-light" onClick={onClose}>ยกเลิก</button>}>
      <p className="small muted">ทะเบียนนี้เป็นแบบไหน</p>
      <div className="d-grid gap-2">
        {opts.map(([k, icon, title, desc]) => (
          <button key={k} type="button" className="upload-choice" onClick={() => onPick(k)}>
            <i className={`bi ${icon}`} aria-hidden="true" />
            <span><span className="title">{title}</span><span className="desc">{desc}</span></span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
