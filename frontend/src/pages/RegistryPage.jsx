import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import Pagination from '../components/Pagination.jsx';
import PeriodFields from '../components/PeriodFields.jsx';
import SortTh from '../components/SortTh.jsx';
import { FundUploadModal, MatchItemsModal, PointUploadModal, UploadChooser } from '../components/RegistryUploads.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useSort, useSortState } from '../hooks/useSort.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { int, lastMonthRange, money, rangeErrorOf, thaiDate, thaiDateTime } from '../utils/format.js';
import { pullHosxpOpd } from '../utils/hosxp.js';

/* =====================================================================
 * เทียบ 3 แหล่ง (หน้าเดียว): ทุกทะเบียน (ห้อง/แผนก และกองทุน) เทียบกับ HOSxP และ REP
 * หนึ่งแถว = หนึ่ง visit ไม่ต้องเลือกห้องหรือกองทุน
 * ===================================================================== */
const PAGE_SIZE = 50;
const STATUS_STYLE = {
  NO_VISIT:        { color: 'var(--st-denied)',  icon: 'bi-person-x' },
  UNKNOWN_ITEM:    { color: 'var(--st-multiple)', icon: 'bi-question-circle' },
  HIS_DIFF:        { color: 'var(--st-denied)',  icon: 'bi-arrow-left-right' },
  NOT_IN_REGISTRY: { color: 'var(--st-not-his)', icon: 'bi-journal-x' },
  DENIED:          { color: 'var(--st-denied)',  icon: 'bi-x-octagon' },
  NOT_IN_REP:      { color: 'var(--st-diff)',    icon: 'bi-send-exclamation' },
  REP_DIFF:        { color: 'var(--st-diff)',    icon: 'bi-currency-exchange' },
  NOT_PAID:        { color: 'var(--st-diff)',    icon: 'bi-cash' },
  MATCH:           { color: 'var(--st-matched)', icon: 'bi-check-circle' },
};
/** สถานะของแต่ละทะเบียนเทียบกับ HOSxP */
const TAG_STYLE = {
  MATCH:           { cls: 'ok',      icon: 'bi-check-lg',          text: 'ตรงกับ HOSxP' },
  HIS_DIFF:        { cls: 'bad',     icon: 'bi-exclamation-lg',    text: 'ไม่ตรงกับ HOSxP' },
  NOT_IN_REGISTRY: { cls: 'missing', icon: 'bi-dash-lg',           text: 'มีใน HOSxP แต่ไม่อยู่ในทะเบียน' },
  NO_VISIT:        { cls: 'bad',     icon: 'bi-x-lg',              text: 'ไม่พบ visit ใน HOSxP' },
  UNKNOWN_ITEM:    { cls: 'unknown', icon: 'bi-question-lg',       text: 'ต้องจับคู่ชื่อรายการ' },
};
/** สถานะทะเบียนของแต่ละห้องในป๊อปอัปแยกห้อง */
const DEP_REG = {
  ok:      { cls: 'ok',      text: 'ตรงทะเบียน' },
  diff:    { cls: 'bad',     text: 'ไม่ตรงทะเบียน' },
  missing: { cls: 'missing', text: 'ไม่อยู่ในทะเบียน' },
  none:    { cls: 'none',    text: 'ไม่มีทะเบียน' },
};

/* ---------- ป๊อปอัปค่าใช้จ่ายแยกตามห้อง (portal + fixed: ไม่ถูกกรอบเลื่อนของตารางตัด) ---------- */
const POP_W = 360;
function DeptPopover({ pop, onEnter, onLeave, onClose }) {
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
      <BreakdownTable row={r} />
    </div>,
    document.body,
  );
}

/**
 * ค่าใช้จ่ายแยกตามห้อง: แผนกที่ผูกกับห้อง/แผนกเดียวกันอยู่กลุ่มเดียวกัน
 * สถานะทะเบียนแสดงครั้งเดียวต่อห้อง (เทียบยอดรวมของห้องกับทะเบียน)
 */
