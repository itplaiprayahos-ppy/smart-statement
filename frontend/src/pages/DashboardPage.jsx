import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import KpiMonthlyChart from '../components/KpiMonthlyChart.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { showError } from '../utils/alert.js';
import {
  fiscalYearOf, fiscalYearOptions, fiscalYearRange, fmtRate, int, kpiLevel, lastMonthRange, money,
  monthsBetween, rate, thaiDate, thaiDateTime, thaiMonth,
} from '../utils/format.js';

const LEVEL_TH = { good: 'ถึงเป้า', warn: 'ใกล้เป้า', bad: 'ต่ำกว่าเป้า', none: 'ไม่มีข้อมูล' };

function KpiCard({ label, value, sub, level, target }) {
  return (
    <div className={`kpi-card level-${level || 'plain'}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">
        {target !== undefined && level && level !== 'none' && <span className="kpi-pill">{LEVEL_TH[level]} ({target}%)</span>}
        {sub}
      </div>
    </div>
  );
}

function RateCell({ value, target, trend }) {
  const level = kpiLevel(value, Number(target));
  return (
    <td className="num">
      <span className={`kpi-dot level-${level}`} aria-label={LEVEL_TH[level]} />
      {fmtRate(value)}
      {trend !== null && trend !== undefined && Math.abs(trend) >= 0.5 && (
        <i className={`bi ${trend > 0 ? 'bi-arrow-up-short text-success' : 'bi-arrow-down-short text-danger'}`}
          title={`เทียบเดือนก่อน ${trend > 0 ? '+' : ''}${trend.toFixed(1)} จุด`} />
      )}
      <div className="small-id">เป้า {Number(target)}%</div>
    </td>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isExec = user.role === 'executive';
  const [fy, setFy] = useState(() => fiscalYearOf(new Date(lastMonthRange().dateFrom)));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [chartFund, setChartFund] = useState('');

  const range = useMemo(() => fiscalYearRange(fy), [fy]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get('/dashboard/kpi', { params: range })
      .then((r) => alive && setData(r.data))
      .catch((err) => showError(err, 'โหลดแดชบอร์ดไม่สำเร็จ'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [range]);

  // เดือนในปีงบจนถึงเดือนปัจจุบัน (เดือนอนาคตไม่แสดง)
  const monthsOfFy = useMemo(() => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return monthsBetween(range.dateFrom, range.dateTo).filter((m) => m <= thisMonth);
  }, [range]);

  const monthly = useMemo(() => {
    if (!data) return [];
    const rows = data.monthly.filter((m) => (chartFund ? m.fund_code === chartFund : m.fund_code === null));
    const map = Object.fromEntries(rows.map((m) => [m.month, m]));
    return monthsOfFy.map((month) => map[month] || {
      month, closed: false, eligible: 0, sent: 0, paid: 0, stm_amount: 0, pending: 0,
    });
  }, [data, chartFund, monthsOfFy]);

  // แนวโน้มอัตราส่งเบิก: เดือนปิดยอดล่าสุด เทียบเดือนปิดยอดก่อนหน้า
  const trendOf = (code) => {
    if (!data) return null;
    const closed = data.monthly.filter((m) => m.fund_code === code && m.closed && m.eligible > 0)
      .sort((a, b) => a.month.localeCompare(b.month));
    if (closed.length < 2) return null;
    const [prev, last] = closed.slice(-2);
    return rate(last.sent, last.eligible) - rate(prev.sent, prev.eligible);
  };

  const o = data?.overall;
  const d = data?.defaults || { send: 95, success: 90, complete: 95 };
  const sendRate = o ? rate(o.sent, o.eligible) : null;
  const successRate = o ? rate(o.paid, o.sent) : null;
  const completeRate = o ? rate(o.complete, o.eligible) : null;
  const pendingMonths = monthly.filter((m) => !m.closed).map((m) => m.month);
  const chartTarget = chartFund ? Number(data?.funds.find((f) => f.code === chartFund)?.target_send ?? d.send) : d.send;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ภาพรวมผลการเบิก OPD</h1>
          <p>
            ปีงบประมาณ {fy} ({thaiDate(range.dateFrom)} – {thaiDate(range.dateTo)})
            ตัวชี้วัดคิดเฉพาะเดือนที่มี REP แล้ว เดือนที่ยังไม่มีแสดงเป็น “รอผล”
          </p>
        </div>
        <div className="d-flex align-items-center gap-2">
          {loading && <span className="spinner-border spinner-border-sm text-secondary" role="status" />}
          <label className="visually-hidden" htmlFor="db-fy">ปีงบประมาณ</label>
          <select id="db-fy" className="form-select" value={fy} onChange={(e) => setFy(Number(e.target.value))}>
            {fiscalYearOptions(5).map((y) => <option key={y} value={y}>ปีงบ {y}</option>)}
          </select>
        </div>
      </div>

      {/* ---------- ตัวเลขหลัก ---------- */}
      <div className="kpi-grid">
        <KpiCard label="ยอดเบิกได้" value={o ? money(o.stm_amount) : '–'} sub="บาท จาก REP ทุกรอบ" />
        <KpiCard label="ยอดที่ยังไม่ส่งเบิก" value={o ? money(o.not_sent_amount) : '–'}
          sub={o?.pending_amount > 0 ? `บาท (รอผลอีก ${money(o.pending_amount)})` : 'บาท ในเดือนที่ปิดยอดแล้ว'} />
        <KpiCard label="อัตราการส่งเบิก" value={fmtRate(sendRate)} target={d.send} level={kpiLevel(sendRate, d.send)}
          sub={o ? ` ${int(o.sent)} / ${int(o.eligible)} visit` : ''} />
        <KpiCard label="อัตราเคลมสำเร็จ" value={fmtRate(successRate)} target={d.success} level={kpiLevel(successRate, d.success)}
          sub={o ? ` ${int(o.paid)} / ${int(o.sent)} visit` : ''} />
        <KpiCard label="ความครบถ้วนของข้อมูล" value={fmtRate(completeRate)} target={d.complete} level={kpiLevel(completeRate, d.complete)}
          sub={o ? ` ${int(o.complete)} / ${int(o.eligible)} visit` : ''} />
      </div>

      {/* ---------- ตัวชี้วัดรายกองทุน ---------- */}
      <div className="panel">
        <div className="d-flex justify-content-between align-items-baseline mb-2">
          <div className="panel-title mb-0">ตัวชี้วัดรายกองทุน</div>
          <span className="small muted">
            <span className="kpi-dot level-good" /> ถึงเป้า <span className="kpi-dot level-warn ms-2" /> ต่ำกว่าเป้าไม่เกิน 10 จุด
            <span className="kpi-dot level-bad ms-2" /> ต่ำกว่าเป้ามากกว่า 10 จุด
          </span>
        </div>
        <div className="table-wrap">
          <table className={`table data-table kpi-table ${isExec ? '' : 'clickable'}`}>
            <thead>
              <tr>
                <th>กองทุน</th>
                <th>ผู้รับผิดชอบ</th>
                <th className="num">คนไข้</th>
                <th className="num">visit ที่เข้าเกณฑ์</th>
                <th className="num">อัตราการส่งเบิก</th>
                <th className="num">อัตราเคลมสำเร็จ</th>
                <th className="num">ความครบถ้วน</th>
                <th className="num">ยอดยังไม่ส่งเบิก</th>
                <th className="num">ยอดเบิกได้</th>
                <th className="num">รอผล</th>
              </tr>
            </thead>
            <tbody>
              {data?.funds.map((f) => {
                const k = f.kpi;
                return (
                  <tr key={f.code} onClick={isExec ? undefined : () => navigate('/recon/funds')}
                    title={isExec ? undefined : 'เปิดหน้าแยกกองทุน'}>
                    <td><strong>{f.code}</strong> <span className="muted">{f.name}</span>
                      {f.item_count === 0 && !f.track_only && f.match_mode === 'items' && <div className="small text-warning-emphasis">ยังไม่ได้ตั้งค่ารายการ</div>}
                    </td>
                    <td>{f.responsible || <span className={f.track_only ? 'muted small' : 'text-warning-emphasis small'}>ยังไม่กำหนด</span>}</td>
                    {f.track_only ? (
                      <>
                        <td className="num muted">–</td>
                        <td className="num">{k ? `${int(k.received)} รายการ` : '–'}</td>
                        <td colSpan={3} className="small muted">ติดตามยอดรับ ไม่วัดอัตราการส่งเบิก</td>
                        <td className="num muted">–</td>
                      </>
                    ) : (
                      <>
                        <td className="num">{k ? int(k.patients) : '–'}</td>
                        <td className="num">{k ? int(k.eligible) : '–'}</td>
                        <RateCell value={k ? rate(k.sent, k.eligible) : null} target={f.target_send} trend={trendOf(f.code)} />
                        <RateCell value={k ? rate(k.paid, k.sent) : null} target={f.target_success} />
                        <RateCell value={k ? rate(k.complete, k.eligible) : null} target={f.target_complete} />
                        <td className="num">{k ? money(k.not_sent_amount) : '–'}</td>
                      </>
                    )}
                    <td className="num">{k ? money(k.stm_amount) : '–'}</td>
                    <td className="num">{k?.pending ? `${int(k.pending)} visit` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted mb-0 mt-2">
          อัตราการส่งเบิก = visit ที่พบใน REP ÷ visit ที่เข้าเกณฑ์, อัตราเคลมสำเร็จ = ได้รับเงิน ÷ ที่พบใน REP,
          ความครบถ้วน = visit ที่มีเลขบัตร 13 หลัก มี PDX และไม่ขาดรายการจำเป็น ÷ visit ที่เข้าเกณฑ์
          ลูกศรเทียบอัตราการส่งเบิกของเดือนปิดยอดล่าสุดกับเดือนก่อนหน้า
        </p>
      </div>

      {/* ---------- รายเดือน ---------- */}
      <div className="panel">
        <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
          <span className="panel-title mb-0 me-2">รายเดือน</span>
          <button type="button" className={`chip ${!chartFund ? 'active' : ''}`} onClick={() => setChartFund('')}>ทุกกองทุน</button>
          {data?.funds.filter((f) => f.kpi).map((f) => (
            <button key={f.code} type="button" className={`chip ${chartFund === f.code ? 'active' : ''}`} onClick={() => setChartFund(f.code)}>
              {f.code}
            </button>
          ))}
        </div>
        {monthly.length > 0 && <KpiMonthlyChart months={monthly} target={chartTarget} />}
      </div>

      {/* ---------- สถานะข้อมูล ---------- */}
      <div className="row g-3">
        <div className="col-lg-7">
          <div className="panel h-100">
            <div className="panel-title">REP ที่นำเข้าแล้ว (ปีงบ {fy})</div>
            {data?.rounds.length ? (
              <div className="table-wrap">
                <table className="table table-sm data-table mb-0">
                  <thead><tr><th>เลขที่ REP</th><th>เดือนของรอบ</th><th className="num">รายการ</th><th>วันที่รับบริการในรอบ</th></tr></thead>
                  <tbody>
                    {data.rounds.map((r) => (
                      <tr key={`${r.stm_doc}-${r.stm_period}`}>
                        <td>{r.stm_doc || <span className="muted">ไม่ระบุ</span>}</td>
                        <td>{r.stm_period ? thaiMonth(r.stm_period.slice(0, 7)) : '–'}</td>
                        <td className="num">{int(r.lines)}</td>
                        <td>{thaiDate(r.date_min)} – {thaiDate(r.date_max)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted mb-0">ยังไม่มี REP ของปีงบนี้</p>}
          </div>
        </div>
        <div className="col-lg-5">
          <div className="panel h-100">
            <div className="panel-title">ความพร้อมของข้อมูล</div>
            <ul className="list-unstyled mb-0 data-status">
              <li>
                <i className={`bi ${pendingMonths.length ? 'bi-hourglass-split text-warning-emphasis' : 'bi-check-circle text-success'}`} />
                {pendingMonths.length
                  ? <>เดือนที่ยังไม่มี REP (รอผล): {pendingMonths.map(thaiMonth).join(', ')}</>
                  : 'ทุกเดือนที่ผ่านมามี REP แล้ว'}
              </li>
              <li>
                <i className={`bi ${data?.notPulledMonths?.length ? 'bi-exclamation-triangle text-danger' : 'bi-check-circle text-success'}`} />
                {data?.notPulledMonths?.length
                  ? <>ยังไม่ได้ดึงข้อมูล HOSxP: {data.notPulledMonths.filter((m) => monthsOfFy.includes(m)).map(thaiMonth).join(', ') || '–'}</>
                  : 'ดึงข้อมูล HOSxP ครบทุกเดือน'}
              </li>
              {data?.stalePulledMonths?.length > 0 && (
                <li>
                  <i className="bi bi-arrow-repeat text-warning-emphasis" />
                  ควรดึงข้อมูล HOSxP ใหม่ (มีการแก้ไขรายการในกองทุน): {data.stalePulledMonths.map(thaiMonth).join(', ')}
                </li>
              )}
              {data && (
                <li className="small muted mt-2">ข้อมูล ณ {thaiDateTime(data.generatedAt)}</li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
