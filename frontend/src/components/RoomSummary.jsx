import { useState } from 'react';
import { int } from '../utils/format.js';

/**
 * สรุปตามห้อง/แผนก: แต่ละห้องไปถึงขั้นไหน และตกหล่นที่ขั้นไหน (นับคน)
 * กดตัวเลขสีแดง = ดูรายชื่อที่ตกหล่นขั้นนั้นของห้องนั้น
 */
const COLS = [
  { key: 'served', label: 'พบใน HOSxP', drop: 1 },
  { key: 'eligible', label: 'เข้าเกณฑ์', drop: 2 },
  { key: 'sent', label: 'ส่งเบิก', drop: 3 },
  { key: 'paid', label: 'ได้รับเงิน', drop: 4 },
  { key: 'stm', label: 'ได้รับโอนจริง', drop: 5 },
];

export default function RoomSummary({ rooms, isReg, selected, onPick , defaultOpen = true }) {
  const [show, setShow] = useState(defaultOpen);
  if (!rooms?.length) return null;
  const sel = new Set(selected || []);
  const done = (r) => (isReg ? r.registry > 0 && Object.values(r.drops).every((n) => n === 0) && r.notInReg === 0 : false);
  return (
    <div className="panel">
      <div className="d-flex flex-wrap align-items-center gap-2">
        <button type="button" className="btn btn-link p-0" onClick={() => setShow((v) => !v)} aria-expanded={show}>
          <i className={`bi ${show ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`} />
          สรุปตามห้อง/แผนก ({rooms.length} ห้อง)
        </button>
        <span className="small muted">
          {isReg ? 'นับคนในทะเบียนของแต่ละห้อง' : 'นับคนที่มีค่าใช้จ่ายหรือมีชื่อในทะเบียนของห้อง'} · ตัวเลขสีแดง = ตกหล่นที่ขั้นนั้น กดเพื่อดูรายชื่อ
        </span>
      </div>
      {show && (
        <div className="table-wrap mt-2">
          <table className="table table-sm data-table room-sum mb-0">
            <thead>
              <tr>
                <th>ห้อง/แผนก</th>
                {isReg && <th className="num">ในทะเบียน</th>}
                {COLS.map((c) => <th key={c.key} className="num">{c.label}</th>)}
                <th className="num" title="HOSxP มีค่าใช้จ่ายของห้องนี้ในวันที่ส่งทะเบียน แต่ไม่อยู่ในทะเบียน">ไม่อยู่ในทะเบียน</th>
                <th className="num" title="ยอดในทะเบียนไม่ตรงกับค่าใช้จ่ายของห้องนี้ใน HOSxP">ยอดไม่ตรง</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.code} className={sel.has(r.code) ? 'table-active' : ''}>
                  <td>
                    {r.name}
                    {done(r) && <span className="badge text-bg-success ms-2">ครบทุกขั้น</span>}
                  </td>
                  {isReg && <td className="num fw-semibold">{int(r.registry)}</td>}
                  {COLS.map((c) => {
                    const value = c.key === 'stm' ? `${int(r.stm)}${r.stmBase ? ` / ${int(r.stmBase)}` : ''}` : int(r[c.key]);
                    const lost = r.drops[c.drop];
                    return (
                      <td key={c.key} className="num">
                        {c.key === 'stm' && !r.stmBase ? <span className="muted" title="ไม่มีกองทุนที่ต้องมี Statement">–</span> : value}
                        {lost > 0 && (
                          <button type="button" className="btn btn-link btn-sm p-0 ms-1 text-danger align-baseline"
                            title={`ตกหล่นที่ขั้นนี้ ${lost} คน: ดูรายชื่อ`} onClick={() => onPick(r.code, c.drop)}>
                            −{int(lost)}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className="num">{r.notInReg > 0 ? <span className="text-warning-emphasis">{int(r.notInReg)}</span> : <span className="muted">0</span>}</td>
                  <td className="num">{r.regDiff > 0 ? <span className="text-warning-emphasis">{int(r.regDiff)}</span> : <span className="muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
