import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import Diff from '../components/Diff.jsx';
import FundItemAnalysis from '../components/FundItemAnalysis.jsx';
import MonthlyFundChart from '../components/MonthlyFundChart.jsx';
import Pagination from '../components/Pagination.jsx';
import PeriodFields from '../components/PeriodFields.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { showError } from '../utils/alert.js';
import {
  ALL_FUND_STATUS_META, EXTRA_PAID_META, RECEIVED_META, FUNDS, FUND_STATUS_META, FUND_STATUS_ORDER, int, lastMonthRange,
  money, monthsBetween, percent, rangeErrorOf, thaiDate, thaiMonth,
} from '../utils/format.js';
import { pullHosxpOpd } from '../utils/hosxp.js';

const PAGE_SIZE = 50;
const ALL_STATUSES = [...FUND_STATUS_ORDER, 'EXTRA_PAID', 'RECEIVED'];

function FundStatus({ status }) {
  const m = ALL_FUND_STATUS_META[status];
  return <span className="status-badge" style={{ '--st-color': m.color }} title={m.hint}>{m.label}</span>;
}

/** รวมผลจาก backend เป็นแถวละกองทุน */
function buildSummary(data) {
  const empty = () => ({
    patients: 0, visits: 0, his: 0, stm: 0, extraCount: 0, extraAmount: 0, receivedCount: 0, receivedAmount: 0,
    ...Object.fromEntries(FUND_STATUS_ORDER.map((s) => [s, 0])),
  });
  const byFund = Object.fromEntries(data.funds.map((f) => [f.code, { ...f, ...empty() }]));
  const all = { ...empty(), patients: data.totals.patients, visits: data.totals.visits };

  data.people.forEach((p) => {
    if (byFund[p.fund_code]) Object.assign(byFund[p.fund_code], { patients: p.patients, visits: p.visits });
  });
  data.summary.forEach((r) => {
    const t = byFund[r.fund_code];
    if (!t) return;
    [t, all].forEach((x) => {
      if (r.fund_status === 'EXTRA_PAID') {
        x.extraCount += r.count;
        x.extraAmount += Number(r.stm_amount);
      } else if (r.fund_status === 'RECEIVED') {
        // ยอดรับของกองทุนติดตามยอดรับ แยกไว้ ไม่นำไปคิด "เบิกได้ %" ของกองทุนที่มีเกณฑ์
        x.receivedCount += r.count;
        x.receivedAmount += Number(r.stm_amount);
      } else {
        x[r.fund_status] += r.count;
        x.his += Number(r.his_amount);
        x.stm += Number(r.stm_amount);
      }
    });
  });
  // ยอดตั้งเบิกรวม: ใช้ค่าจาก backend ที่นับแต่ละรายการครั้งเดียว แม้รายการอยู่หลายกองทุน
  all.his = data.totals.his_amount ?? all.his;
  return { rows: Object.values(byFund), all };
}