function BreakdownTable({ row }) {
  if (!row.breakdown?.length) return <div className="small muted">ไม่มีค่าใช้จ่ายใน visit นี้</div>;
  return (
    <table className="table table-sm mb-0 dept-table">
      <tbody>
        {row.breakdown.map((g) => {
          const st = DEP_REG[g.reg] || DEP_REG.none;
          const grouped = g.code && (g.deps.length > 1 || g.reg !== 'none');
          const optNote = (amt) => (amt > 0 ? <div className="small-id">ค่าบริการอัตโนมัติ {money(amt)}</div> : null);
          if (!grouped) {
            const d = g.deps[0];
            return (
              <tr key={`d-${d.dep}`}>
                <td>{d.name || `แผนก ${d.dep}`}{optNote(d.optional_amount)}</td>
                <td className="num">{money(d.amount)}</td>
                <td className="reg-cell"><span className={`reg-state ${st.cls}`}>{st.text}</span></td>
              </tr>
            );
          }
          return (
            <Fragment key={`p-${g.code}`}>
              <tr className="room-head">
                <td>
                  {g.name}
                  <div className="small-id">
                    {g.reg_amount !== null ? `ทะเบียน ${money(g.reg_amount)}` : g.reg === 'missing' ? 'ไม่อยู่ในทะเบียน' : g.reg === 'none' ? 'ไม่มีทะเบียน' : 'ทะเบียนไม่มียอด'}
                    {g.note?.includes('ไม่รวม') && ' (ไม่รวมค่าบริการอัตโนมัติ)'}
                  </div>
                </td>
                <td className="num">{money(g.amount)}</td>
                <td className="reg-cell"><span className={`reg-state ${st.cls}`}>{st.text}</span></td>
              </tr>
              {g.deps.map((d) => (
                <tr key={d.dep} className="room-dep">
                  <td>{d.name || `แผนก ${d.dep}`}{optNote(d.optional_amount)}</td>
                  <td className="num">{money(d.amount)}</td>
                  <td />
                </tr>
              ))}
            </Fragment>
          );
        })}
        <tr className="total"><td>รวมทั้ง visit</td><td className="num">{money(row.vn_total || 0)}</td><td /></tr>
      </tbody>
    </table>
  );
}

/* ---------- ป้ายทะเบียนในตาราง ---------- */
function RegTags({ r }) {
  return (
    <div className="reg-tags">
      {r.registries.map((t) => {
        const st = TAG_STYLE[t.status] || TAG_STYLE.MATCH;
        return (
          <span key={`${t.kind}-${t.code}`} className={`reg-tag ${st.cls}`} title={`${t.full}: ${st.text}`}>
            <i className={`bi ${st.icon}`} aria-hidden="true" />{t.name}
            {t.inRegistry && t.amount !== null && <span className="amt">{money(t.amount)}</span>}
            {!t.inRegistry && <span className="amt">ไม่อยู่ในทะเบียน</span>}
          </span>
        );
      })}
    </div>
  );
}

/* ---------- รายละเอียดเมื่อคลิกแถว ---------- */
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

