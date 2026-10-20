import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import Modal from './Modal.jsx';
import Pagination from './Pagination.jsx';
import PeriodFields from './PeriodFields.jsx';
import SortTh from './SortTh.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useSort, useSortState } from '../hooks/useSort.js';
import { confirmAction, notifySuccess, showError, showSuccess } from '../utils/alert.js';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { int, lastMonthRange, money, rangeErrorOf, thaiDate, thaiDateTime } from '../utils/format.js';
import { pullHosxpOpd } from '../utils/hosxp.js';

const PAGE_SIZE = 50;
const STATUS_STYLE = {
  MATCH:           { color: 'var(--st-matched)', icon: 'bi-check-circle' },
  NO_VISIT:        { color: 'var(--st-denied)',  icon: 'bi-person-x' },
  NO_CHARGE:       { color: 'var(--st-denied)',  icon: 'bi-receipt' },
  HIS_LESS:        { color: 'var(--st-denied)',  icon: 'bi-arrow-down-circle' },
  HIS_MORE:        { color: 'var(--st-diff)',    icon: 'bi-arrow-up-circle' },
  DENIED:          { color: 'var(--st-denied)',  icon: 'bi-x-octagon' },
  NOT_IN_REP:      { color: 'var(--st-diff)',    icon: 'bi-send-exclamation' },
  REP_DIFF:        { color: 'var(--st-diff)',    icon: 'bi-currency-exchange' },
  NOT_IN_REGISTRY: { color: 'var(--st-not-his)', icon: 'bi-journal-x' },
};

/* ---------- อัปโหลดทะเบียน: เลือกห้อง/แผนก ตอนอัปโหลด ไม่ต้องตั้งค่าล่วงหน้า ---------- */
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((c, i) => c === [...b].sort()[i]);

