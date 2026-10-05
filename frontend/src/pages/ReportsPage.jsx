import { useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';
import PeriodFields from '../components/PeriodFields.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { showError } from '../utils/alert.js';
import { FUNDS, int, lastMonthRange, rangeErrorOf } from '../utils/format.js';

const ICONS = {
  eligible: 'bi-people',
  not_sent: 'bi-send-exclamation',
  failed: 'bi-x-octagon',
  incomplete: 'bi-clipboard-x',
  paid: 'bi-cash-coin',
  extra_paid: 'bi-search',
};

export default function ReportsPage() {
  const { user } = useAuth();
  const [types, setTypes] = useState([]);
  const [funds, setFunds] = useState([]);
  const [type, setType] = useState('not_sent');
  const [range, setRange] = useState(lastMonthRange());
  const [pttype, setPttype] = useState('');
  const [selected, setSelected] = useState([]);
  const [split, setSplit] = useState(true);
  const [count, setCount] = useState(null);
  const [counting, setCounting] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/reports/types'), api.get('/funds')])
      .then(([t, f]) => {
        setTypes(t.data);
        const active = f.data.filter((x) => x.is_active);
        setFunds(active);
        // ค่าเริ่มต้น: กองทุนที่ผู้ใช้รับผิดชอบ ถ้าไม่ได้กำหนดไว้ ใช้ทุกกองทุน
        const mine = (user.fund_codes || []).filter((c) => active.some((x) => x.code === c));
        setSelected(mine.length ? mine : active.map((x) => x.code));
      })
      .catch(showError);
  }, [user.fund_codes]);

  const rangeError = rangeErrorOf(range);
  const params = useMemo(() => ({
    type, ...range, fund: pttype || undefined, fundCodes: selected.join(','), split: split ? '1' : '0',
  }), [type, range, pttype, selected, split]);

  // นับจำนวนรายการก่อนส่งออก
  useEffect(() => {
    if (rangeError || !selected.length) { setCount(null); return undefined; }
    let alive = true;
    setCounting(true);
    const t = setTimeout(() => {
      api.get('/reports/funds/count', { params })
        .then((r) => alive && setCount(r.data))
        .catch((err) => alive && showError(err, 'นับจำนวนรายการไม่สำเร็จ'))
        .finally(() => alive && setCounting(false));
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [params, rangeError, selected.length]);

  const toggle = (code) => setSelected((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));
  const exportUrl = `/api/reports/funds?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined))}`;
  const canExport = !rangeError && selected.length > 0 && count?.total > 0;
  const mine = user.fund_codes || [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ส่งออกรายงาน</h1>
          <p>เลือกรายงานและกองทุนที่รับผิดชอบ แล้วส่งออกเป็น Excel ไปใช้ตรวจสอบและแก้ไขต่อ ไฟล์มีชีตสรุป และคอลัมน์ “ผลการแก้ไข / หมายเหตุ” ไว้ให้กรอก</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">1. เลือกรายงาน</div>
        <div className="report-types">
          {types.map((t) => (
            <label key={t.key} className={`report-type ${type === t.key ? 'active' : ''}`}>
              <input type="radio" name="rtype" className="visually-hidden" checked={type === t.key} onChange={() => setType(t.key)} />
              <i className={`bi ${ICONS[t.key] || 'bi-file-earmark'}`} aria-hidden="true" />
              <span>
                <span className="title">{t.title}</span>
                <span className="desc">{t.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">2. ช่วงวันที่และกองทุน</div>
        <div className="row g-3 align-items-end mb-3">
          <PeriodFields idPrefix="rp" value={range} onChange={setRange} />
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="rp-pt">กรองเพิ่มตามกลุ่มสิทธิ</label>
            <select id="rp-pt" className="form-select" value={pttype} onChange={(e) => setPttype(e.target.value)}>
              {FUNDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
        </div>
        {rangeError && <div className="text-danger small mb-2">{rangeError}</div>}

        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <span className="small muted me-1">กองทุน:</span>
          {funds.map((f) => (
            <button key={f.code} type="button" className={`chip ${selected.includes(f.code) ? 'active' : ''}`}
              onClick={() => toggle(f.code)} title={f.name} aria-pressed={selected.includes(f.code)}>
              {f.code}{mine.includes(f.code) && <i className="bi bi-person-check ms-1" aria-label="รับผิดชอบ" />}
              {count?.byFund?.[f.code] > 0 && <span className="ms-1 opacity-75">({int(count.byFund[f.code])})</span>}
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-link" onClick={() => setSelected(funds.map((f) => f.code))}>เลือกทั้งหมด</button>
          {mine.length > 0 && (
            <button type="button" className="btn btn-sm btn-link" onClick={() => setSelected(mine.filter((c) => funds.some((f) => f.code === c)))}>
              เฉพาะที่รับผิดชอบ
            </button>
          )}
        </div>
        {mine.length === 0 && (
          <p className="small muted mb-0">
            <i className="bi bi-info-circle me-1" />ยังไม่ได้กำหนดกองทุนที่คุณรับผิดชอบ ผู้ดูแลระบบกำหนดได้ในหน้า “ผู้ใช้งาน”
          </p>
        )}
      </div>

      <div className="panel d-flex flex-wrap justify-content-between align-items-center gap-3">
        <div>
          <div className="panel-title mb-1">3. ส่งออก</div>
          <div className="muted">
            {counting && <span className="spinner-border spinner-border-sm me-2" role="status" />}
            {!selected.length ? 'กรุณาเลือกกองทุนอย่างน้อย 1 กองทุน'
              : count ? <>พบ <strong className="text-body">{int(count.total)}</strong> รายการ จากคนไข้ {int(count.patients)} คน</>
                : 'กำลังนับจำนวนรายการ…'}
          </div>
          <div className="form-check mt-2">
            <input id="rp-split" type="checkbox" className="form-check-input" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            <label className="form-check-label" htmlFor="rp-split">แยกชีตตามกองทุน</label>
          </div>
        </div>
        <a className={`btn btn-primary btn-lg ${canExport ? '' : 'disabled'}`} href={canExport ? exportUrl : undefined}
          aria-disabled={!canExport}>
          <i className="bi bi-file-earmark-excel me-2" />ส่งออก Excel
        </a>
      </div>
    </>
  );
}
