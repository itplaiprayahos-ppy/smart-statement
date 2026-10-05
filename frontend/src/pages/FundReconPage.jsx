import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import Diff from '../components/Diff.jsx';
import Pagination from '../components/Pagination.jsx';
import PeriodFields from '../components/PeriodFields.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { showError } from '../utils/alert.js';
import {
  FUNDS, FUND_STATUS_META, FUND_STATUS_ORDER, int, lastMonthRange, money, rangeErrorOf, thaiDate,
} from '../utils/format.js';
import { pullHosxpOpd } from '../utils/hosxp.js';

const PAGE_SIZE = 50;

function FundStatus({ status }) {
  const m = FUND_STATUS_META[status];
  return <span className="status-badge" style={{ '--st-color': m.color }} title={m.hint}>{m.label}</span>;
}

/** รวมผลสรุปจาก backend เป็นแถวละกองทุน */
function buildSummary(funds, summary) {
  const empty = () => ({ total: 0, his: 0, stm: 0, ...Object.fromEntries(FUND_STATUS_ORDER.map((s) => [s, 0])) });
  const byFund = Object.fromEntries(funds.map((f) => [f.code, { ...f, ...empty() }]));
  const all = empty();
  summary.forEach((r) => {
    const t = byFund[r.fund_code];
    if (!t) return;
    [t, all].forEach((x) => {
      x[r.fund_status] += r.count;
      x.total += r.count;
      x.his += Number(r.his_amount);
      x.stm += Number(r.stm_amount);
    });
  });
  return { rows: Object.values(byFund), all };
}

