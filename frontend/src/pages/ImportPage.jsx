import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/client.js';
import SortTh from '../components/SortTh.jsx';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { useSort } from '../hooks/useSort.js';
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
  // ไฟล์ที่เลือก: { id, file, status, preview, result, error }
  // status: pending | checking | checked | invalid | importing | done | failed
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const preview = items.find((x) => x.id === selected)?.preview || null;
  const fileSort = useSort(items, undefined, {
    name: (x) => x.file.name, rep: (x) => x.preview?.stmDoc, rows: (x) => x.preview?.totalRows,
    valid: (x) => x.preview?.validRows, errors: (x) => x.preview?.errorCount, status: (x) => x.status,
  });
  const setItem = (id, patch) => setItems((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const [history, setHistory] = useState([]);
  const [legacy, setLegacy] = useState(null);
  const histSort = useSort(history, undefined, {
    period: (b) => b.date_min, inserted: (b) => b.inserted_rows, updated: (b) => b.updated_rows, errors: (b) => b.error_rows,
  });
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
      notifyDataChanged();
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

  const MAX_FILES = 50;
  const pickFiles = (fileList) => {
    const all = Array.from(fileList || []);
    if (!all.length) return;
    const bad = all.filter((f) => !/\.(xlsx|xls)$/i.test(f.name));
    const good = all.filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    setItems((list) => {
      const have = new Set(list.map((x) => `${x.file.name}|${x.file.size}`));
      const fresh = good.filter((f) => !have.has(`${f.name}|${f.size}`))
        .map((f, i) => ({ id: `${Date.now()}-${i}-${f.name}`, file: f, status: 'pending' }));
      return [...list.filter((x) => x.status !== 'done'), ...fresh].slice(0, MAX_FILES);
    });
    if (bad.length) showError(`ข้ามไฟล์ที่ไม่ใช่ .xlsx/.xls: ${bad.map((f) => f.name).join(', ')}`);
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeItem = (id) => {
    setItems((list) => list.filter((x) => x.id !== id));
    if (selected === id) setSelected(null);
  };

  const formData = (file) => {
    const fd = new FormData();
    fd.append('mappingId', mappingId);
    fd.append('file', file);
    return fd;
  };

  const importable = (x) => x.status === 'checked' && x.preview && x.preview.missingRequired.length === 0 && x.preview.validRows > 0;

  /** ตรวจทุกไฟล์ทีละไฟล์ */
  const runPreview = async () => {
    setBusy(true);
    const targets = items.filter((x) => !['done', 'importing'].includes(x.status));
    for (const x of targets) {
      setItem(x.id, { status: 'checking', error: null });
      try {
        const { data } = await api.post('/imports/preview', formData(x.file));
        const ok = data.missingRequired.length === 0 && data.validRows > 0;
        setItem(x.id, { status: ok ? 'checked' : 'invalid', preview: data });
      } catch (err) {
        setItem(x.id, { status: 'invalid', preview: null, error: err.response?.data?.message || err.message });
      }
    }
    setBusy(false);
    if (targets.length === 1) setSelected(targets[0].id);
  };

  /** นำเข้าไฟล์ที่ตรวจผ่านทีละไฟล์ ไฟล์ที่ล้มเหลวไม่กระทบไฟล์อื่น */
  const runImport = async () => {
    const ready = items.filter(importable);
    const rows = ready.reduce((a, x) => a + x.preview.validRows, 0);
    const errs = ready.reduce((a, x) => a + x.preview.errorCount, 0);
    const ok = await confirmAction({
      title: `นำเข้า ${int(ready.length)} ไฟล์ (${int(rows)} รายการ)?`,
      text: `${errs ? `แถวที่มีปัญหา ${int(errs)} แถวจะไม่ถูกนำเข้า ` : ''}รายการที่เคยนำเข้าแล้วจะถูกอัปเดตเป็นข้อมูลล่าสุด`,
      confirmText: 'นำเข้า',
    });
    if (!ok) return;
    setBusy(true);
    let inserted = 0; let updated = 0; let failed = 0;
    for (const x of ready) {
      setItem(x.id, { status: 'importing' });
      try {
        const { data } = await api.post('/imports', formData(x.file));
        inserted += data.inserted; updated += data.updated;
        setItem(x.id, { status: 'done', result: data });
      } catch (err) {
        failed += 1;
        setItem(x.id, { status: 'failed', error: err.response?.data?.message || err.message });
      }
    }
    setBusy(false);
    loadHistory();
    notifyDataChanged();
    await (failed ? showError : showSuccess)(
      failed ? `นำเข้าไม่สำเร็จ ${int(failed)} ไฟล์` : 'นำเข้าแล้ว',
      `สำเร็จ ${int(ready.length - failed)} ไฟล์: เพิ่มใหม่ ${int(inserted)} รายการ, อัปเดตรายการเดิม ${int(updated)} รายการ`
        + (failed ? '<br>ดูสาเหตุในตารางรายการไฟล์' : ''),
    );
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
            ถ้าใช้คู่กับ REP ยอดที่ได้รับจะถูกนับซ้ำ ควรลบออกก่อนนำเข้า REP
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
            <select id="mapping" className="form-select" value={mappingId} disabled={busy}
              onChange={(e) => { setMappingId(e.target.value); setItems((l) => l.map((x) => ({ ...x, status: x.status === 'done' ? 'done' : 'pending', preview: null }))); setSelected(null); }}>
              {mappings.length === 0 && <option value="">ยังไม่มีรูปแบบไฟล์ OPD</option>}
              {mappings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="col-lg-8">
            <div
              className={`drop-zone ${drag ? 'drag' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) pickFiles(e.dataTransfer.files); }}
            >
              <i className="bi bi-files fs-3 muted" aria-hidden="true" />
              <div className="mt-1">
                ลากไฟล์มาวางที่นี่ได้หลายไฟล์พร้อมกัน หรือ{' '}
                <button type="button" className="btn btn-link p-0 align-baseline" disabled={busy} onClick={() => inputRef.current?.click()}>
                  เลือกไฟล์
                </button>
                <div className="small muted">สูงสุด {MAX_FILES} ไฟล์ต่อครั้ง</div>
              </div>
              <input ref={inputRef} type="file" accept=".xlsx,.xls" multiple hidden onChange={(e) => pickFiles(e.target.files)} />
            </div>
          </div>
        </div>

        {items.length > 0 && (
          <div className="table-wrap mt-3">
            <table className="table table-sm table-hover data-table clickable mb-0">
              <thead>
                <tr>
                  <SortTh k="name" sort={fileSort.sort} onSort={fileSort.toggle}>ไฟล์</SortTh><SortTh k="rep" sort={fileSort.sort} onSort={fileSort.toggle}>เลขที่ REP</SortTh><SortTh k="rows" sort={fileSort.sort} onSort={fileSort.toggle} className="num">แถว</SortTh><SortTh k="valid" sort={fileSort.sort} onSort={fileSort.toggle} className="num">นำเข้าได้</SortTh>
                  <SortTh k="errors" sort={fileSort.sort} onSort={fileSort.toggle} className="num">มีปัญหา</SortTh><SortTh k="status" sort={fileSort.sort} onSort={fileSort.toggle}>สถานะ</SortTh><th />
                </tr>
              </thead>
              <tbody>
                {fileSort.sorted.map((x) => {
                  const p = x.preview;
                  const fundMissing = p ? Object.values(p.fundColumns || {}).filter((f) => f.missing.length).length : 0;
                  return (
                    <tr key={x.id} className={selected === x.id ? 'table-active' : ''}
                      onClick={() => p && setSelected(x.id)} title={p ? 'ดูผลการตรวจไฟล์' : undefined}>
                      <td>{x.file.name}<div className="small-id">{(x.file.size / 1024).toFixed(0)} KB</div></td>
                      <td>{p?.stmDoc || <span className="muted">–</span>}</td>
                      <td className="num">{p ? int(p.totalRows) : '–'}</td>
                      <td className="num">{p ? int(p.validRows) : '–'}</td>
                      <td className={`num ${p?.errorCount ? 'text-danger' : ''}`}>{p ? int(p.errorCount) : '–'}</td>
                      <td className="small">
                        {x.status === 'pending' && <span className="muted">รอตรวจ</span>}
                        {x.status === 'checking' && <><span className="spinner-border spinner-border-sm me-1" />กำลังตรวจ</>}
                        {x.status === 'checked' && (
                          <span className="text-success"><i className="bi bi-check-circle me-1" />พร้อมนำเข้า
                            {fundMissing > 0 && <span className="text-warning-emphasis"> (ไม่พบคอลัมน์กองทุน {fundMissing})</span>}
                          </span>
                        )}
                        {x.status === 'invalid' && (
                          <span className="text-danger"><i className="bi bi-x-circle me-1" />
                            {x.error || (p?.missingRequired.length ? `ไม่พบคอลัมน์: ${p.missingRequired.join(', ')}` : 'ไม่มีรายการที่นำเข้าได้')}
                          </span>
                        )}
                        {x.status === 'importing' && <><span className="spinner-border spinner-border-sm me-1" />กำลังนำเข้า</>}
                        {x.status === 'done' && (
                          <span className="text-success"><i className="bi bi-check2-all me-1" />
                            นำเข้าแล้ว (ใหม่ {int(x.result.inserted)}, อัปเดต {int(x.result.updated)})
                          </span>
                        )}
                        {x.status === 'failed' && <span className="text-danger"><i className="bi bi-x-circle me-1" />{x.error}</span>}
                      </td>
                      <td className="text-end">
                        {!['checking', 'importing'].includes(x.status) && (
                          <button type="button" className="btn btn-sm btn-link text-danger" disabled={busy}
                            onClick={(e) => { e.stopPropagation(); removeItem(x.id); }} title="นำออกจากรายการ">
                            <i className="bi bi-x-lg" /><span className="visually-hidden">นำออก</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 d-flex flex-wrap gap-2 align-items-center">
          <button type="button" className="btn btn-outline-primary" disabled={busy || !mappingId || !items.some((x) => !['done'].includes(x.status))} onClick={runPreview}>
            <i className="bi bi-search me-1" />ตรวจไฟล์{items.length > 1 ? `ทั้งหมด (${items.filter((x) => x.status !== 'done').length})` : ''}
          </button>
          {items.some(importable) && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={runImport}>
              <i className="bi bi-check2 me-1" />
              นำเข้า {int(items.filter(importable).length)} ไฟล์ ({int(items.filter(importable).reduce((a, x) => a + x.preview.validRows, 0))} รายการ)
            </button>
          )}
          {items.length > 0 && (
            <button type="button" className="btn btn-link" disabled={busy} onClick={() => { setItems([]); setSelected(null); }}>ล้างรายการ</button>
          )}
          {items.some((x) => x.preview) && <span className="small muted ms-auto">คลิกแถวเพื่อดูผลการตรวจของไฟล์นั้น</span>}
        </div>
      </div>

      {preview && (
        <div className="panel">
          <div className="d-flex justify-content-between align-items-baseline">
            <div className="panel-title">ผลการตรวจไฟล์ {preview.fileName}</div>
            <button type="button" className="btn btn-sm btn-link" onClick={() => setSelected(null)}>ปิด</button>
          </div>
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
                  <SortTh k="created_at" sort={histSort.sort} onSort={histSort.toggle}>เวลา</SortTh><SortTh k="file_name" sort={histSort.sort} onSort={histSort.toggle}>ไฟล์</SortTh><SortTh k="stm_doc" sort={histSort.sort} onSort={histSort.toggle}>เลขที่ REP</SortTh><SortTh k="period" sort={histSort.sort} onSort={histSort.toggle}>ช่วงวันที่ในไฟล์</SortTh>
                  <SortTh k="inserted" sort={histSort.sort} onSort={histSort.toggle} className="num">เพิ่มใหม่</SortTh><SortTh k="updated" sort={histSort.sort} onSort={histSort.toggle} className="num">อัปเดต</SortTh><SortTh k="errors" sort={histSort.sort} onSort={histSort.toggle} className="num">ข้าม</SortTh>
                  <SortTh k="imported_by" sort={histSort.sort} onSort={histSort.toggle}>ผู้นำเข้า</SortTh><th />
                </tr>
              </thead>
              <tbody>
                {histSort.sorted.map((b) => (
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