function UploadModal({ points, initialDepCodes, onClose, onDone }) {
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


/* ---------- ป๊อปอัปยอด HOSxP แยกตามห้อง (portal + fixed: ไม่ถูกกรอบเลื่อนของตารางตัด) ---------- */
const POP_W = 340;
function DeptPopover({ pop, depCodes, onEnter, onLeave, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const a = pop.rect; const h = el.offsetHeight; const vw = window.innerWidth; const vh = window.innerHeight;
    const left = Math.max(8, Math.min(a.right - POP_W, vw - POP_W - 8));
    const below = a.bottom + 6;
    const top = below + h > vh - 8 && a.top - h - 6 > 8 ? a.top - h - 6 : Math.min(below, Math.max(8, vh - h - 8));
    setPos({ left, top });
  }, [pop]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    const away = (e) => { if (pop.pinned && ref.current && !ref.current.contains(e.target) && !pop.anchor?.contains(e.target)) onClose(); };
    const gone = () => onClose();
    document.addEventListener('keydown', esc);
    document.addEventListener('mousedown', away);
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('keydown', esc); document.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', gone, true); window.removeEventListener('resize', gone);
    };
  }, [pop, onClose]);

  const r = pop.row;
  return createPortal(
    <div ref={ref} className="dept-pop" role="dialog" aria-label={`ค่าใช้จ่ายแยกตามห้อง VN ${r.vn}`}
      style={{ width: POP_W, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="dept-pop-head">ค่าใช้จ่ายใน HOSxP แยกตามห้อง <span className="small-id">VN {r.vn}</span></div>
      <BreakdownTable row={r} depCodes={depCodes} />
    </div>,
    document.body,
  );
}

function BreakdownTable({ row, depCodes }) {
  if (!row.breakdown?.length) return <div className="small muted">ไม่มีค่าใช้จ่ายใน visit นี้</div>;
  return (
    <table className="table table-sm mb-0 dept-table">
      <tbody>
        {row.breakdown.map((b) => {
          const mine = depCodes.includes(String(b.dep));
          return (
            <tr key={b.dep} className={mine ? 'mine' : ''}>
              <td>
                {b.name || `แผนก ${b.dep}`}
                {mine ? <span className="mine-tag">ห้องนี้</span>
                  : <div className="small-id">{b.point ? `ทะเบียน: ${b.point}` : 'ยังไม่มีทะเบียน'}</div>}
              </td>
              <td className="num">{money(b.amount)}</td>
            </tr>
          );
        })}
        <tr className="total"><td>รวมทั้ง visit</td><td className="num">{money(row.vn_total || 0)}</td></tr>
      </tbody>
    </table>
  );
}

/* ---------- รายละเอียดเมื่อคลิกแถว: 3 กล่อง + จุดที่ต่าง ---------- */
const noAmount = (r) => r.reg_amount === null || r.reg_amount === undefined;
const HIS_ISSUES = ['NO_VISIT', 'NO_CHARGE', 'HIS_LESS', 'HIS_MORE'];
const repProblem = (r) => !!r.vn && (!r.line_id || !!r.error_code || r.rep_status === 'DENIED'
  || Math.abs(Number(r.claim_amount || 0) - Number(r.vn_total || 0)) > 1);

function Field({ label, children }) {
  return <div className="d-flex justify-content-between gap-2"><span className="muted">{label}</span><span className="text-end">{children}</span></div>;
}
function Box({ title, icon, bad, children }) {
  return (
    <div className={`src-box ${bad === null ? 'na' : bad ? 'bad' : 'ok'}`}>
      <div className="src-box-head"><i className={`bi ${icon} me-1`} />{title}
        {bad !== null && <i className={`bi ${bad ? 'bi-exclamation-circle-fill' : 'bi-check-circle-fill'} ms-auto`} aria-label={bad ? 'มีจุดที่ต่าง' : 'ปกติ'} />}
      </div>
      {children}
    </div>
  );
}

function RowDetail({ r, depCodes }) {
  return (
    <div className="row-detail">
      <div className="src-boxes">
        <Box title="ทะเบียน" icon="bi-journal-text" bad={r.status === 'NOT_IN_REGISTRY'}>
          {r.src !== 'REG' ? (
            <p className="small mb-0">ไม่มีในทะเบียน<span className="d-block muted">ถ้าคนไข้มารับบริการที่ห้องนี้จริง ให้เพิ่มในทะเบียนแล้วอัปโหลดใหม่</span></p>
          ) : (
            <div className="small">
              <Field label="วันที่">{thaiDate(r.sdate)}</Field>
              <Field label="HN">{r.hn || '–'}</Field>
              {r.cid && <Field label="เลขบัตร">{r.cid}</Field>}
              <Field label="ยอดรวม">{noAmount(r) ? <span className="muted">ไม่มียอด (เทียบว่ามีค่าใช้จ่ายไหม)</span> : `${money(r.reg_amount)} บาท`}</Field>
              {r.reg_rows > 1 && <Field label="จำนวนแถว">{r.reg_rows} แถว{noAmount(r) ? '' : ' (รวมยอดแล้ว)'}</Field>}
            </div>
          )}
        </Box>
        <Box title="HOSxP" icon="bi-hospital" bad={HIS_ISSUES.includes(r.status)}>
          {!r.vn ? (
            <p className="small mb-0">ไม่พบ visit วันนี้<span className="d-block muted">ตรวจ HN และวันที่ในทะเบียน หรือดึงข้อมูล HOSxP ช่วงนี้ใหม่</span></p>
          ) : (
            <>
              <div className="small mb-1"><Field label="VN">{r.vn}</Field></div>
              <BreakdownTable row={r} depCodes={depCodes} />
            </>
          )}
        </Box>
        <Box title="REP (e-Claim)" icon="bi-cloud-check" bad={r.vn ? repProblem(r) : null}>
          {!r.vn ? <p className="small muted mb-0">เทียบไม่ได้ เพราะไม่พบ visit</p>
            : !r.line_id ? (
              <p className="small mb-0">ยังไม่พบใน REP<span className="d-block muted">ยังไม่ได้ส่งเบิก หรือรอผลรอบถัดไป</span></p>
            ) : (
              <div className="small">
                {r.tran_id && <Field label="TRAN_ID">{r.tran_id}</Field>}
                <Field label="เรียกเก็บ (REP)">{money(r.claim_amount)}</Field>
                <Field label="ได้รับ (REP)">{money(r.compensated)}</Field>
                {r.error_code && (
                  <div className="err-block">
                    <div className="fw-semibold">ติด {r.error_code}</div>
                    {r.error_detail && r.error_detail.split('\n').map((l) => <div key={l}>{l}</div>)}
                    {r.error_guidance && (
                      <div className="mt-1"><span className="fw-semibold">แนวทางแก้: </span>
                        {r.error_guidance.split('\n').map((l) => <div key={l}>{l}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
        </Box>
      </div>
      {r.status === 'MATCH' ? (
        <div className="small text-success mt-2"><i className="bi bi-check-circle me-1" />ตรงกันครบ 3 แหล่ง</div>
      ) : (
        <div className="small mt-2">
          <span className="fw-semibold">จุดที่ต่าง</span>
          <ul className="mb-0 ps-3">{(r.issues || []).map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/* ---------- เทียบ 3 แหล่ง: ทะเบียนห้อง/แผนก ---------- */
export default function PointCompare() {
  const { user, isAdmin } = useAuth();
  const [points, setPoints] = useState([]);
  const [code, setCode] = useState('');
  const [range, setRange] = useState(lastMonthRange());
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [upload, setUpload] = useState(false);
  const [open, setOpen] = useState(null);           // แถวที่ขยายดูรายละเอียด
  const [pop, setPop] = useState(null);             // ป๊อปอัปยอดแยกห้อง { key, row, rect, anchor, pinned }
  const popTimer = useRef(null);
  const [batches, setBatches] = useState([]);
  const [showBatches, setShowBatches] = useState(false);
  const [sort, toggleSort] = useSortState();
  const onSort = (k) => { toggleSort(k); setPage(1); };
  const batchSort = useSort(batches, { key: 'created_at', dir: 'desc' });

  const [pointsLoaded, setPointsLoaded] = useState(false);
  const loadPoints = useCallback((select) => api.get('/points').then((r) => {
    const list = r.data.filter((p) => p.is_active);
    setPoints(list);
    setCode((cur) => {
      if (select && list.some((p) => p.code === select)) return select;
      if (cur && list.some((p) => p.code === cur)) return cur;
      // ห้องที่ผู้ใช้เคยอัปโหลดล่าสุดก่อน แล้วห้องที่ถูกกำหนดให้ มิฉะนั้นห้องแรก
      const mine = list.filter((p) => p.mine).sort((a, b) => String(b.my_last_upload || '').localeCompare(String(a.my_last_upload || '')))[0];
      return mine?.code || list[0]?.code || '';
    });
    setPointsLoaded(true);
  }).catch(showError), []);
  useEffect(() => { loadPoints(); }, [loadPoints]);

  const point = points.find((p) => p.code === code);
  const depCodes = useMemo(() => (point?.dep_codes || []).map(String), [point]);
  const rangeError = rangeErrorOf(range);
  const params = useMemo(() => ({
    ...range, status: status || undefined, search: search || undefined,
    sort: sort.key || undefined, dir: sort.key ? sort.dir : undefined,
  }), [range, status, search, sort]);

  const load = useCallback(() => {
    if (!code || rangeError) return;
    setLoading(true);
    api.get(`/points/${code}/compare`, { params: { ...params, page, pageSize: PAGE_SIZE } })
      .then((r) => setData(r.data)).catch((err) => showError(err, 'เทียบข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
    api.get(`/points/${code}/batches`).then((r) => setBatches(r.data)).catch(() => {});
  }, [code, params, page, rangeError]);
  useEffect(() => { load(); setOpen(null); setPop(null); }, [load]);

  /* ป๊อปอัป: ชี้ = แสดงชั่วคราว, กด = ปักไว้ (กดอีกครั้งหรือกดที่อื่นเพื่อปิด) */
  const cancelClose = () => clearTimeout(popTimer.current);
  const closePop = useCallback(() => { clearTimeout(popTimer.current); setPop(null); }, []);
  const laterClose = () => { cancelClose(); popTimer.current = setTimeout(() => setPop((p) => (p?.pinned ? p : null)), 180); };
  const showPop = (e, key, row, pinned = false) => {
    cancelClose();
    const anchor = e.currentTarget;
    setPop((p) => (p?.key === key && p.pinned && !pinned ? p : { key, row, rect: anchor.getBoundingClientRect(), anchor, pinned }));
  };
  const togglePop = (e, key, row) => {
    e.stopPropagation();
    if (pop?.key === key && pop.pinned) closePop(); else showPop(e, key, row, true);
  };
  useEffect(() => () => clearTimeout(popTimer.current), []);

  const exportUrl = `/api/points/${code}/compare/export?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined))}`;
  const removeBatch = async (b) => {
    if (!(await confirmAction({ title: 'ลบการอัปโหลดนี้?', text: b.file_name, confirmText: 'ลบ', danger: true }))) return;
    try { await api.delete(`/points/batches/${b.id}`); notifySuccess('ลบแล้ว'); notifyDataChanged(); load(); } catch (err) { showError(err); }
  };

  const modal = upload && (
    <UploadModal points={points} initialDepCodes={depCodes}
      onClose={() => setUpload(false)}
      onDone={(pointCode) => { setUpload(false); loadPoints(pointCode).then(() => load()); }} />
  );

  if (pointsLoaded && !points.length) {
    return (
      <>
        <div className="panel text-center py-4">
          <i className="bi bi-journal-arrow-up fs-1 muted" aria-hidden="true" />
          <h2 className="h5 mt-2">เริ่มจากอัปโหลดทะเบียนของห้อง/แผนก</h2>
          <p className="muted mx-auto" style={{ maxWidth: 560 }}>
            เลือกไฟล์ทะเบียน แล้วเลือกห้อง/แผนกในหน้าต่างอัปโหลด ไม่ต้องตั้งค่าอะไรล่วงหน้า
            ระบบสร้างให้เอง แล้วเทียบกับ HOSxP และ REP ให้ทันที
          </p>
          <div className="d-flex justify-content-center gap-2">
            <a className="btn btn-outline-secondary" href="/api/points/template"><i className="bi bi-file-earmark-arrow-down me-1" />แม่แบบทะเบียน</a>
            <button type="button" className="btn btn-primary" onClick={() => setUpload(true)}><i className="bi bi-upload me-1" />อัปโหลดทะเบียน</button>
          </div>
        </div>
        {modal}
      </>
    );
  }
  if (!pointsLoaded) return <div className="text-center py-5"><span className="spinner-border text-secondary" /></div>;

  const t = data?.totals;
  const totalRows = data ? Object.values(data.summary).reduce((a, b) => a + b, 0) : 0;
  const chips = data ? Object.entries(data.statuses).filter(([k]) => data.summary[k] > 0 || status === k) : [];
  const setFilter = (k) => { setStatus(k); setPage(1); };
  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <p className="muted small mb-0">ทะเบียนของห้อง/แผนก เทียบกับ HOSxP (เฉพาะค่าใช้จ่ายของห้องนี้) และ REP (ทั้ง visit)</p>
        <div className="d-flex flex-wrap gap-2">
          <a className="btn btn-sm btn-outline-secondary" href="/api/points/template">
            <i className="bi bi-file-earmark-arrow-down me-1" />แม่แบบทะเบียน
          </a>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setUpload(true)}>
            <i className="bi bi-upload me-1" />อัปโหลดทะเบียน
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="row g-3 align-items-end">
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="pc-point">ห้อง/แผนก</label>
            <select id="pc-point" className="form-select" value={code} onChange={(e) => { setCode(e.target.value); setStatus(''); setPage(1); }}>
              {points.map((p) => (
                <option key={p.code} value={p.code}>{p.name}{p.mine ? ' ★' : ''}</option>
              ))}
            </select>
          </div>
          <PeriodFields idPrefix="pc" value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="pc-q">ค้นหา</label>
            <form className="input-group" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
              <input id="pc-q" className="form-control" placeholder="HN, ชื่อ, VN" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
              <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
            </form>
          </div>
        </div>
        {rangeError && <div className="text-danger small mt-2">{rangeError}</div>}
      </div>

      {data?.noDepCodes && (
        <div className="alert alert-warning py-2">
          ห้อง/แผนกนี้ยังไม่ได้ผูกกับรหัสแผนก (dep_code) ใน HOSxP จึงไม่มียอดฝั่ง HOSxP ให้เทียบ
          {isAdmin && <> <Link to="/points/settings">จัดการห้อง/แผนก</Link></>}
        </div>
      )}
      {data?.stale && (
        <div className="alert alert-warning py-2 d-flex flex-wrap align-items-center gap-2">
          <i className="bi bi-arrow-repeat" />
          <span className="me-auto">ทะเบียนถูกอัปโหลดหลังดึงข้อมูล HOSxP ครั้งล่าสุด ควรดึงข้อมูลช่วงนี้ใหม่</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={async () => { if (await pullHosxpOpd(range)) load(); }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
        </div>
      )}
      {data && data.registryRows === 0 && (
        <div className="alert alert-info py-2 d-flex align-items-center gap-2">
          <i className="bi bi-info-circle" />
          <span className="me-auto">ยังไม่มีทะเบียนของ {point?.name} ในช่วงนี้ ทุก visit ที่มีค่าใช้จ่ายของห้องนี้จะขึ้นว่า “ไม่อยู่ในทะเบียน”</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setUpload(true)}>อัปโหลดทะเบียน</button>
        </div>
      )}

      <div className="panel">
        {t && (
          <div className="cmp-strip" aria-label="ยอดรวม">
            <span className="item"><span className="lbl"><i className="bi bi-journal-text" />ทะเบียน</span>
              <strong>{t.registryCount && t.registryNoAmount === t.registryCount ? 'ไม่มียอด' : money(t.registry)}</strong>
              {t.registryNoAmount > 0 && t.registryNoAmount < t.registryCount && <span className="sub">(ไม่มียอด {int(t.registryNoAmount)} ราย)</span>}
            </span>
            <span className="item" title={`HOSxP ทั้ง visit ${money(t.hisVisit)} บาท`}><span className="lbl"><i className="bi bi-hospital" />HOSxP ห้องนี้</span>
              <strong>{money(t.hisPoint)}</strong></span>
            <span className="item"><span className="lbl"><i className="bi bi-cloud-check" />REP เรียกเก็บ / ได้รับ</span>
              <strong>{money(t.repClaim)}</strong><span className="sep">/</span><strong className="paid">{money(t.repPaid)}</strong></span>
            <span className="unit">บาท</span>
          </div>
        )}

        {data && (
          <div className="cmp-pills" role="group" aria-label="กรองตามผลการเทียบ">
            <button type="button" className={`cmp-pill ${!status ? 'active' : ''}`} onClick={() => setFilter('')}>
              ทั้งหมด <span className="n">{int(totalRows)}</span>
            </button>
            {chips.map(([k, s]) => (
              <button key={k} type="button" className={`cmp-pill ${status === k ? 'active' : ''}`}
                style={{ '--c': STATUS_STYLE[k]?.color }} onClick={() => setFilter(status === k ? '' : k)} aria-pressed={status === k}>
                <i className={`bi ${STATUS_STYLE[k]?.icon}`} />{s.label} <span className="n">{int(data.summary[k])}</span>
              </button>
            ))}
            <span className="ms-auto d-flex align-items-center gap-2">
              {loading && <span className="spinner-border spinner-border-sm text-secondary" />}
              <a className={`btn btn-sm btn-outline-secondary ${data?.total ? '' : 'disabled'}`} href={exportUrl}>
                <i className="bi bi-file-earmark-excel me-1" />Excel
              </a>
            </span>
          </div>
        )}

        <div className="table-wrap">
          <table className="table data-table cmp3-table">
            <thead>
              <tr>
                <SortTh k="sdate" sort={sort} onSort={onSort}>วันที่</SortTh>
                <SortTh k="hn" sort={sort} onSort={onSort}>คนไข้</SortTh>
                <SortTh k="registry" sort={sort} onSort={onSort} className="num">ทะเบียน</SortTh>
                <SortTh k="his" sort={sort} onSort={onSort} className="num" title="ยอดของห้องนี้ ชี้หรือกดที่ยอดเพื่อดูแยกตามห้อง">HOSxP</SortTh>
                <SortTh k="rep" sort={sort} onSort={onSort} className="num" title="เรียกเก็บ (REP) ตัวเล็กคือได้รับ (REP)">REP</SortTh>
                <SortTh k="status" sort={sort} onSort={onSort}>ผลการเทียบ</SortTh>
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && <tr><td colSpan={6} className="text-center muted py-4">ไม่มีรายการ</td></tr>}
              {data?.rows.map((r, i) => {
                const key = `${r.src}-${r.reg_id || ''}-${r.vn || ''}-${i}`;
                const st = STATUS_STYLE[r.status] || {};
                const isOpen = open === key;
                const toggle = () => setOpen(isOpen ? null : key);
                const more = (r.issues?.length || 0) - 1;
                return (
                  <Fragment key={key}>
                    <tr className={`cmp-row ${isOpen ? 'open' : ''}`} onClick={toggle} tabIndex={0} aria-expanded={isOpen}
                      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}>
                      <td className="text-nowrap">{thaiDate(r.sdate)}</td>
                      <td className="pt-cell"><span className="hn">{r.hn || '–'}</span><div className="small-id text-truncate">{r.patient_name}</div></td>
                      <td className="num">
                        {r.src !== 'REG' ? <span className="muted small">ไม่มี</span>
                          : noAmount(r) ? <span className="muted small" title="ทะเบียนไม่มียอดเงิน เทียบเฉพาะว่ามีค่าใช้จ่ายของห้องนี้ใน HOSxP">ไม่มียอด</span>
                            : money(r.reg_amount)}
                      </td>
                      <td className="num">
                        {!r.vn ? <span className="muted small">ไม่พบ visit</span> : (
                          <>
                            <button type="button" className={`amt-btn ${pop?.key === key ? 'on' : ''}`} aria-haspopup="dialog"
                              aria-label={`ยอด HOSxP ห้องนี้ ${money(r.point_amount || 0)} บาท ดูแยกตามห้อง`}
                              onMouseEnter={(e) => showPop(e, key, r)} onMouseLeave={laterClose}
                              onFocus={(e) => showPop(e, key, r)} onBlur={laterClose}
                              onClick={(e) => togglePop(e, key, r)}>
                              {money(r.point_amount || 0)}
                            </button>
                            {Math.abs(Number(r.vn_total || 0) - Number(r.point_amount || 0)) > 0.005 && (
                              <div className="small-id">ทั้ง visit {money(r.vn_total || 0)}</div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="num">
                        {r.line_id ? (<>{money(r.claim_amount)}<div className="small-id">ได้รับ {money(r.compensated)}</div></>)
                          : <span className="muted small">{r.vn ? 'ยังไม่พบ' : '–'}</span>}
                      </td>
                      <td className="result-cell">
                        <div className="d-flex align-items-start gap-2">
                          <div className="min-w-0 flex-grow-1">
                            <span className="cmp-badge" style={{ '--c': st.color }}><i className={`bi ${st.icon}`} />{data.statuses[r.status]?.label}</span>
                            {r.status !== 'MATCH' && r.issues?.[0] && (
                              <div className="reason" title={r.issues.join('\n')}>
                                {r.issues[0]}{more > 0 && <span className="more">+{more}</span>}
                              </div>
                            )}
                          </div>
                          <i className={`bi ${isOpen ? 'bi-chevron-up' : 'bi-chevron-down'} muted chev`} aria-hidden="true" />
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="detail-row"><td colSpan={6}><RowDetail r={r} depCodes={depCodes} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && (
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
            <span className="small muted">{int(data.total)} รายการ · คลิกแถวเพื่อดูรายละเอียด · ชี้ยอด HOSxP เพื่อดูแยกตามห้อง</span>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </div>
        )}
      </div>
      {pop && <DeptPopover pop={pop} depCodes={depCodes} onEnter={cancelClose} onLeave={laterClose} onClose={closePop} />}

      <div className="panel">
        <button type="button" className="btn btn-link p-0" onClick={() => setShowBatches((v) => !v)}>
          <i className={`bi ${showBatches ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`} />ประวัติอัปโหลดทะเบียน {point?.name} ({batches.length})
        </button>
        {showBatches && (
          <div className="table-wrap mt-2">
            <table className="table table-sm data-table mb-0">
              <thead>
                <tr>
                  <SortTh k="created_at" sort={batchSort.sort} onSort={batchSort.toggle}>เวลา</SortTh>
                  <SortTh k="file_name" sort={batchSort.sort} onSort={batchSort.toggle}>ไฟล์</SortTh>
                  <SortTh k="date_from" sort={batchSort.sort} onSort={batchSort.toggle}>ช่วงวันที่</SortTh>
                  <SortTh k="valid_rows" sort={batchSort.sort} onSort={batchSort.toggle} className="num">นำเข้า</SortTh>
                  <SortTh k="current_rows" sort={batchSort.sort} onSort={batchSort.toggle} className="num">ยังใช้อยู่</SortTh>
                  <SortTh k="uploaded_by_name" sort={batchSort.sort} onSort={batchSort.toggle}>ผู้อัปโหลด</SortTh>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batchSort.sorted.map((b) => (
                  <tr key={b.id}>
                    <td className="text-nowrap">{thaiDateTime(b.created_at)}</td>
                    <td>{b.file_name}</td>
                    <td className="text-nowrap">{thaiDate(b.date_from)} – {thaiDate(b.date_to)}</td>
                    <td className="num">{int(b.valid_rows)}</td>
                    <td className="num">{b.current_rows ? int(b.current_rows) : <span className="muted">ถูกแทนที่</span>}</td>
                    <td>{b.uploaded_by_name || '–'}</td>
                    <td className="text-end">
                      {(isAdmin || b.uploaded_by === user.id) && (
                        <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeBatch(b)} title="ลบ">
                          <i className="bi bi-trash" /><span className="visually-hidden">ลบ</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {batches.length === 0 && <tr><td colSpan={7} className="muted text-center">ยังไม่มีการอัปโหลด</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal}
    </>
  );
}