function RegistryBox({ r }) {
  const bad = r.registries.some((t) => t.status !== 'MATCH');
  return (
    <Box title="ทะเบียน" icon="bi-journal-text" bad={bad}>
      {r.registries.map((t) => {
        const st = TAG_STYLE[t.status] || TAG_STYLE.MATCH;
        return (
          <div key={`${t.kind}-${t.code}`} className="reg-entry small">
            <div className="d-flex align-items-center gap-1 fw-semibold">
              <span className={`reg-dot ${st.cls}`} aria-hidden="true" />{t.full}
            </div>
            {t.kind === 'point' ? (
              <>
                <Field label="ทะเบียน">{!t.inRegistry ? 'ไม่อยู่ในทะเบียน' : t.amount === null ? <span className="muted">ไม่มียอด</span> : `${money(t.amount)} บาท`}</Field>
                <Field label="HOSxP ห้องนี้">{t.his_amount === null ? '–' : `${money(t.his_amount)} บาท`}</Field>
                {t.optional_amount > 0 && (
                  <Field label="ไม่นับค่าบริการอัตโนมัติ">{money(t.his_amount - t.optional_amount)} บาท</Field>
                )}
                {t.note && <div className="text-success-emphasis"><i className="bi bi-info-circle me-1" />{t.note}</div>}
              </>
            ) : (
              <table className="table table-sm mb-0 item-table">
                <thead><tr><th>รายการ</th><th className="num">ทะเบียน</th><th className="num">HOSxP</th></tr></thead>
                <tbody>
                  {t.items.map((it, i) => (
                    <tr key={`${it.icode || it.item}-${i}`}>
                      <td>{it.item}{!it.inRegistry && <span className="muted"> (ไม่อยู่ในทะเบียน)</span>}</td>
                      <td className="num" title="ทะเบียน">{it.reg_price === null ? '–' : money(it.reg_price)}</td>
                      <td className="num" title="HOSxP">{it.his_amount !== null ? money(it.his_amount) : <span className="text-danger-emphasis wrap-note">{it.his_note || '–'}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {t.status !== 'MATCH' && (
              <div className="entry-issue">
                <span className="fw-semibold">{t.label}</span>
                {t.issues.map((x) => <div key={x}>{x}</div>)}
              </div>
            )}
          </div>
        );
      })}
    </Box>
  );
}

/** เหตุผลที่กล่องขึ้นสีแดง (ใส่ไว้ในกล่องเลย ไม่ต้องเลื่อนลงไปดูด้านล่าง) */
function BoxReason({ items }) {
  if (!items.length) return null;
  return <div className="entry-issue mb-2">{items.map((x) => <div key={x}>{x}</div>)}</div>;
}

function RowDetail({ r }) {
  return (
    <div className="row-detail">
      <div className="src-boxes">
        <RegistryBox r={r} />
        <Box title="HOSxP" icon="bi-hospital" bad={r.vn ? r.registries.some((t) => ['HIS_DIFF', 'NO_VISIT'].includes(t.status)) : true}>
          {!r.vn ? (
            <p className="small mb-0">ไม่พบ visit วันนี้<span className="d-block muted">ตรวจ HN และวันที่ในทะเบียน หรือดึงข้อมูล HOSxP ช่วงนี้ใหม่</span></p>
          ) : (
            <>
              <BoxReason items={r.registries.filter((t) => ['HIS_DIFF', 'NO_VISIT'].includes(t.status))
                .flatMap((t) => t.issues.map((x) => `${t.name}: ${x}`))} />
              <div className="small mb-1">
                <Field label="VN">{r.vn}</Field>
                {r.pttype_name && <Field label="สิทธิ">{r.pttype_name}</Field>}
              </div>
              <BreakdownTable row={r} />
            </>
          )}
        </Box>
        <Box title="REP (e-Claim)" icon="bi-cloud-check" bad={r.vn ? !!r.rep_status : null}>
          {r.rep && <BoxReason items={r.issues.filter((x) => x.startsWith('REP: ')).map((x) => x.slice(5))} />}
          {r.vn && <div className="small"><Field label="เรียกเก็บ (HOSxP)">{money(r.uc_money)}</Field></div>}
          {!r.vn ? <p className="small muted mb-0">เทียบไม่ได้ เพราะไม่พบ visit</p>
            : !r.rep ? (
              <p className="small mb-0">ยังไม่พบใน REP<span className="d-block muted">ยังไม่ได้ส่งเบิก รอผลรอบถัดไป หรือยังไม่ได้นำเข้าไฟล์ REP ที่มีรายการนี้</span></p>
            ) : (
              <div className="small">
                <Field label="เรียกเก็บ (REP)">{money(r.rep.claim_amount)}</Field>
                <Field label="ได้รับ (REP)">{money(r.rep.compensated)}</Field>
                {r.rep.tran_id && <Field label="TRAN_ID">{r.rep.tran_id}</Field>}
                {r.rep.error_code && (
                  <div className="err-block">
                    <div className="fw-semibold">ติด {r.rep.error_code}</div>
                    {r.rep.error_detail && r.rep.error_detail.split('\n').map((l) => <div key={l}>{l}</div>)}
                    {r.rep.error_guidance && (
                      <div className="mt-1"><span className="fw-semibold">แนวทางแก้: </span>
                        {r.rep.error_guidance.split('\n').map((l) => <div key={l}>{l}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          {r.vn && (
            <Link className="small d-inline-block mt-2" to={`/recon/opd?${new URLSearchParams({ q: r.vn, dateFrom: r.sdate, dateTo: r.sdate })}`}>
              <i className="bi bi-box-arrow-up-right me-1" />ดูในกระทบยอด OPD
            </Link>
          )}
        </Box>
      </div>
      {r.status === 'MATCH' ? (
        <div className="small text-success mt-2"><i className="bi bi-check-circle me-1" />ตรงกันครบ 3 แหล่ง</div>
      ) : (
        <div className="small mt-2">
          <span className="fw-semibold">จุดที่ต่าง</span>
          <ul className="mb-0 ps-3">{r.issues.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/* ---------- ประวัติอัปโหลด (ทุกชนิดรวมกัน) ---------- */
function UploadHistory({ uploads, onRemove }) {
  const { user, isAdmin } = useAuth();
  const [show, setShow] = useState(false);
  const s = useSort(uploads, { key: 'created_at', dir: 'desc' });
  return (
    <div className="panel">
      <button type="button" className="btn btn-link p-0" onClick={() => setShow((v) => !v)}>
        <i className={`bi ${show ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`} />ประวัติอัปโหลดทะเบียน ({uploads.length})
      </button>
      {show && (
        <div className="table-wrap mt-2">
          <table className="table table-sm data-table mb-0">
            <thead>
              <tr>
                <SortTh k="created_at" sort={s.sort} onSort={s.toggle}>เวลา</SortTh>
                <SortTh k="target_name" sort={s.sort} onSort={s.toggle}>ทะเบียน</SortTh>
                <SortTh k="file_name" sort={s.sort} onSort={s.toggle}>ไฟล์</SortTh>
                <SortTh k="date_from" sort={s.sort} onSort={s.toggle}>ช่วงวันที่</SortTh>
                <SortTh k="current_rows" sort={s.sort} onSort={s.toggle} className="num">ใช้อยู่</SortTh>
                <SortTh k="uploaded_by_name" sort={s.sort} onSort={s.toggle}>ผู้อัปโหลด</SortTh>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.sorted.map((b) => (
                <tr key={`${b.kind}-${b.id}`}>
                  <td className="text-nowrap">{thaiDateTime(b.created_at)}</td>
                  <td>{b.kind === 'fund' ? `กองทุน ${b.target_code}` : b.target_name || b.target_code}</td>
                  <td>{b.file_name}</td>
                  <td className="text-nowrap">{thaiDate(b.date_from)} – {thaiDate(b.date_to)}</td>
                  <td className="num">{b.current_rows ? int(b.current_rows) : <span className="muted">ถูกแทนที่</span>}</td>
                  <td>{b.uploaded_by_name || '–'}</td>
                  <td className="text-end">
                    {(isAdmin || b.uploaded_by === user.id) && (
                      <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => onRemove(b)} title="ลบ">
                        <i className="bi bi-trash" /><span className="visually-hidden">ลบ</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {uploads.length === 0 && <tr><td colSpan={7} className="muted text-center">ยังไม่มีการอัปโหลด</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- หน้าเทียบ 3 แหล่ง ---------- */
export default function RegistryPage() {
  const [range, setRange] = useState(lastMonthRange());
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);          // choose | point | fund | { match: fund }
  const [points, setPoints] = useState([]);
  const [funds, setFunds] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [open, setOpen] = useState(null);
  const [pop, setPop] = useState(null);
  const popTimer = useRef(null);
  const [sort, toggleSort] = useSortState();
  const onSort = (k) => { toggleSort(k); setPage(1); };

  const rangeError = rangeErrorOf(range);
  const params = useMemo(() => ({
    ...range, status: status || undefined, search: search || undefined,
    sort: sort.key || undefined, dir: sort.key ? sort.dir : undefined,
  }), [range, status, search, sort]);

  const load = useCallback(() => {
    if (rangeError) return;
    setLoading(true);
    api.get('/registry/all', { params: { ...params, page, pageSize: PAGE_SIZE } })
      .then((r) => setData(r.data)).catch((err) => showError(err, 'เทียบข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
    api.get('/registry/uploads').then((r) => setUploads(r.data)).catch(() => {});
  }, [params, page, rangeError]);
  useEffect(() => { load(); setOpen(null); setPop(null); }, [load]);

  const loadLists = useCallback(() => {
    api.get('/points').then((r) => setPoints(r.data.filter((p) => p.is_active))).catch(() => {});
    api.get('/funds').then((r) => setFunds(r.data.filter((f) => f.is_active && !f.track_only))).catch(() => {});
  }, []);
  useEffect(() => { loadLists(); }, [loadLists]);

  /* ป๊อปอัป: ชี้ = แสดงชั่วคราว, กด = ปักไว้ */
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

  const removeUpload = async (b) => {
    if (!(await confirmAction({ title: 'ลบการอัปโหลดนี้?', text: `${b.file_name}: รายการในทะเบียนจากไฟล์นี้จะถูกลบ`, confirmText: 'ลบ', danger: true }))) return;
    try {
      await api.delete(b.kind === 'fund' ? `/registry/batches/${b.id}` : `/points/batches/${b.id}`);
      notifySuccess('ลบแล้ว'); notifyDataChanged(); load();
    } catch (err) { showError(err); }
  };
  const uploaded = () => { setModal(null); loadLists(); load(); };

  const exportUrl = `/api/registry/all/export?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined))}`;
  const t = data?.totals;
  const chips = data ? Object.entries(data.statuses).filter(([k]) => data.summary[k] > 0 || status === k) : [];
  const setFilter = (k) => { setStatus(k); setPage(1); };
  const needFix = data ? data.totals.visits - data.summary.MATCH : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>เทียบ 3 แหล่ง</h1>
          <p>งานหน้างาน: ทะเบียนทุกห้อง/แผนกและกองทุน ลงใน HOSxP ครบและตรงไหม และ visit นั้นเบิกได้หรือยัง (ผลฝั่ง REP ใช้เกณฑ์เดียวกับเมนู “กระทบยอด OPD”) ชี้ที่ยอด HOSxP เพื่อดูว่าค่าใช้จ่ายมาจากห้องไหน</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModal('choose')}>
          <i className="bi bi-upload me-1" />อัปโหลดทะเบียน
        </button>
      </div>

      <div className="panel">
        <div className="row g-3 align-items-end">
          <PeriodFields idPrefix="tw" value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          <div className="col-sm-6 col-lg-4">
            <label className="form-label" htmlFor="tw-q">ค้นหา</label>
            <form className="input-group" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
              <input id="tw-q" className="form-control" placeholder="HN, ชื่อ, VN, ห้อง, กองทุน, รายการ" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
              <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
            </form>
          </div>
        </div>
        {rangeError && <div className="text-danger small mt-2">{rangeError}</div>}
      </div>

      {data?.stale && (
        <div className="alert alert-warning py-2 d-flex flex-wrap align-items-center gap-2">
          <i className="bi bi-arrow-repeat" />
          <span className="me-auto">มีทะเบียนอัปโหลดหลังดึงข้อมูล HOSxP ครั้งล่าสุด ควรดึงข้อมูลช่วงนี้ใหม่</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={async () => { if (await pullHosxpOpd(range)) load(); }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
        </div>
      )}
      {data?.staleFee && !data?.stale && (
        <div className="alert alert-warning py-2 d-flex flex-wrap align-items-center gap-2">
          <i className="bi bi-arrow-repeat" />
          <span className="me-auto">ตั้งค่าค่าบริการที่ติดอัตโนมัติหลังดึงข้อมูล HOSxP ครั้งล่าสุด ดึงข้อมูลช่วงนี้ใหม่เพื่อให้ระบบแยกยอดรายการนี้</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={async () => { if (await pullHosxpOpd(range)) load(); }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
        </div>
      )}
      {data?.unknownItems?.map((f) => (
        <div key={f.code} className="alert alert-warning py-2 d-flex align-items-center gap-2">
          <i className="bi bi-question-circle" />
          <span className="me-auto">ทะเบียนกองทุน {f.code} มีชื่อรายการที่ระบบยังไม่รู้จัก {int(f.count)} ชื่อ จับคู่กับรายการใน HOSxP เพื่อให้เทียบได้</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={() => setModal({ match: f })}>จับคู่รายการ</button>
        </div>
      ))}
      {data && data.registryRows === 0 && (
        <div className="panel text-center py-4">
          <i className="bi bi-journal-arrow-up fs-1 muted" aria-hidden="true" />
          <h2 className="h5 mt-2">ยังไม่มีทะเบียนในช่วงนี้</h2>
          <p className="muted mx-auto" style={{ maxWidth: 520 }}>อัปโหลดทะเบียนของห้อง/แผนก หรือของกองทุน ระบบจะเทียบกับ HOSxP และ REP ให้ทันที</p>
          <button type="button" className="btn btn-primary" onClick={() => setModal('choose')}><i className="bi bi-upload me-1" />อัปโหลดทะเบียน</button>
        </div>
      )}

      {data && data.registryRows > 0 && (
        <div className="panel">
          <div className="cmp-strip" aria-label="สรุป">
            <span className="item"><span className="lbl"><i className="bi bi-people" />visit ที่มีทะเบียน</span><strong>{int(t.visits)}</strong></span>
            <span className="item"><span className="lbl"><i className="bi bi-check-circle" />ตรงกันครบ</span><strong className="paid">{int(data.summary.MATCH)}</strong></span>
            <span className="item"><span className="lbl"><i className="bi bi-exclamation-circle" />ต้องตรวจ</span><strong className="warn">{int(needFix)}</strong></span>
            <span className="item" title={`ค่าใช้จ่ายทั้ง visit ${money(t.his)} บาท`}><span className="lbl"><i className="bi bi-hospital" />เรียกเก็บ (HOSxP)</span><strong>{money(t.hisClaim)}</strong></span>
            <span className="item"><span className="lbl"><i className="bi bi-cloud-check" />REP เรียกเก็บ / ได้รับ</span>
              <strong>{money(t.repClaim)}</strong><span className="sep">/</span><strong className="paid">{money(t.repPaid)}</strong></span>
          </div>

          <div className="cmp-pills" role="group" aria-label="กรองตามผลการเทียบ">
            <button type="button" className={`cmp-pill ${!status ? 'active' : ''}`} onClick={() => setFilter('')}>
              ทั้งหมด <span className="n">{int(t.visits)}</span>
            </button>
            {chips.map(([k, s]) => (
              <button key={k} type="button" className={`cmp-pill ${status === k ? 'active' : ''}`} aria-pressed={status === k}
                style={{ '--c': STATUS_STYLE[k]?.color }} onClick={() => setFilter(status === k ? '' : k)}>
                <i className={`bi ${STATUS_STYLE[k]?.icon}`} />{s.label} <span className="n">{int(data.summary[k])}</span>
              </button>
            ))}
            <span className="ms-auto d-flex align-items-center gap-2">
              {loading && <span className="spinner-border spinner-border-sm text-secondary" />}
              <a className={`btn btn-sm btn-outline-secondary ${data.total ? '' : 'disabled'}`} href={exportUrl}>
                <i className="bi bi-file-earmark-excel me-1" />Excel
              </a>
            </span>
          </div>

          <div className="table-wrap">
            <table className="table data-table cmp3-table">
              <thead>
                <tr>
                  <SortTh k="sdate" sort={sort} onSort={onSort}>วันที่</SortTh>
                  <SortTh k="hn" sort={sort} onSort={onSort}>คนไข้</SortTh>
                  <SortTh k="registry" sort={sort} onSort={onSort}>ทะเบียน</SortTh>
                  <SortTh k="his" sort={sort} onSort={onSort} className="num" title="ค่าใช้จ่ายทั้ง visit ชี้หรือกดที่ยอดเพื่อดูแยกตามห้อง ตัวเล็กคือเรียกเก็บ (HOSxP) ที่ใช้เทียบกับ REP">HOSxP</SortTh>
                  <SortTh k="rep" sort={sort} onSort={onSort} className="num" title="เรียกเก็บ (REP) ตัวเล็กคือได้รับ (REP)">REP</SortTh>
                  <SortTh k="status" sort={sort} onSort={onSort}>ผลการเทียบ</SortTh>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={6} className="text-center muted py-4">ไม่มีรายการ</td></tr>}
                {data.rows.map((r) => {
                  const st = STATUS_STYLE[r.status] || {};
                  const isOpen = open === r.key;
                  const toggle = () => setOpen(isOpen ? null : r.key);
                  const more = r.issues.length - 1;
                  return (
                    <Fragment key={r.key}>
                      <tr className={`cmp-row ${isOpen ? 'open' : ''}`} onClick={toggle} tabIndex={0} aria-expanded={isOpen}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}>
                        <td className="text-nowrap">{thaiDate(r.sdate)}</td>
                        <td className="pt-cell"><span className="hn">{r.hn || '–'}</span><div className="small-id text-truncate">{r.patient_name}</div></td>
                        <td className="reg-cell-td"><RegTags r={r} /></td>
                        <td className="num">
                          {!r.vn ? <span className="muted small">ไม่พบ visit</span> : (
                            <button type="button" className={`amt-btn ${pop?.key === r.key ? 'on' : ''}`} aria-haspopup="dialog"
                              aria-label={`ยอด HOSxP ทั้ง visit ${money(r.vn_total)} บาท ดูแยกตามห้อง`}
                              onMouseEnter={(e) => showPop(e, r.key, r)} onMouseLeave={laterClose}
                              onFocus={(e) => showPop(e, r.key, r)} onBlur={laterClose}
                              onClick={(e) => togglePop(e, r.key, r)}>
                              {money(r.vn_total)}
                            </button>
                          )}
                          {r.vn && Math.abs(Number(r.uc_money) - Number(r.vn_total)) >= 0.01 && (
                            <div className="small-id" title="เรียกเก็บ (HOSxP) ที่ใช้เทียบกับ REP">เรียกเก็บ {money(r.uc_money)}</div>
                          )}
                          {r.vn && r.breakdown.length > 1 && <div className="small-id">{r.breakdown.length} ห้อง</div>}
                        </td>
                        <td className="num">
                          {r.rep ? (<>{money(r.rep.claim_amount)}<div className="small-id">ได้รับ {money(r.rep.compensated)}</div></>)
                            : <span className="muted small">{r.vn ? 'ยังไม่พบ' : '–'}</span>}
                        </td>
                        <td className="result-cell">
                          <div className="d-flex align-items-start gap-2">
                            <div className="min-w-0 flex-grow-1">
                              <span className="cmp-badge" style={{ '--c': st.color }}><i className={`bi ${st.icon}`} />{data.statuses[r.status]?.label}</span>
                              {r.issues[0] && (
                                <div className="reason" title={r.issues.join('\n')}>
                                  {r.issues[0]}{more > 0 && <span className="more">+{more}</span>}
                                </div>
                              )}
                            </div>
                            <i className={`bi ${isOpen ? 'bi-chevron-up' : 'bi-chevron-down'} muted chev`} aria-hidden="true" />
                          </div>
                        </td>
                      </tr>
                      {isOpen && <tr className="detail-row"><td colSpan={6}><RowDetail r={r} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
            <span className="small muted">{int(data.total)} visit · คลิกแถวเพื่อดูรายละเอียด · ชี้ยอด HOSxP เพื่อดูแยกตามห้อง</span>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </div>
        </div>
      )}
      {pop && <DeptPopover pop={pop} onEnter={cancelClose} onLeave={laterClose} onClose={closePop} />}

      <UploadHistory uploads={uploads} onRemove={removeUpload} />

      {modal === 'choose' && <UploadChooser onClose={() => setModal(null)} onPick={(k) => setModal(k)} />}
      {modal === 'point' && <PointUploadModal points={points} onClose={() => setModal(null)} onDone={uploaded} />}
      {modal === 'fund' && <FundUploadModal funds={funds} onClose={() => setModal(null)} onDone={uploaded} />}
      {typeof modal === 'object' && modal?.match && <MatchItemsModal fund={modal.match} onClose={() => { setModal(null); load(); }} onDone={() => {}} />}
    </>
  );
}