export default function FundReconPage() {
  const { isAdmin } = useAuth();
  const [range, setRange] = useState(lastMonthRange());
  const [pttype, setPttype] = useState('');
  const [fundCode, setFundCode] = useState('');
  const [fundStatus, setFundStatus] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [tab, setTab] = useState('visits');
  const [missing, setMissing] = useState('');

  const rangeError = rangeErrorOf(range);
  const params = useMemo(() => ({
    ...range,
    fund: pttype || undefined,
    fundCode: fundCode || undefined,
    fundStatus: fundStatus || undefined,
    search: search || undefined,
    missing: missing || undefined,
  }), [range, pttype, fundCode, fundStatus, search, missing]);

  // พารามิเตอร์สำหรับแท็บวิเคราะห์ (ไม่ขึ้นกับตัวกรองรายละเอียด)
  const analysisParams = useMemo(() => ({ ...range, fund: pttype || undefined }), [range, pttype]);

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
  const select = (code, status) => { setFundCode(code); setFundStatus(status); setPage(1); };

  const summary = useMemo(() => (data ? buildSummary(data) : null), [data]);

  // เติมเดือนที่ไม่มีข้อมูลให้ครบช่วง เพื่อให้ตารางและกราฟรายเดือนต่อเนื่อง
  const monthly = useMemo(() => {
    if (!data || rangeError) return [];
    const map = Object.fromEntries(data.monthly.map((m) => [m.month, m]));
    return monthsBetween(range.dateFrom, range.dateTo).map((month) => map[month] || {
      month, patients: 0, visits: 0, his_amount: 0, stm_amount: 0,
      not_sent: 0, not_sent_amount: 0, extra_paid: 0, extra_paid_amount: 0,
    });
  }, [data, range, rangeError]);

  const exportUrl = `/api/recon/funds/export?${new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined),
  )}`;

  const pull = async () => {
    if (await pullHosxpOpd(range)) load();
  };

  const countCell = (code, status, n, meta) => (
    <td className="num" key={status}>
      <button type="button" className="count-link" style={{ '--st-color': meta.color }}
        disabled={!n} onClick={(e) => { e.stopPropagation(); select(code, status); }}>
        {int(n)}
      </button>
    </td>
  );

  const fundName = fundCode ? `${fundCode} ${data?.funds.find((f) => f.code === fundCode)?.name || ''}` : 'ทุกกองทุน';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>แยกกองทุน OPD</h1>
          <p>คนไข้ที่เข้าเกณฑ์เบิกตามรายการค่าบริการ/ยาและสิทธิที่ตั้งค่าไว้ จำนวนเงินที่ตั้งเบิก และจำนวนเงินที่เบิกได้จริงจาก REP</p>
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
            <label className="form-label" htmlFor="fr-pt">กรองเพิ่มตามกลุ่มสิทธิ</label>
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

      {data?.notPulledMonths?.length > 0 && (
        <div className="alert alert-warning d-flex align-items-center gap-2">
          <i className="bi bi-exclamation-triangle" />
          <span>
            ยังไม่ได้ดึงข้อมูล HOSxP ของเดือน {data.notPulledMonths.map(thaiMonth).join(', ')}
            {' '}visit ของเดือนเหล่านี้จะไม่แสดง กด “ดึงข้อมูล HOSxP ช่วงนี้”
          </span>
        </div>
      )}
      {data?.stalePulledMonths?.length > 0 && (
        <div className="alert alert-warning d-flex align-items-center gap-2">
          <i className="bi bi-exclamation-triangle" />
          <span>
            มีการเพิ่มรายการในกองทุนหลังดึงข้อมูลเดือน {data.stalePulledMonths.map(thaiMonth).join(', ')}
            {' '}กด “ดึงข้อมูล HOSxP ช่วงนี้” เพื่อให้ผลครบ
          </span>
        </div>
      )}

      {/* ---------- สรุปรายกองทุน ---------- */}
      <div className="panel">
        <div className="d-flex justify-content-between align-items-baseline mb-2">
          <div className="panel-title mb-0">สรุปรายกองทุน</div>
          <span className="small muted">คลิกแถวเพื่อดูรายเดือนและรายละเอียด หรือคลิกตัวเลขเพื่อกรองตามสถานะ</span>
        </div>
        <div className="table-wrap">
          <table className="table data-table fund-summary">
            <thead>
              <tr>
                <th rowSpan={2}>กองทุน</th>
                <th colSpan={5} className="text-center">เข้าเกณฑ์เบิก</th>
                <th colSpan={4} className="text-center">สถานะ (จำนวน visit)</th>
                <th colSpan={2} className="text-center">ตรวจย้อนกลับ</th>
              </tr>
              <tr>
                <th className="num">คนไข้</th>
                <th className="num">visit</th>
                <th className="num">ยอดตั้งเบิก</th>
                <th className="num">ยอดเบิกได้</th>
                <th className="num">เบิกได้ %</th>
                {FUND_STATUS_ORDER.map((s) => <th key={s} className="num">{FUND_STATUS_META[s].label}</th>)}
                <th className="num" title={EXTRA_PAID_META.hint}>{EXTRA_PAID_META.label}</th>
                <th className="num">ยอดเงิน</th>
              </tr>
            </thead>
            <tbody>
              {summary?.rows.map((f) => (
                <tr key={f.code} className={fundCode === f.code ? 'active' : ''} onClick={() => select(fundCode === f.code ? '' : f.code, '')}>
                  <td>
                    <strong>{f.code}</strong> <span className="muted">{f.name}</span>
                    {f.item_count === 0 && !f.track_only && f.match_mode === 'items' && (
                      <div className="small text-warning-emphasis">
                        ยังไม่ได้ตั้งค่ารายการ{isAdmin && <> <Link to="/funds/settings" onClick={(e) => e.stopPropagation()}>ตั้งค่า</Link></>}
                      </div>
                    )}
                  </td>
                  {f.track_only ? (
                    <>
                      <td className="num muted">–</td>
                      <td className="num">{countCell(f.code, 'RECEIVED', f.receivedCount, RECEIVED_META).props.children}</td>
                      <td className="num muted">–</td>
                      <td className="num">{money(f.receivedAmount)}</td>
                      <td className="num muted">–</td>
                      <td colSpan={FUND_STATUS_ORDER.length} className="small muted">ติดตามยอดรับ ไม่มีเกณฑ์คัด visit</td>
                    </>
                  ) : (
                    <>
                      <td className="num">{int(f.patients)}</td>
                      <td className="num">{int(f.visits)}</td>
                      <td className="num">{money(f.his)}</td>
                      <td className="num">{money(f.stm)}</td>
                      <td className="num">{percent(f.stm, f.his)}</td>
                      {FUND_STATUS_ORDER.map((s) => countCell(f.code, s, f[s], FUND_STATUS_META[s]))}
                    </>
                  )}
                  {countCell(f.code, 'EXTRA_PAID', f.extraCount, EXTRA_PAID_META)}
                  <td className="num">{f.extraCount ? money(f.extraAmount) : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
            {summary && (
              <tfoot>
                <tr>
                  <td>รวมทุกกองทุน</td>
                  <td className="num" title="นับคนไข้ไม่ซ้ำ แม้อยู่หลายกองทุน">{int(summary.all.patients)}</td>
                  <td className="num" title="นับ visit ไม่ซ้ำ แม้อยู่หลายกองทุน">{int(summary.all.visits)}</td>
                  <td className="num">{money(summary.all.his)}</td>
                  <td className="num" title="รวมยอดรับของกองทุนติดตามยอดรับ (FS, DRUG) ด้วย">
                    {money(summary.all.stm + summary.all.receivedAmount)}
                  </td>
                  <td className="num" title="คิดจากกองทุนที่มีเกณฑ์เท่านั้น">{percent(summary.all.stm, summary.all.his)}</td>
                  {FUND_STATUS_ORDER.map((s) => <td key={s} className="num">{int(summary.all[s])}</td>)}
                  <td className="num">{int(summary.all.extraCount)}</td>
                  <td className="num">{money(summary.all.extraAmount)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="small muted mb-0 mt-2">
          คนไข้นับไม่ซ้ำด้วยเลขบัตรประชาชน แถวรวมนับคนไข้และ visit ไม่ซ้ำแม้อยู่หลายกองทุน ส่วนจำนวนตามสถานะนับเป็นรายการกองทุนต่อ visit
          ยอดตั้งเบิกคือราคารวมของรายการที่เข้าเกณฑ์ใน HOSxP ยอดเบิกได้มาจากคอลัมน์ของกองทุนในไฟล์ REP
        </p>
      </div>

      {/* ---------- สรุปรายเดือน ---------- */}
      <div className="panel">
        <div className="d-flex justify-content-between align-items-baseline mb-3">
          <div className="panel-title mb-0">สรุปรายเดือน: {fundName}</div>
          <button type="button" className="btn btn-sm btn-link" onClick={() => setShowChart((v) => !v)}>
            {showChart ? 'ซ่อนกราฟ' : 'แสดงกราฟ'}
          </button>
        </div>
        {showChart && monthly.length > 0 && <div className="mb-3"><MonthlyFundChart months={monthly} /></div>}
        <div className="table-wrap">
          <table className="table table-sm data-table">
            <thead>
              <tr>
                <th>เดือน</th>
                <th className="num">คนไข้</th>
                <th className="num">visit</th>
                <th className="num">ยอดตั้งเบิก</th>
                <th className="num">ยอดเบิกได้</th>
                <th className="num">เบิกได้ %</th>
                <th className="num">ไม่พบใน REP</th>
                <th className="num">ยอดที่ยังไม่ได้เบิก</th>
                <th className="num">ได้รับแต่ไม่เข้าเกณฑ์</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month}>
                  <td>{thaiMonth(m.month)}</td>
                  <td className="num">{int(m.patients)}</td>
                  <td className="num">{int(m.visits)}</td>
                  <td className="num">{money(m.his_amount)}</td>
                  <td className="num">{money(m.stm_amount)}</td>
                  <td className="num">{percent(Number(m.stm_amount), Number(m.his_amount))}</td>
                  <td className="num">{int(m.not_sent)}</td>
                  <td className="num">{m.not_sent ? money(m.not_sent_amount) : <span className="muted">–</span>}</td>
                  <td className="num">{m.extra_paid ? `${int(m.extra_paid)} (${money(m.extra_paid_amount)})` : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted mb-0 mt-1">คนไข้รายเดือนนับไม่ซ้ำภายในเดือน ผลรวมทุกเดือนจึงอาจมากกว่าจำนวนคนไข้ทั้งช่วง</p>
      </div>

      {/* ---------- รายละเอียด / วิเคราะห์ ---------- */}
      <div className="panel">
        <div className="panel-tabs" role="tablist">
          {[
            ['visits', 'รายละเอียด visit'],
            ['items', 'อัตราได้รับเงินรายรายการ'],
            ['common', 'เทียบกับเคสที่ได้รับเงิน'],
          ].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key}
              className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
          <span className="ms-auto align-self-center small muted">{fundName}</span>
        </div>

        {tab !== 'visits' && (
          <FundItemAnalysis
            mode={tab}
            params={analysisParams}
            fundCode={fundCode}
            onShowMissing={() => { setMissing('common'); setFundStatus(''); setPage(1); setTab('visits'); }}
          />
        )}

        {tab === 'visits' && (<>
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <button type="button" className={`chip ${!fundStatus ? 'active' : ''}`} onClick={() => select(fundCode, '')}>ทุกสถานะ</button>
          {ALL_STATUSES.map((s) => (
            <button key={s} type="button" className={`chip ${fundStatus === s ? 'active' : ''}`} onClick={() => select(fundCode, s)}>
              {ALL_FUND_STATUS_META[s].label}
            </button>
          ))}
          {fundCode && (
            <button type="button" className="btn btn-sm btn-link" onClick={() => select('', fundStatus)}>แสดงทุกกองทุน</button>
          )}
          {loading && <span className="spinner-border spinner-border-sm text-secondary ms-auto" role="status" />}
        </div>
        <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
          <span className="small muted me-1">ขาดรายการ:</span>
          {[['', 'ไม่กรอง'], ['required', 'ขาดรายการจำเป็น'], ['common', 'ขาดเมื่อเทียบเคสที่ได้รับเงิน']].map(([v, label]) => (
            <button key={v || 'none'} type="button" className={`chip ${missing === v ? 'active' : ''}`}
              onClick={() => { setMissing(v); setPage(1); }}>
              {label}
            </button>
          ))}
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
                <th>สิทธิ</th>
                <th>รายการที่เข้าเกณฑ์ / เหตุผล</th>
                <th>ขาดรายการ</th>
                <th className="num">ยอดตั้งเบิก</th>
                <th className="num">ยอดเบิกได้</th>
                <th className="num">ผลต่าง</th>
                <th>REP / TRAN_ID / เลขที่ REP</th>
                <th>รหัสข้อผิดพลาด</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="text-center muted py-4">
                    {summary?.all.visits === 0 && summary?.all.extraCount === 0
                      ? 'ยังไม่มี visit ที่เข้าเกณฑ์ ตรวจว่าตั้งค่ารายการในกองทุนแล้ว และดึงข้อมูล HOSxP ของช่วงนี้แล้ว'
                      : 'ไม่พบรายการที่ตรงกับเงื่อนไข'}
                  </td>
                </tr>
              )}
              {data?.rows.map((r) => (
                <tr key={`${r.fund_code}-${r.vn ?? r.line_id}`}>
                  <td><FundStatus status={r.fund_status} /></td>
                  <td>{r.fund_code}</td>
                  <td>{thaiDate(r.sdate)}</td>
                  <td>{r.hn || '–'}<div className="small-id">{r.vn || 'ไม่มี VN'}</div></td>
                  <td className="wrap">{r.patient_name || '–'}<div className="small-id">{r.cid}</div></td>
                  <td>{r.pttype_name || '–'}{r.pttype && <div className="small-id">{r.pttype}</div>}</td>
                  <td className={`wrap ${r.fund_status === 'EXTRA_PAID' ? 'text-primary-emphasis' : ''}`}>{r.items}</td>
                  <td className="wrap missing-list">
                    {r.missing_required && <div><span className="tag text-danger">จำเป็น:</span> {r.missing_required}</div>}
                    {r.missing_common && <div><span className="tag text-warning-emphasis">เคสได้รับเงินมักมี:</span> {r.missing_common}</div>}
                    {!r.missing_required && !r.missing_common && <span className="muted">–</span>}
                  </td>
                  <td className="num">{money(r.his_fund_amount)}</td>
                  <td className="num">{money(r.stm_fund_amount)}</td>
                  <td className="num">
                    <Diff value={r.stm_fund_amount === null || r.his_fund_amount === null ? null : r.stm_fund_amount - r.his_fund_amount} />
                  </td>
                  <td>
                    {r.rep_no || '–'}
                    <div className="small-id">{r.tran_id}</div>
                    {r.stm_docs && <div className="small-id">{r.stm_docs}</div>}
                  </td>
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
        </>)}
      </div>
    </>
  );
}