export default function FundReconPage() {
  const { isAdmin } = useAuth();
  const [range, setRange] = useState(lastMonthRange());
  const [pttype, setPttype] = useState('UCS');
  const [fundCode, setFundCode] = useState('');
  const [fundStatus, setFundStatus] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const rangeError = rangeErrorOf(range);
  const params = useMemo(() => ({
    ...range,
    fund: pttype || undefined,
    fundCode: fundCode || undefined,
    fundStatus: fundStatus || undefined,
    search: search || undefined,
  }), [range, pttype, fundCode, fundStatus, search]);

  const load = useCallback(async () => {
    if (rangeError) return;
    setLoading(true);
    try {
      const res = await api.get('/recon/funds', { params: { ...params, page, pageSize: PAGE_SIZE } });
      setData(res.data);
    } catch (err) {
      showError(err, 'โหลดผลการแยกกองทุนไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, [params, page, rangeError]);

  useEffect(() => { load(); }, [load]);

  const reset = (fn) => (...args) => { fn(...args); setPage(1); };
  const selectCell = (code, status) => { setFundCode(code); setFundStatus(status); setPage(1); };

  const summary = useMemo(() => (data ? buildSummary(data.funds, data.summary) : null), [data]);

  const exportUrl = `/api/recon/funds/export?${new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined),
  )}`;

  const pull = async () => {
    if (await pullHosxpOpd(range)) load();
  };

  const countCell = (code, status, n) => (
    <td className="num" key={status}>
      <button type="button" className="count-link" style={{ '--st-color': FUND_STATUS_META[status].color }}
        disabled={!n} onClick={(e) => { e.stopPropagation(); selectCell(code, status); }}>
        {int(n)}
      </button>
    </td>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>แยกกองทุน OPD</h1>
          <p>คัด visit ที่มีรายการค่าบริการหรือยาตามที่ตั้งค่าไว้ในแต่ละกองทุน แล้วตรวจว่าส่งเบิกและได้รับเงินกองทุนนั้นแล้วหรือยัง</p>
        </div>
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-outline-primary" onClick={pull} disabled={!!rangeError}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
          <a className={`btn btn-outline-secondary ${data?.total ? '' : 'disabled'}`} href={exportUrl}>
            <i className="bi bi-download me-1" />ส่งออก Excel
          </a>
        </div>
      </div>

      <div className="panel">
        <div className="row g-3 align-items-end">
          <PeriodFields idPrefix="fr" value={range} onChange={reset(setRange)} />
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="fr-pt">สิทธิ (ตาม HOSxP)</label>
            <select id="fr-pt" className="form-select" value={pttype} onChange={(e) => reset(setPttype)(e.target.value)}>
              {FUNDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="col-sm-6 col-lg-3">
            <form onSubmit={(e) => { e.preventDefault(); reset(setSearch)(searchInput.trim()); }}>
              <label className="form-label" htmlFor="fr-q">ค้นหา</label>
              <div className="input-group">
                <input id="fr-q" className="form-control" placeholder="HN, VN, เลขบัตร, ชื่อ"
                  value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
                <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
              </div>
            </form>
          </div>
        </div>
        {rangeError && <div className="text-danger small mt-2">{rangeError}</div>}
      </div>

      {data?.needsRepull && (
        <div className="alert alert-warning d-flex align-items-center gap-2">
          <i className="bi bi-exclamation-triangle" />
          มีการเพิ่มรายการในการตั้งค่ากองทุนหลังดึงข้อมูล HOSxP ครั้งล่าสุด กด “ดึงข้อมูล HOSxP ช่วงนี้” เพื่อให้ผลครบ
        </div>
      )}

      <div className="panel">
        <div className="d-flex justify-content-between align-items-baseline mb-2">
          <div className="panel-title mb-0">สรุปรายกองทุน</div>
          <span className="small muted">คลิกแถวเพื่อดูรายละเอียด หรือคลิกตัวเลขเพื่อกรองตามสถานะ</span>
        </div>
        <div className="table-wrap">
          <table className="table data-table fund-summary">
            <thead>
              <tr>
                <th>กองทุน</th>
                <th className="num">visit ที่เข้าเงื่อนไข</th>
                {FUND_STATUS_ORDER.map((s) => <th key={s} className="num">{FUND_STATUS_META[s].label}</th>)}
                <th className="num">ยอด HOSxP</th>
                <th className="num">ยอดที่ได้รับ</th>
                <th className="num">ผลต่าง</th>
              </tr>
            </thead>
            <tbody>
              {summary?.rows.map((f) => (
                <tr key={f.code} className={fundCode === f.code ? 'active' : ''} onClick={() => selectCell(fundCode === f.code ? '' : f.code, '')}>
                  <td>
                    <strong>{f.code}</strong> <span className="muted">{f.name}</span>
                    {f.item_count === 0 && (
                      <div className="small text-warning-emphasis">
                        ยังไม่ได้ตั้งค่ารายการ{isAdmin && <> <Link to="/funds/settings" onClick={(e) => e.stopPropagation()}>ตั้งค่า</Link></>}
                      </div>
                    )}
                  </td>
                  <td className="num">{int(f.total)}</td>
                  {FUND_STATUS_ORDER.map((s) => countCell(f.code, s, f[s]))}
                  <td className="num">{money(f.his)}</td>
                  <td className="num">{money(f.stm)}</td>
                  <td className="num"><Diff value={f.total ? f.stm - f.his : null} /></td>
                </tr>
              ))}
            </tbody>
            {summary && (
              <tfoot>
                <tr>
                  <td>รวมทุกกองทุน</td>
                  <td className="num">{int(summary.all.total)}</td>
                  {FUND_STATUS_ORDER.map((s) => <td key={s} className="num">{int(summary.all[s])}</td>)}
                  <td className="num">{money(summary.all.his)}</td>
                  <td className="num">{money(summary.all.stm)}</td>
                  <td className="num"><Diff value={summary.all.total ? summary.all.stm - summary.all.his : null} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="small muted mb-0 mt-2">
          ยอด HOSxP คือราคารวมของรายการที่เข้าเงื่อนไขกองทุนนั้น ส่วนยอดที่ได้รับมาจากคอลัมน์ของกองทุนในไฟล์ REP
          สองยอดนี้คำนวณคนละหลักเกณฑ์ ผลต่างจึงใช้ดูภาพรวมการได้รับเงิน ไม่ได้หมายความว่าเบิกผิด
        </p>
      </div>

      <div className="panel">
        <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
          <span className="fw-medium me-1">
            {fundCode ? `กองทุน ${fundCode}` : 'ทุกกองทุน'}
          </span>
          <button type="button" className={`chip ${!fundStatus ? 'active' : ''}`} onClick={() => selectCell(fundCode, '')}>ทุกสถานะ</button>
          {FUND_STATUS_ORDER.map((s) => (
            <button key={s} type="button" className={`chip ${fundStatus === s ? 'active' : ''}`} onClick={() => selectCell(fundCode, s)}>
              {FUND_STATUS_META[s].label}
            </button>
          ))}
          {fundCode && (
            <button type="button" className="btn btn-sm btn-link" onClick={() => selectCell('', fundStatus)}>แสดงทุกกองทุน</button>
          )}
          {loading && <span className="spinner-border spinner-border-sm text-secondary ms-auto" role="status" />}
        </div>

        <div className="table-wrap">
          <table className="table table-hover data-table">
            <thead>
              <tr>
                <th>สถานะ</th>
                <th>กองทุน</th>
                <th>วันที่รับบริการ</th>
                <th>HN / VN</th>
                <th>ผู้ป่วย</th>
                <th>รายการที่เข้าเงื่อนไข</th>
                <th className="num">ยอด HOSxP</th>
                <th className="num">ยอดที่ได้รับ</th>
                <th className="num">ผลต่าง</th>
                <th>REP / TRAN_ID</th>
                <th>รหัสข้อผิดพลาด</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center muted py-4">
                    {summary?.all.total === 0
                      ? 'ยังไม่มี visit ที่เข้าเงื่อนไข ตรวจว่าตั้งค่ารายการในกองทุนแล้ว และดึงข้อมูล HOSxP ของช่วงนี้แล้ว'
                      : 'ไม่พบรายการที่ตรงกับเงื่อนไข'}
                  </td>
                </tr>
              )}
              {data?.rows.map((r) => (
                <tr key={`${r.fund_code}-${r.vn}`}>
                  <td><FundStatus status={r.fund_status} /></td>
                  <td>{r.fund_code}</td>
                  <td>{thaiDate(r.sdate)}</td>
                  <td>{r.hn}<div className="small-id">{r.vn}</div></td>
                  <td className="wrap">{r.patient_name || '–'}<div className="small-id">{r.cid}</div></td>
                  <td className="wrap">{r.items}</td>
                  <td className="num">{money(r.his_fund_amount)}</td>
                  <td className="num">{money(r.stm_fund_amount)}</td>
                  <td className="num"><Diff value={r.stm_fund_amount === null ? null : r.stm_fund_amount - r.his_fund_amount} /></td>
                  <td>{r.rep_no || '–'}<div className="small-id">{r.tran_id}</div></td>
                  <td>{r.error_code ? <span className="text-danger">{r.error_code}</span> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data && (
          <div className="d-flex justify-content-between align-items-center mt-3">
            <span className="small muted">
              {data.total > 0 && `แสดง ${int((page - 1) * PAGE_SIZE + 1)}–${int(Math.min(page * PAGE_SIZE, data.total))} จาก ${int(data.total)}`}
            </span>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </div>
        )}
      </div>
    </>
  );
}
