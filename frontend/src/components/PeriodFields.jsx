import { PERIODS, periodOf, toIso } from '../utils/format.js';

/**
 * ช่องเลือกช่วงเวลา (เดือนที่แล้ว / ปีงบประมาณ) + วันที่เริ่มและสิ้นสุด
 * value = { dateFrom, dateTo }, onChange(nextRange)
 */
export default function PeriodFields({ value, onChange, idPrefix = 'p' }) {
  const choosePeriod = (e) => {
    const p = PERIODS.find((x) => x.value === e.target.value);
    if (p) onChange(p.range());
  };

  const setFrom = (e) => {
    const v = e.target.value;
    const next = { ...value, dateFrom: v };
    // เลือกวันเริ่มเลยวันสิ้นสุด: เลื่อนวันสิ้นสุดเป็นวันสุดท้ายของเดือนนั้น
    if (v && next.dateTo && v > next.dateTo) {
      const [y, m] = v.split('-').map(Number);
      next.dateTo = toIso(new Date(y, m, 0));
    }
    onChange(next);
  };

  return (
    <>
      <div className="col-sm-12 col-lg-2">
        <label className="form-label" htmlFor={`${idPrefix}-period`}>ช่วงเวลา</label>
        <select id={`${idPrefix}-period`} className="form-select" value={periodOf(value)} onChange={choosePeriod}>
          {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          <option value="custom" disabled>กำหนดเอง</option>
        </select>
      </div>
      <div className="col-sm-6 col-lg-2">
        <label className="form-label" htmlFor={`${idPrefix}-df`}>ตั้งแต่วันที่</label>
        <input id={`${idPrefix}-df`} type="date" className="form-control" value={value.dateFrom} onChange={setFrom} />
      </div>
      <div className="col-sm-6 col-lg-2">
        <label className="form-label" htmlFor={`${idPrefix}-dt`}>ถึงวันที่</label>
        <input id={`${idPrefix}-dt`} type="date" className="form-control" value={value.dateTo}
          onChange={(e) => onChange({ ...value, dateTo: e.target.value })} />
      </div>
    </>
  );
}
