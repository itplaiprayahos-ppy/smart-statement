import MultiSelect from '../components/MultiSelect.jsx';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import Pagination from '../components/Pagination.jsx';
import PeriodFields from '../components/PeriodFields.jsx';
import SortTh from '../components/SortTh.jsx';
import { PointUploadModal } from '../components/RegistryUploads.jsx';
import {
  Box, BoxReason, BreakdownTable, DeptPopover, Field, RegistryBox, RegTags, UploadHistory,
} from '../components/VisitParts.jsx';
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
  HIS_DIFF:        { color: 'var(--st-denied)',  icon: 'bi-arrow-left-right' },
  NOT_IN_REGISTRY: { color: 'var(--st-not-his)', icon: 'bi-journal-x' },
  DENIED:          { color: 'var(--st-denied)',  icon: 'bi-x-octagon' },
  NOT_IN_REP:      { color: 'var(--st-diff)',    icon: 'bi-send-exclamation' },
  REP_DIFF:        { color: 'var(--st-diff)',    icon: 'bi-currency-exchange' },
  MATCH:           { color: 'var(--st-matched)', icon: 'bi-check-circle' },
};
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
                <Field label="กองทุน">{r.funds.some((f) => f.eligible)
                  ? r.funds.filter((f) => f.eligible).map((f) => `${f.code} ${f.name}`).join(', ')
                  : <span className="muted">ไม่เข้าเกณฑ์กองทุนใด</span>}</Field>
                {r.funds.filter((f) => !f.eligible).map((f) => (
                  <div key={f.code} className="text-danger-emphasis">REP จ่ายกองทุน {f.code} แต่ visit ไม่เข้าเกณฑ์ตามการตั้งค่ากองทุน</div>
                ))}
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

/* ---------- หน้าเทียบ 3 แหล่ง ---------- */
export default function RegistryPage() {
  const [range, setRange] = useState(lastMonthRange());
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [point, setPoint] = useState([]);   // รหัสห้อง/แผนกที่เลือก (ว่าง = ทุกห้อง)
  const [fund, setFund] = useState([]);     // รหัสกองทุนที่เลือก (ว่าง = ทุกกองทุน)
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);          // 'point' = หน้าต่างอัปโหลดทะเบียน
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
    point: point.length ? point.join(',') : undefined, fund: fund.length ? fund.join(',') : undefined,
    sort: sort.key || undefined, dir: sort.key ? sort.dir : undefined,
  }), [range, status, search, point, fund, sort]);

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
          <p>งานหน้างาน: ทะเบียนของทุกห้อง/แผนก (จุดบริการ) ลงใน HOSxP ครบและตรงไหม กองทุนดูจากการตั้งค่ากองทุนใน HOSxP และ visit นั้นเบิกได้หรือยัง (ผลฝั่ง REP ใช้เกณฑ์เดียวกับเมนู “กระทบยอด OPD”) ชี้ที่ยอด HOSxP เพื่อดูว่าค่าใช้จ่ายมาจากห้องไหน</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModal('point')}>
          <i className="bi bi-upload me-1" />อัปโหลดทะเบียน
        </button>
      </div>

      <div className="panel">
        <div className="row g-3 align-items-end">
          <PeriodFields idPrefix="tw" value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="tw-point">ห้อง/แผนก</label>
            <MultiSelect id="tw-point" allLabel="ทุกห้อง/แผนก" unit="ห้อง/แผนก" value={point}
              options={points.map((p) => ({ value: p.code, label: p.name }))}
              onChange={(v) => { setPoint(v); setStatus(''); setPage(1); }} />
          </div>
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="tw-fund">กองทุน</label>
            <MultiSelect id="tw-fund" allLabel="ทุกกองทุน" unit="กองทุน" value={fund}
              options={funds.map((f) => ({ value: f.code, label: `${f.code} ${f.name}` }))}
              onChange={(v) => { setFund(v); setStatus(''); setPage(1); }} />
          </div>
          <div className="col-sm-12 col-lg-6">
            <label className="form-label" htmlFor="tw-q">ค้นหา</label>
            <form className="input-group" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
              <input id="tw-q" className="form-control" placeholder="HN, ชื่อ, VN, ห้อง, กองทุน" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
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
          <span className="me-auto">ตั้งค่าค่าบริการอัตโนมัติ/ยาหลังดึงข้อมูล HOSxP ครั้งล่าสุด ดึงข้อมูลช่วงนี้ใหม่เพื่อให้ระบบแยกยอดรายการนี้</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={async () => { if (await pullHosxpOpd(range)) load(); }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
        </div>
      )}
      {data && data.registryRows === 0 && (
        <div className="panel text-center py-4">
          <i className="bi bi-journal-arrow-up fs-1 muted" aria-hidden="true" />
          <h2 className="h5 mt-2">ยังไม่มีทะเบียนในช่วงนี้</h2>
          <p className="muted mx-auto" style={{ maxWidth: 520 }}>อัปโหลดทะเบียนของห้อง/แผนก (จุดบริการ) ระบบจะเทียบกับ HOSxP และ REP ให้ทันที</p>
          <button type="button" className="btn btn-primary" onClick={() => setModal('point')}><i className="bi bi-upload me-1" />อัปโหลดทะเบียน</button>
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
                {data.rows.length === 0 && <tr><td colSpan={6} className="text-center muted py-4">{(point.length || fund.length) && !status && !search ? 'ไม่มี visit ของห้อง/แผนกหรือกองทุนที่เลือกในช่วงนี้' : 'ไม่มีรายการ'}</td></tr>}
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

      {modal === 'point' && <PointUploadModal points={points} onClose={() => setModal(null)} onDone={uploaded} />}
    </>
  );
}
