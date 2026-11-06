import { useMemo, useState } from 'react';
import { int, thaiDate, thaiMonth } from '../utils/format.js';

/* =====================================================================
 * ช่วงวันที่ของข้อมูลแต่ละแหล่ง: HOSxP · ทะเบียน · REP · Statement มีข้อมูลวันไหน และวันไหนตกหล่น
 *  เขียว = มีข้อมูลครบ · เหลือง = มีบางส่วนยังขาด · แดง = ควรมีแต่ไม่มี · เทา = ไม่มีรายการวันนั้น
 *  กดช่องวันที่ = ดูรายชื่อของวันนั้น
 * ===================================================================== */
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const short = (d) => thaiDate(d).slice(0, 5);

/** ['2026-09-01','2026-09-02','2026-09-05'] -> [['2026-09-01','2026-09-02'],['2026-09-05','2026-09-05']] */
function toRanges(days) {
  const out = [];
  days.forEach((d) => {
    const last = out[out.length - 1];
    if (last && addDays(last[1], 1) === d) last[1] = d; else out.push([d, d]);
  });
  return out;
}
const rangeText = (rs, max = 6) => {
  const t = rs.slice(0, max).map(([a, b]) => (a === b ? thaiDate(a) : `${thaiDate(a)}–${thaiDate(b)}`)).join(', ');
  return rs.length > max ? `${t} และอีก ${rs.length - max} ช่วง` : t;
};

const SOURCES = [
  {
    key: 'his', label: 'HOSxP', icon: 'bi-hospital',
    level: (x) => (!x.pulled ? 'bad' : x.his > 0 ? 'ok' : 'none'),
    tip: (x) => (!x.pulled ? 'ยังไม่ได้ดึงข้อมูล HOSxP วันนี้' : `${x.his} visit`),
  },
  {
    key: 'reg', label: 'ทะเบียน', icon: 'bi-journal-text',
    level: (x) => (x.regGap.length ? 'bad' : x.reg > 0 ? (x.regNoHis || x.notInReg ? 'warn' : 'ok') : 'none'),
    tip: (x, names) => [
      x.reg ? `ในทะเบียน ${x.reg} คน` : null,
      x.regNoHis ? `ไม่พบใน HOSxP ${x.regNoHis} คน` : null,
      x.notInReg ? `HOSxP มีแต่ไม่อยู่ในทะเบียน ${x.notInReg} คน` : null,
      x.regGap.length ? `ไม่มีทะเบียน: ${x.regGap.map((c) => names.get(c) || c).join(', ')} (HOSxP มีค่าใช้จ่ายของห้องนี้)` : null,
    ].filter(Boolean).join('\n') || 'ไม่มีทะเบียนวันนี้',
  },
  {
    key: 'rep', label: 'REP', icon: 'bi-cloud-check',
    level: (x) => (x.elig > 0 && x.sent === 0 ? 'bad' : x.notSent > 0 ? 'warn' : x.elig > 0 || x.repLines > 0 ? 'ok' : 'none'),
    tip: (x) => [`เข้าเกณฑ์ ${x.elig} visit · พบใน REP ${x.sent}`, x.notSent ? `ยังไม่พบใน REP ${x.notSent} visit` : null, `REP ${x.repLines} รายการ`]
      .filter(Boolean).join('\n'),
  },
  {
    key: 'stm', label: 'Statement', icon: 'bi-bank',
    level: (x) => (x.stmBase > 0 && x.stm === 0 ? 'bad' : x.waitStm > 0 ? 'warn' : x.stm > 0 || x.stmLines > 0 ? 'ok' : 'none'),
    tip: (x) => [x.stmBase ? `REP จ่ายแล้ว (ต้องมี Statement) ${x.stmBase} visit · พบใน Statement ${x.stm}` : null,
      x.waitStm ? `รอ Statement ${x.waitStm} visit` : null, `Statement ${x.stmLines} รายการ`].filter(Boolean).join('\n'),
  },
];

