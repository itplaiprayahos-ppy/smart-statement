import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import Modal from './Modal.jsx';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { showError, showSuccess } from '../utils/alert.js';
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
