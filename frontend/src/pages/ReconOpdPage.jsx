import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';
import Pagination from '../components/Pagination.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import Diff from '../components/Diff.jsx';
import StatusChart from '../components/StatusChart.jsx';
import SortTh from '../components/SortTh.jsx';
import ThaiDateInput from '../components/ThaiDateInput.jsx';
import { useSortState } from '../hooks/useSort.js';
import { confirmAction, notifySuccess, showError, withLoading } from '../utils/alert.js';
import {
  FUNDS, PERIODS, STATUS_META, STATUS_ORDER, daysInRange, int, lastMonthRange,
  money, periodOf, rangeErrorOf, thaiDate, thaiDateTime, toIso,
} from '../utils/format.js';

const PAGE_SIZE = 50;

export default function ReconOpdPage() {
  const [filters, setFilters] = useState({
    ...lastMonthRange(), fund: 'UCS', compare: 'claim', onlyClaimable: true,
  });
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastPull, setLastPull] = useState(null);
  const [showChart, setShowChart] = useState(false);
  const [sort, toggleSort] = useSortState();
  const onSort = (k) => { toggleSort(k); setPage(1); };

  const params = useMemo(() => ({
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    fund: filters.fund || undefined,
    compare: filters.compare,
    onlyClaimable: filters.onlyClaimable ? '1' : '0',
    status: status || undefined,
    search: search || undefined,
    sort: sort.key || undefined,
    dir: sort.key ? sort.dir : undefined,
  }), [filters, status, search, sort]);

  const rangeError = rangeErrorOf(filters);

  const load = useCallback(async () => {
    if (rangeError) return; // ช่วงวันที่ยังไม่ถูกต้อง ไม่ต้องส่งคำขอ
    setLoading(true);
    try {
      const res = await api.get('/recon/opd', { params: { ...params, page, pageSize: PAGE_SIZE } });
      setResult(res.data);
    } catch (err) {
      showError(err, 'โหลดผลการเปรียบเทียบไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, [params, page, rangeError]);

  const loadPullLog = useCallback(() => {
    api.get('/his/opd/pull-logs').then((r) => setLastPull(r.data[0] || null)).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadPullLog(); }, [loadPullLog]);

  const setFilter = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setFilters((f) => {
      const next = { ...f, [k]: v };
      // เลือกวันเริ่มเลยวันสิ้นสุด: เลื่อนวันสิ้นสุดเป็นวันสุดท้ายของเดือนนั้น
      if (k === 'dateFrom' && v && next.dateTo && v > next.dateTo) {
        const [y, m] = v.split('-').map(Number);
        next.dateTo = toIso(new Date(y, m, 0));
      }
      return next;
    });
    setPage(1);
  };

  const choosePeriod = (e) => {
    const p = PERIODS.find((x) => x.value === e.target.value);
    if (!p) return;
    setFilters((f) => ({ ...f, ...p.range() }));
    setPage(1);
  };

  const pullHosxp = async () => {
    const ok = await confirmAction({
      title: 'ดึงข้อมูล OPD จาก HOSxP?',
      text: `ช่วง ${thaiDate(filters.dateFrom)} – ${thaiDate(filters.dateTo)} ข้อมูลเดิมของช่วงนี้ในระบบจะถูกแทนที่ด้วยข้อมูลล่าสุด${
        daysInRange(filters.dateFrom, filters.dateTo) > 62 ? ' ช่วงยาวหลายเดือนอาจใช้เวลาหลายนาที ระบบจะดึงทีละเดือน' : ''}`,
      confirmText: 'ดึงข้อมูล',
    });
    if (!ok) return;
    try {
      const res = await withLoading('กำลังดึงข้อมูลจาก HOSxP…', () =>
        api.post('/his/opd/pull', { dateFrom: filters.dateFrom, dateTo: filters.dateTo }));
      notifySuccess(`ดึงข้อมูลแล้ว ${int(res.data.rowCount)} visit (${res.data.months} เดือน)`);
      loadPullLog();
      load();
    } catch (err) {
      showError(err, 'ดึงข้อมูล HOSxP ไม่สำเร็จ');
    }
  };

  const exportUrl = `/api/recon/opd/export?${new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined),
  )}`;

  const summary = result?.summary;
  const grand = summary ? STATUS_ORDER.reduce((a, s) => a + summary[s].count, 0) : 0;

  const chooseStatus = (s) => {
    setStatus((cur) => (cur === s ? '' : s));
    setPage(1);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>กระทบยอด OPD</h1>
          <p>จับคู่ visit ใน HOSxP กับรายการจาก สปสช. ด้วยเลขบัตรประชาชนและวันที่รับบริการ</p>
        </div>
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-outline-primary" onClick={pullHosxp} disabled={!!rangeError}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
          <a className={`btn btn-outline-secondary ${grand ? '' : 'disabled'}`} href={exportUrl}>
            <i className="bi bi-download me-1" />ส่งออก Excel
          </a>
        </div>
      </div>

      <div className="panel">
        <div className="row g-3 align-items-end">
          <div className="col-sm-12 col-lg-2">
            <label className="form-label" htmlFor="period">ช่วงเวลา</label>
            <select id="period" className="form-select" value={periodOf(filters)} onChange={choosePeriod}>
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              <option value="custom" disabled>กำหนดเอง</option>
            </select>
          </div>
          <div className="col-sm-6 col-lg-2">
            <label className="form-label" htmlFor="df">ตั้งแต่วันที่</label>
            <ThaiDateInput id="df" value={filters.dateFrom} onChange={(v) => setFilter('dateFrom')({ target: { value: v, type: 'text' } })} />
          </div>
          <div className="col-sm-6 col-lg-2">
            <label className="form-label" htmlFor="dt">ถึงวันที่</label>
            <ThaiDateInput id="dt" value={filters.dateTo} onChange={(v) => setFilter('dateTo')({ target: { value: v, type: 'text' } })} />
          </div>
          <div className="col-sm-6 col-lg-2">
            <label className="form-label" htmlFor="fund">สิทธิ (ตาม HOSxP)</label>
            <select id="fund" className="form-select" value={filters.fund} onChange={setFilter('fund')}>
              {FUNDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="col-sm-6 col-lg-2">
            <label className="form-label" htmlFor="cmp">เทียบเรียกเก็บ (HOSxP) กับ</label>
            <select id="cmp" className="form-select" value={filters.compare} onChange={setFilter('compare')}>
              <option value="claim">เรียกเก็บ (REP)</option>
              <option value="compensated">ได้รับ (REP)</option>
            </select>
          </div>
          <div className="col-lg-2">
            <div className="form-check">
              <input id="oc" type="checkbox" className="form-check-input" checked={filters.onlyClaimable} onChange={setFilter('onlyClaimable')} />
              <label className="form-check-label" htmlFor="oc">เฉพาะ visit ที่มียอดเรียกเก็บ</label>
            </div>
          </div>
        </div>
        {rangeError && <div className="text-danger small mt-2">{rangeError}</div>}
        <div className="small muted mt-2">
          {lastPull
            ? <>ดึง HOSxP ล่าสุด: ช่วง {thaiDate(lastPull.date_from)} – {thaiDate(lastPull.date_to)} เมื่อ {thaiDateTime(lastPull.created_at)}</>
            : 'ยังไม่เคยดึงข้อมูลจาก HOSxP กดปุ่ม “ดึงข้อมูล HOSxP ช่วงนี้” ก่อนเริ่มเปรียบเทียบ'}
        </div>
      </div>

      <div className="panel">
        <div className="d-flex justify-content-between align-items-baseline mb-2">
          <div className="panel-title mb-0">ผลการเปรียบเทียบ {grand > 0 && <span className="muted fw-normal">ทั้งหมด {int(grand)} รายการ</span>}</div>
          <button type="button" className="btn btn-sm btn-link" onClick={() => setShowChart((v) => !v)} disabled={!grand}>
            {showChart ? 'ซ่อนกราฟ' : 'แสดงกราฟยอดเงิน'}
          </button>
        </div>

        <div className="ledger-strip" role="img" aria-label="สัดส่วนรายการแยกตามสถานะ">
          {summary && STATUS_ORDER.map((s) => (
            <span key={s} style={{ flexGrow: summary[s].count, background: STATUS_META[s].color }} title={`${STATUS_META[s].label} ${summary[s].count}`} />
          ))}
        </div>

        <div className="status-filters">
          {STATUS_ORDER.map((s) => {
            const d = summary?.[s];
            const amount = s === 'NOT_IN_HIS' ? d?.claim_amount : d?.his_amount;
            return (
              <button key={s} type="button" className={`status-filter ${status === s ? 'active' : ''}`}
                style={{ '--st-color': STATUS_META[s].color }} onClick={() => chooseStatus(s)} aria-pressed={status === s}>
                <div className="label">{STATUS_META[s].label}</div>
                <div className="count">{int(d?.count)}</div>
                <div className="amount">{money(amount)} บาท</div>
              </button>
            );
          })}
        </div>

        {showChart && summary && <div className="mt-4"><StatusChart summary={summary} /></div>}
      </div>

      <div className="panel">
        <div className="d-flex flex-wrap gap-2 justify-content-between align-items-center mb-3">
          <form className="d-flex flex-wrap gap-2" style={{ minWidth: 0 }} onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
            <input className="form-control" style={{ minWidth: 320 }} placeholder="ค้นหา HN, VN, เลขบัตร, TRAN_ID, ชื่อ"
              value={searchInput} onChange={(e) => setSearchInput(e.target.value)} aria-label="ค้นหา" />
            <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
          </form>
          <div className="d-flex align-items-center gap-3">
            {status && (
              <button type="button" className="btn btn-sm btn-light" onClick={() => chooseStatus(status)}>
                แสดงเฉพาะ: {STATUS_META[status].label} <i className="bi bi-x" />
              </button>
            )}
            {loading && <span className="spinner-border spinner-border-sm text-secondary" role="status" />}
          </div>
        </div>

        <div className="table-wrap">
          <table className="table table-hover data-table sticky-first">
            <thead>
              <tr>
                <SortTh k="status" sort={sort} onSort={onSort}>สถานะ</SortTh>
                <SortTh k="sdate" sort={sort} onSort={onSort}>วันที่รับบริการ</SortTh>
                <SortTh k="hn" sort={sort} onSort={onSort}>HN / VN</SortTh>
                <SortTh k="patient" sort={sort} onSort={onSort}>ผู้ป่วย</SortTh>
                <SortTh k="pttype" sort={sort} onSort={onSort}>สิทธิ</SortTh>
                <SortTh k="his" sort={sort} onSort={onSort} className="num">เรียกเก็บ (HOSxP)</SortTh>
                <SortTh k="claim" sort={sort} onSort={onSort} className="num">เรียกเก็บ (REP)</SortTh>
                <SortTh k="diff" sort={sort} onSort={onSort} className="num">ผลต่าง</SortTh>
                <SortTh k="comp" sort={sort} onSort={onSort} className="num">ได้รับ (REP)</SortTh>
                <SortTh k="rep" sort={sort} onSort={onSort}>REP / TRAN_ID</SortTh>
                <SortTh k="error" sort={sort} onSort={onSort}>รหัสข้อผิดพลาด</SortTh>
                <th>รายละเอียดข้อผิดพลาด</th>
              </tr>
            </thead>
            <tbody>
              {result?.rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="text-center muted py-4">
                    {grand === 0
                      ? 'ยังไม่มีข้อมูลในช่วงวันที่นี้ นำเข้าไฟล์จาก สปสช. และดึงข้อมูล HOSxP ให้ครบทั้งสองฝั่ง'
                      : 'ไม่พบรายการที่ตรงกับเงื่อนไข'}
                  </td>
                </tr>
              )}
              {result?.rows.map((r) => (
                <tr key={`${r.vn ?? 'x'}-${r.line_id ?? 'y'}`}>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="text-nowrap">{thaiDate(r.sdate)}</td>
                  <td>
                    {r.hn || r.nhso_hn}
                    <div className="small-id">{r.vn || 'ไม่มี VN'}</div>
                  </td>
                  <td className="wrap">
                    {r.patient_name || <span className="muted">–</span>}
                    <div className="small-id">{r.cid || r.pid}</div>
                  </td>
                  <td>{r.pttype_name || r.fund || '–'}{r.pdx && <div className="small-id">PDX {r.pdx}</div>}</td>
                  <td className="num">{money(r.uc_money)}</td>
                  <td className="num">{money(r.claim_amount)}</td>
                  <td className="num"><Diff value={r.diff} /></td>
                  <td className="num">{money(r.compensated)}</td>
                  <td>
                    {r.rep_no || '–'}
                    {r.line_count > 1 && <span className="badge text-bg-light border ms-1" title={r.stm_docs}>{r.line_count} รอบ</span>}
                    <div className="small-id">{r.tran_id}</div>
                  </td>
                  <td>{r.error_code ? <span className="text-danger">{r.error_code}</span> : '–'}</td>
                  <td className="wrap error-detail" style={{ minWidth: 260 }}>
                    {r.error_detail ? (
                      <>
                        {r.error_detail.split('\n').map((line) => <div key={line}>{line}</div>)}
                        {r.error_guidance && (
                          <div className="guidance"><i className="bi bi-lightbulb me-1" aria-hidden="true" />{r.error_guidance.split('\n').join(' / ')}</div>
                        )}
                      </>
                    ) : <span className="muted">–</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {result && (
          <div className="d-flex justify-content-between align-items-center mt-3">
            <span className="small muted">
              {result.total > 0 && `แสดง ${int((page - 1) * PAGE_SIZE + 1)}–${int(Math.min(page * PAGE_SIZE, result.total))} จาก ${int(result.total)}`}
            </span>
            <Pagination page={page} pageSize={PAGE_SIZE} total={result.total} onChange={setPage} />
          </div>
        )}
      </div>
    </>
  );
}
