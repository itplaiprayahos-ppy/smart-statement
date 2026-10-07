import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import {
  confirmAction, notifySuccess, showError, showInfo, showSuccess, withLoading,
} from '../utils/alert.js';
import { int, money, thaiDate, thaiDateTime, thaiMonth } from '../utils/format.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function errorListHtml(errors, more = 0) {
  const rows = errors.map((e) => `<tr><td class="text-end pe-3">${e.row}</td><td>${escapeHtml(e.message)}</td></tr>`).join('');
  return `<div style="max-height:320px;overflow:auto;text-align:left;font-size:.85rem">
    <table class="table table-sm"><thead><tr><th class="pe-3">แถว</th><th>ปัญหา</th></tr></thead><tbody>${rows}</tbody></table>
    ${more > 0 ? `<div class="text-muted">และอีก ${more} แถว</div>` : ''}</div>`;
}

/** [15,16,17,20] -> "15–17, 20" */
function rowRanges(nums) {
  const out = [];
  nums.forEach((n) => {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  });
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

export default function ImportPage() {
  const { isAdmin } = useAuth();
  const [mappings, setMappings] = useState([]);
  const [fields, setFields] = useState({});
  const [mappingId, setMappingId] = useState('');
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [legacy, setLegacy] = useState(null);
  const inputRef = useRef(null);

  const loadHistory = useCallback(() => {
    api.get('/imports', { params: { claimType: 'OPD' } }).then((r) => setHistory(r.data)).catch(showError);
    api.get('/imports/legacy-stm').then((r) => setLegacy(r.data)).catch(() => {});
  }, []);

  const removeLegacy = async () => {
    const ok = await confirmAction({
      title: 'ลบข้อมูล Statement เดิมทั้งหมด?',
      text: `ไฟล์ Statement ${int(legacy.batches)} ไฟล์ (${int(legacy.lines)} รายการ) จะถูกลบถาวร ระบบจะใช้ข้อมูลจาก REP อย่างเดียว`,
      confirmText: 'ลบข้อมูล Statement',
      danger: true,
    });
    if (!ok) return;
    try {
      const { data } = await api.delete('/imports/legacy-stm');
      notifySuccess(`ลบแล้ว ${int(data.deleted)} ไฟล์`);
      loadHistory();
    } catch (err) {
      showError(err);
    }
  };

  useEffect(() => {
    Promise.all([api.get('/mappings', { params: { active: 1 } }), api.get('/mappings/fields')])
      .then(([m, f]) => {
        const opd = m.data.filter((x) => x.claim_type === 'OPD');
        setMappings(opd);
        setFields(f.data);
        if (opd[0]) setMappingId(String(opd[0].id));
      })
      .catch(showError);
    loadHistory();
  }, [loadHistory]);

  const pickFile = (f) => {
    if (!f) return;
    if (!/\.(xlsx|xls)$/i.test(f.name)) return showError('รองรับเฉพาะไฟล์ .xlsx และ .xls');
    setFile(f);
    setPreview(null);
  };

  const formData = () => {
    const fd = new FormData();
    fd.append('mappingId', mappingId);
    fd.append('file', file);
    return fd;
  };

  const runPreview = async () => {
    try {
      const res = await withLoading('กำลังอ่านไฟล์…', () => api.post('/imports/preview', formData()));
      setPreview(res.data);
    } catch (err) {
      showError(err, 'อ่านไฟล์ไม่สำเร็จ');
    }
  };

  const runImport = async () => {
    const ok = await confirmAction({
      title: `นำเข้า ${int(preview.validRows)} รายการ?`,
      text: preview.errorCount ? `แถวที่มีปัญหา ${int(preview.errorCount)} แถวจะไม่ถูกนำเข้า` : 'รายการที่เคยนำเข้าแล้วจะถูกอัปเดตเป็นข้อมูลล่าสุด',
      confirmText: 'นำเข้า',
    });
    if (!ok) return;
    try {
      const res = await withLoading('กำลังนำเข้า…', () => api.post('/imports', formData()));
      const r = res.data;
      await showSuccess('นำเข้าแล้ว', `เพิ่มใหม่ ${int(r.inserted)} รายการ<br>อัปเดตรายการเดิม ${int(r.updated)} รายการ${r.errorCount ? `<br>ข้าม ${int(r.errorCount)} แถวที่มีปัญหา` : ''}`);
      setFile(null);
      setPreview(null);
      if (inputRef.current) inputRef.current.value = '';
      loadHistory();
    } catch (err) {
      showError(err, 'นำเข้าไม่สำเร็จ');
    }
  };

  const viewErrors = async (id) => {
    try {
      const { data } = await api.get(`/imports/${id}`);
      if (!data.errors.length) return showInfo('ไม่มีแถวที่มีปัญหา');
      showInfo(`แถวที่ข้าม (${int(data.error_rows)})`, errorListHtml(data.errors, data.error_rows - data.errors.length));
    } catch (err) {
      showError(err);
    }
  };

  const removeBatch = async (b) => {
    const ok = await confirmAction({
      title: 'ลบการนำเข้านี้?',
      text: `รายการ ${int(b.current_rows)} รายการที่มาจากไฟล์ ${b.file_name} จะถูกลบ`,
      confirmText: 'ลบ',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/imports/${b.id}`);
      notifySuccess('ลบแล้ว');
      loadHistory();
    } catch (err) {
      showError(err);
    }
  };

  const sampleCols = ['rep_no', 'tran_id', 'hn', 'pid', 'patient_name', 'service_date', 'claim_amount', 'compensated', 'error_code'];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>นำเข้าไฟล์ สปสช.</h1>
          <p>ไฟล์ REP ที่ดาวน์โหลดจาก e-Claim (.xls, .xlsx) ชีต Detail ระบบจะตรวจไฟล์ให้ดูก่อนบันทึก</p>
        </div>
      </div>

      {legacy?.batches > 0 && (
        <div className="alert alert-warning d-flex flex-wrap align-items-center gap-2">
          <i className="bi bi-exclamation-triangle" />
          <span className="me-auto">
            ยังมีข้อมูลจากไฟล์ Statement เดิม {int(legacy.batches)} ไฟล์ ({int(legacy.lines)} รายการ)
            ถ้าใช้คู่กับ REP ยอดเบิกได้จะถูกนับซ้ำ ควรลบออกก่อนนำเข้า REP
          </span>
          {isAdmin && (
            <button type="button" className="btn btn-sm btn-danger" onClick={removeLegacy}>ลบข้อมูล Statement เดิม</button>
          )}
        </div>
      )}

      <div className="panel">
        <div className="row g-3 align-items-end">
          <div className="col-lg-4">
            <label className="form-label" htmlFor="mapping">รูปแบบไฟล์</label>
            <select id="mapping" className="form-select" value={mappingId} onChange={(e) => { setMappingId(e.target.value); setPreview(null); }}>
              {mappings.length === 0 && <option value="">ยังไม่มีรูปแบบไฟล์ OPD</option>}
              {mappings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="col-lg-8">
            <div
              className={`drop-zone ${drag ? 'drag' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files[0]); }}
            >
              <i className="bi bi-file-earmark-spreadsheet fs-3 muted" aria-hidden="true" />
              <div className="mt-1">
                {file ? <strong>{file.name}</strong> : 'ลากไฟล์มาวางที่นี่ หรือ'}{' '}
                <button type="button" className="btn btn-link p-0 align-baseline" onClick={() => inputRef.current?.click()}>
                  {file ? 'เปลี่ยนไฟล์' : 'เลือกไฟล์'}
                </button>
              </div>
              <input ref={inputRef} type="file" accept=".xlsx,.xls" hidden onChange={(e) => pickFile(e.target.files[0])} />
            </div>
          </div>
        </div>
        <div className="mt-3 d-flex gap-2">
          <button type="button" className="btn btn-outline-primary" disabled={!file || !mappingId} onClick={runPreview}>
            <i className="bi bi-search me-1" />ตรวจไฟล์
          </button>
          {preview && preview.missingRequired.length === 0 && preview.validRows > 0 && (
            <button type="button" className="btn btn-primary" onClick={runImport}>
              <i className="bi bi-check2 me-1" />นำเข้า {int(preview.validRows)} รายการ
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div className="panel">
          <div className="panel-title">ผลการตรวจไฟล์ {preview.fileName}</div>
          <p className="muted mb-3">
            {preview.stmDoc
              ? <>เลขที่ REP <strong>{preview.stmDoc}</strong>{preview.stmPeriod && ` (${thaiMonth(preview.stmPeriod.slice(0, 7))})`}, </>
              : <span className="text-warning-emphasis">ไม่พบเลขที่ REP (รายการจะไม่แยกตามรอบ), </span>}
            ชีต “{preview.sheetName}” หัวตารางอยู่แถวที่ {preview.headerRowNumber}:
            พบ {int(preview.totalRows)} แถว นำเข้าได้ {int(preview.validRows)} แถว
            {preview.errorCount > 0 && <>, <span className="text-danger">มีปัญหา {int(preview.errorCount)} แถว</span></>}
          </p>

          {preview.skipped?.count > 0 && (
            <div className="alert alert-light border small py-2">
              <i className="bi bi-info-circle me-1" />
              ข้ามแถวที่ไม่ใช่ข้อมูลคนไข้ {int(preview.skipped.count)} แถว (แถวที่ {rowRanges(preview.skipped.rows)}
              {preview.skipped.count > preview.skipped.rows.length ? ' …' : ''})
              {preview.skipped.endedAtRow && <> ตารางข้อมูลจบที่แถว {preview.skipped.endedAtRow}</>}
              {' '}เช่น แถวรวมยอดหรือส่วนท้ายรายงาน ถ้ามีข้อมูลคนไข้อยู่ในแถวเหล่านี้ แจ้งผู้ดูแลระบบ
            </div>
          )}

          {preview.headers?.length > 0 && (
            <details className="mb-3">
              <summary className="small">หัวคอลัมน์ทั้งหมดในไฟล์ ({preview.headers.length}) ใช้คัดลอกไปตั้งค่ารูปแบบไฟล์และกองทุน</summary>
              <div className="d-flex flex-wrap gap-1 mt-2">
                {preview.headers.map((h) => <code key={h} className="border rounded px-2 py-1 text-body bg-light">{h}</code>)}
              </div>
            </details>
          )}

          {preview.missingRequired.length > 0 && (
            <div className="alert alert-danger">
              ไม่พบคอลัมน์ที่จำเป็น: <strong>{preview.missingRequired.join(', ')}</strong>
              <div className="small mt-1">ตรวจชื่อหัวคอลัมน์ในไฟล์ แล้วให้ผู้ดูแลระบบเพิ่มชื่อนั้นในหน้า “รูปแบบไฟล์ Excel”</div>
            </div>
          )}

          <div className="row g-3">
            <div className="col-lg-4">
              <div className="fw-medium mb-2">คอลัมน์ที่จับคู่ได้</div>
              <table className="table table-sm data-table">
                <tbody>
                  {Object.entries(fields).map(([key, def]) => (
                    <tr key={key}>
                      <td>{def.label}{def.required && <span className="text-danger"> *</span>}</td>
                      <td className={preview.matchedColumns[key] ? '' : 'muted'}>{preview.matchedColumns[key] || 'ไม่พบ'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="col-lg-8">
              {preview.errors.length > 0 && (
                <div className="mb-3">
                  <div className="fw-medium mb-2">แถวที่จะถูกข้าม</div>
                  <div className="table-wrap" style={{ maxHeight: 200 }}>
                    <table className="table table-sm data-table">
                      <thead><tr><th>แถว</th><th>ปัญหา</th></tr></thead>
                      <tbody>{preview.errors.map((e) => <tr key={`${e.row}-${e.message}`}><td>{e.row}</td><td>{e.message}</td></tr>)}</tbody>
                    </table>
                  </div>
                </div>
              )}
              {preview.fundColumns && Object.keys(preview.fundColumns).length > 0 && (
                <div className="mb-3">
                  <div className="fw-medium mb-2">คอลัมน์ยอดที่ได้รับรายกองทุน</div>
                  <div className="table-wrap">
                    <table className="table table-sm data-table">
                      <tbody>
                        {Object.entries(preview.fundColumns).map(([code, fc]) => (
                          <tr key={code}>
                            <td style={{ width: 110 }}>{code}</td>
                            <td>{fc.matched.length ? fc.matched.join(' + ') : <span className="muted">ไม่พบ</span>}</td>
                            <td className="text-danger small">{fc.missing.length > 0 && `ไม่พบ: ${fc.missing.join(', ')}`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="fw-medium mb-2">ตัวอย่าง 10 แถวแรก</div>
              <div className="table-wrap">
                <table className="table table-sm data-table">
                  <thead><tr>{sampleCols.map((c) => <th key={c}>{fields[c]?.label}</th>)}</tr></thead>
                  <tbody>
                    {preview.sample.map((r) => (
                      <tr key={r.row_number}>
                        {sampleCols.map((c) => (
                          <td key={c} className={['claim_amount', 'compensated'].includes(c) ? 'num' : ''}>
                            {c === 'service_date' ? thaiDate(r[c]) : ['claim_amount', 'compensated'].includes(c) ? money(r[c]) : (r[c] ?? '–')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">ประวัติการนำเข้า</div>
        {history.length === 0 ? (
          <p className="muted mb-0">ยังไม่มีการนำเข้าไฟล์</p>
        ) : (
          <div className="table-wrap">
            <table className="table table-hover data-table">
              <thead>
                <tr>
                  <th>เวลา</th><th>ไฟล์</th><th>เลขที่ REP</th><th>ช่วงวันที่ในไฟล์</th>
                  <th className="num">เพิ่มใหม่</th><th className="num">อัปเดต</th><th className="num">ข้าม</th>
                  <th>ผู้นำเข้า</th><th />
                </tr>
              </thead>
              <tbody>
                {history.map((b) => (
                  <tr key={b.id}>
                    <td className="text-nowrap">{thaiDateTime(b.created_at)}</td>
                    <td>
                      {b.file_name}
                      {b.file_type === 'STM' && <span className="badge text-bg-warning ms-1">Statement เดิม</span>}
                      <div className="small-id">{b.mapping_name}</div>
                    </td>
                    <td>{b.stm_doc || <span className="muted">–</span>}
                      {b.stm_period && <div className="small-id">{thaiMonth(b.stm_period.slice(0, 7))}</div>}
                    </td>
                    <td className="text-nowrap">{b.date_min ? `${thaiDate(b.date_min)} – ${thaiDate(b.date_max)}` : <span className="muted">ถูกแทนที่ด้วยไฟล์ใหม่กว่า</span>}</td>
                    <td className="num">{int(b.inserted_rows)}</td>
                    <td className="num">{int(b.updated_rows)}</td>
                    <td className="num">
                      {b.error_rows > 0
                        ? <button type="button" className="btn btn-link btn-sm p-0 text-danger" onClick={() => viewErrors(b.id)}>{int(b.error_rows)}</button>
                        : 0}
                    </td>
                    <td>{b.imported_by}</td>
                    <td className="text-end">
                      {isAdmin && (
                        <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeBatch(b)} title="ลบการนำเข้านี้">
                          <i className="bi bi-trash" /><span className="visually-hidden">ลบ</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