export default function DataCoverage({ coverage, onPickDay , defaultOpen = true }) {
  const [show, setShow] = useState(defaultOpen);
  const { days = [], ranges = {} } = coverage || {};
  const names = useMemo(() => new Map((ranges.registry || []).map((r) => [r.code, r.name])), [ranges.registry]);

  // วันที่ตกหล่นของแต่ละแหล่ง
  const gaps = useMemo(() => {
    const pick = (f) => toRanges(days.filter(f).map((x) => x.d));
    const sum = (f, k) => days.filter(f).reduce((a, x) => a + x[k], 0);
    return {
      his: pick((x) => !x.pulled),
      reg: (ranges.registry || []).map((r) => ({ ...r, gap: pick((x) => x.regGap.includes(r.code)) })),
      regNoHis: sum((x) => x.regNoHis > 0, 'regNoHis'),
      rep: pick((x) => x.notSent > 0), repVisits: sum((x) => x.notSent > 0, 'notSent'),
      stm: pick((x) => x.waitStm > 0), stmVisits: sum((x) => x.waitStm > 0, 'waitStm'),
    };
  }, [days, ranges.registry]);

  const months = useMemo(() => {
    const m = new Map();
    days.forEach((x) => (m.get(x.d.slice(0, 7)) || m.set(x.d.slice(0, 7), []).get(x.d.slice(0, 7))).push(x));
    return [...m];
  }, [days]);
  if (!days.length) return null;

  const anyGap = gaps.his.length || gaps.reg.some((r) => r.gap.length) || gaps.rep.length || gaps.stm.length;

  return (
    <div className="panel">
      <div className="d-flex flex-wrap align-items-center gap-2">
        <button type="button" className="btn btn-link p-0" onClick={() => setShow((v) => !v)} aria-expanded={show}>
          <i className={`bi ${show ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`} />ช่วงวันที่ของข้อมูลแต่ละแหล่ง
        </button>
        {anyGap
          ? <span className="small text-danger"><i className="bi bi-exclamation-triangle me-1" />มีวันที่ที่ข้อมูลยังไม่ครบ</span>
          : <span className="small text-success"><i className="bi bi-check-circle me-1" />ทุกแหล่งครอบคลุมช่วงวันที่นี้</span>}
      </div>
      {show && (
        <>
          <ul className="cov-list mt-2">
            <li>
              <i className="bi bi-hospital me-1" /><strong>HOSxP</strong>{' '}
              {ranges.his?.length ? <>ดึงแล้ว {rangeText(ranges.his)}</> : <span className="text-danger">ยังไม่ได้ดึงข้อมูลช่วงนี้</span>}
              {gaps.his.length > 0 && ranges.his?.length > 0 && <span className="text-danger"> · ยังไม่ดึง {rangeText(gaps.his)}</span>}
            </li>
            <li>
              <i className="bi bi-journal-text me-1" /><strong>ทะเบียน</strong>{' '}
              {!gaps.reg.length && <span className="muted">ยังไม่มีห้อง/แผนกที่ส่งทะเบียน</span>}
              {gaps.reg.map((r) => (
                <span key={r.code} className="d-block ms-3">
                  {r.name}: {r.ranges.length ? <>มีทะเบียน {rangeText(r.ranges)}</> : <span className="text-danger">ไม่มีทะเบียนในช่วงนี้</span>}
                  {r.gap.length > 0 && <span className="text-danger"> · ขาดทะเบียน (HOSxP มีค่าใช้จ่ายของห้องนี้) {rangeText(r.gap)}</span>}
                </span>
              ))}
              {gaps.regNoHis > 0 && <span className="d-block ms-3 text-danger">อยู่ในทะเบียนแต่ไม่พบใน HOSxP รวม {int(gaps.regNoHis)} คน</span>}
            </li>
            <li>
              <i className="bi bi-cloud-check me-1" /><strong>REP</strong>{' '}
              {ranges.rep ? <>ข้อมูลวันที่ {thaiDate(ranges.rep.first)}–{thaiDate(ranges.rep.last)} ({int(ranges.rep.days)} วัน, {int(ranges.rep.lines)} รายการ)</> : <span className="text-danger">ยังไม่มี REP ในช่วงนี้</span>}
              {gaps.rep.length > 0 && <span className="text-danger"> · ยังไม่พบใน REP {int(gaps.repVisits)} visit วันที่ {rangeText(gaps.rep)}</span>}
            </li>
            <li>
              <i className="bi bi-bank me-1" /><strong>Statement</strong>{' '}
              {ranges.stm ? <>ข้อมูลวันที่ {thaiDate(ranges.stm.first)}–{thaiDate(ranges.stm.last)} ({int(ranges.stm.days)} วัน, {int(ranges.stm.lines)} รายการ)</> : <span className="muted">ยังไม่มี Statement ในช่วงนี้</span>}
              {gaps.stm.length > 0 && <span className="text-danger"> · รอ Statement {int(gaps.stmVisits)} visit วันที่ {rangeText(gaps.stm)}</span>}
            </li>
          </ul>

          <div className="cov-legend small muted mb-1">
            <span><i className="cov-cell ok" />มีข้อมูล</span><span><i className="cov-cell warn" />มีบางส่วนยังขาด</span>
            <span><i className="cov-cell bad" />ควรมีแต่ไม่มี</span><span><i className="cov-cell none" />ไม่มีรายการ</span>
            <span>· ชี้ช่องเพื่อดูจำนวน กดเพื่อดูรายชื่อวันนั้น</span>
          </div>
          <div className="cov-months">
            {months.map(([ym, list]) => (
              <div key={ym} className="cov-month">
                <div className="cov-mhead">{thaiMonth(ym)}</div>
                <table className="cov-grid">
                  <thead>
                    <tr><th />{list.map((x) => <th key={x.d} className={new Date(`${x.d}T00:00:00`).getDay() % 6 === 0 ? 'we' : ''}>{Number(x.d.slice(8))}</th>)}</tr>
                  </thead>
                  <tbody>
                    {SOURCES.map((src) => (
                      <tr key={src.key}>
                        <th scope="row"><i className={`bi ${src.icon} me-1`} />{src.label}</th>
                        {list.map((x) => {
                          const lv = src.level(x);
                          const tip = `${src.label} ${short(x.d)}\n${src.tip(x, names)}`;
                          return (
                            <td key={x.d}>
                              <button type="button" className={`cov-cell ${lv}`} title={tip} aria-label={tip.replace(/\n/g, ', ')}
                                onClick={() => onPickDay(x.d)} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
