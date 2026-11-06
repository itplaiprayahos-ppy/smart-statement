import { Fragment, useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import Pagination from './Pagination.jsx';
import PeriodFields from './PeriodFields.jsx';
import { showError } from '../utils/alert.js';
import { DATA_CHANGED } from '../utils/dataEvents.js';
import { int, money, rangeErrorOf, thaiDate } from '../utils/format.js';

/* =====================================================================
 * ติดตามทะเบียน (v53): ขั้นตอนเรียงแนวนอน กดขั้นไหน เห็นรายการที่ติดขั้นนั้น
 *  ทุกช่องใช้ฐานเดียวกัน = จำนวนรายการในทะเบียน (1 รายการ = คน 1 คนใน 1 วัน)
 * ===================================================================== */
const PAGE_SIZE = 20;
const STEP_NAME = { 1: 'หาใน HOSxP ไม่เจอ', 2: 'เบิกไม่ได้', 3: 'ยังไม่ส่งเบิก', 4: 'ยังไม่ได้รับเงิน', 5: 'ยังไม่มีเงินเข้า' };

/** จุด 4 จุด: ทะเบียน → HOSxP → REP → STM (เขียว = มี · เหลือง = มีแต่มีปัญหา · เทา = ไม่มี) */
function Dots({ x }) {
  const s = x.sources || {};
  const has = (v) => v !== null && v !== undefined;
  const list = [
    ['ทะเบียน', x.stage === null ? 'na' : x.diffFlag ? 'warn' : 'ok'],
    ['HOSxP', has(s.his) ? (x.stage === 2 ? 'warn' : 'ok') : 'na'],
    ['REP', s.rep ? (x.stage === 4 ? 'warn' : 'ok') : 'na'],
    ['STM', has(s.stm) ? 'ok' : 'na'],
  ];
  const full = list.map(([n, st]) => `${n}: ${st === 'ok' ? 'มี' : st === 'warn' ? 'มีแต่มีปัญหา' : 'ไม่มี'}`).join(', ');
  return (
    <div className="src-dots" title={full} aria-label={full}>
      <div className="pt-prog">
        {list.map(([n, st], i) => (
          <Fragment key={n}>
            {i > 0 && <b className={st !== 'na' && list[i - 1][1] !== 'na' ? 'done' : ''} />}
            <i className={st === 'ok' ? 'done' : st === 'warn' ? 'warn' : ''} />
          </Fragment>
        ))}
      </div>
      <div className="src-names">{list.map(([n, st]) => <span key={n} className={st}>{n}</span>)}</div>
    </div>
  );
}

function Sources({ x }) {
  const s = x.sources || {};
  const cell = (name, ok, text) => (
    <div className="trk-src"><b>{name}</b><span className={ok ? 'y' : 'n'}>{ok ? '✓' : '✗'}</span> {text}</div>
  );
  return (
    <div className="trk-srcs">
      {cell('ทะเบียน', true, s.reg !== null && s.reg !== undefined ? `ยอด ${money(s.reg)}` : `HN ${x.hn || '-'}`)}
      {cell('HOSxP', s.his !== null && s.his !== undefined, s.his !== null && s.his !== undefined ? `ค่าใช้จ่าย ${money(s.his)}${s.pttype ? ` · ${s.pttype}` : ''}` : 'ไม่พบ visit')}
      {cell('ผลการส่งเบิก (REP)', !!s.rep, s.rep ? `TRAN_ID ${s.rep.tran_id || '-'} · ได้รับ ${money(s.rep.paid)}${s.rep.error ? ` · ติด ${s.rep.error}` : ''}` : 'ยังไม่มี')}
      {cell('เงินเข้า (Statement)', s.stm !== null && s.stm !== undefined, s.stm !== null && s.stm !== undefined ? `โอนจริง ${money(s.stm)}` : 'ยังไม่มี')}
    </div>
  );
}

export default function RegistryTracker({ range, onRange, point, onPoint, points, reloadKey, initialSel = null }) {
  const [sel, setSel] = useState(initialSel);           // all | 1-5 | done | out | diff (null = เลือกขั้นแรกที่มีคนติด)
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [input, setInput] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);
  const rangeError = rangeErrorOf(range);

  const load = useCallback((fresh = false) => {
    if (rangeError) return;
    setLoading(true);
    api.get('/patients/track', {
      params: { dateFrom: range.dateFrom, dateTo: range.dateTo, point: point || undefined, sel: sel || 'all', search: search || undefined, page, pageSize: PAGE_SIZE, fresh: fresh ? 1 : undefined },
    }).then((r) => {
      // ครั้งแรก: เปิดขั้นแรกที่มีรายการติด
      if (!sel) {
        const first = r.data.steps.find((s) => s.stuckCount > 0);
        if (first) { setSel(String(first.k)); return; }
        setSel('all');
      }
      setData(r.data);
    }).catch((err) => showError(err, 'โหลดข้อมูลทะเบียนไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [range, point, sel, search, page, rangeError]);
  useEffect(() => { load(); setOpen(null); }, [load, reloadKey]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener(DATA_CHANGED, h);
    return () => window.removeEventListener(DATA_CHANGED, h);
  }, [load]);

  const pick = (v) => { setSel(v); setPage(1); setOpen(null); };
  const exportUrl = `/api/patients/track/export?${new URLSearchParams(Object.entries({
    dateFrom: range.dateFrom, dateTo: range.dateTo, point: point || '', sel: sel || 'all', search,
  }).filter(([, v]) => v))}`;

  const d = data;
  const step = d && /^[1-5]$/.test(String(sel)) ? d.steps.find((s) => String(s.k) === String(sel)) : null;
  const title = !d ? '' : sel === 'out' ? `มาใช้บริการแต่ไม่มีชื่อในทะเบียน ${int(d.count)} ราย`
    : sel === 'diff' ? `ยอดเงินในทะเบียนไม่ตรงกับ HOSxP ${int(d.count)} ราย`
      : sel === 'done' ? `ครบทุกขั้นแล้ว ${int(d.count)} ราย`
        : step ? `ติดที่ขั้น “${step.label}” ${int(d.count)} ราย · ${step.stuck}` : `ทุกรายการในทะเบียน ${int(d.count)} ราย`;
  const hint = !d ? '' : sel === 'out' ? 'HOSxP มีค่าใช้จ่ายของห้องในวันที่ส่งทะเบียน แต่ทะเบียนไม่ได้จดไว้ ให้หน้างานเพิ่มชื่อแล้วอัปโหลดใหม่'
    : sel === 'diff' ? 'คนตรงกัน แต่ยอดเงินต่างกัน (ไม่นับว่าติด)'
      : sel === 'done' ? 'เงินเข้าแล้ว ไม่ต้องทำอะไรต่อ'
        : step ? step.hint : `ครบทุกขั้นแล้ว ${int(d.done)} ราย · ยังไม่ครบ ${int(d.total - d.done)} ราย`;
  const showStageCol = sel === 'all' || sel === 'diff';
  const allRooms = !point;

  return (
    <>
      <div className="panel">
        <div className="row g-3 align-items-end">
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="trk-room">ห้อง/แผนก</label>
            <select id="trk-room" className="form-select" value={point || ''} onChange={(e) => { onPoint(e.target.value || null); setSel(null); setPage(1); }}>
              <option value="">ทุกห้อง/แผนก</option>
              {points.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </div>
          <PeriodFields idPrefix="trk" value={range} onChange={(v) => { onRange(v); setSel(null); setPage(1); }} />
        </div>
        {rangeError && <div className="text-danger small mt-2">{rangeError}</div>}
      </div>

      {!d && loading && <div className="panel text-center py-5 muted"><span className="spinner-border spinner-border-sm me-2" />กำลังคำนวณ…</div>}
      {d && d.total === 0 && (
        <div className="panel text-center py-5">
          <div className="fs-1">📄</div>
          <h5 className="mt-2">ยังไม่มีทะเบียนในช่วงวันที่{point ? 'และห้อง/แผนก' : ''}นี้</h5>
          <p className="muted mb-0">กด “อัปโหลดทะเบียน” ด้านบน ระบบจะเทียบกับ HOSxP และบอกว่าแต่ละรายการติดอยู่ที่ขั้นไหน</p>
        </div>
      )}

      {d && d.total > 0 && (
        <>
          <div className={`trk-steps ${loading ? 'is-loading' : ''}`} role="group" aria-label="ขั้นตอน กดเพื่อดูรายชื่อที่ติดขั้นนั้น">
            <button type="button" className={`trk-st ${sel === 'all' ? 'on' : ''}`} onClick={() => pick('all')} title="ดูทุกรายการในทะเบียน">
              <span className="lb">อยู่ในทะเบียน</span><span className="num">{int(d.total)}</span><span className="of">ราย</span>
              <span className="clear muted">ดูทั้งหมด</span>
            </button>
            {d.steps.map((s) => (
              <Fragment key={s.k}>
                <span className="trk-arrow" aria-hidden="true">›</span>
                <button type="button" className={`trk-st ${String(sel) === String(s.k) ? 'on' : ''} ${s.k === 5 ? 'last' : ''}`}
                  onClick={() => pick(String(s.k))} title={`ดูรายการที่ติดขั้นนี้ ${s.stuckCount} ราย`}>
                  <span className="lb">{s.label}</span>
                  <span className="num">{int(s.reached)}</span>
                  <span className="of">จาก {int(d.total)} ราย</span>
                  {s.stuckCount > 0 ? <span className="stuck">ติด {int(s.stuckCount)}</span> : <span className="clear">✓ ครบ</span>}
                </button>
              </Fragment>
            ))}
          </div>
          <div className="trk-notes">
            {d.out > 0 && <button type="button" className={sel === 'out' ? 'on' : ''} onClick={() => pick('out')}>+{int(d.out)} รายมาใช้บริการแต่ไม่มีชื่อในทะเบียน</button>}
            {d.diff > 0 && <button type="button" className={sel === 'diff' ? 'on' : ''} onClick={() => pick('diff')}>ยอดเงินในทะเบียนไม่ตรง HOSxP {int(d.diff)} ราย</button>}
            {d.done > 0 && <button type="button" className={`ok ${sel === 'done' ? 'on' : ''}`} onClick={() => pick('done')}>ครบทุกขั้นแล้ว {int(d.done)} ราย</button>}
            <span>
              ข้อมูล HOSxP ถึง {d.dates.his ? thaiDate(d.dates.his) : '–'} · ผลการส่งเบิกถึง {d.dates.rep ? thaiDate(d.dates.rep) : '–'} · เงินเข้าถึง {d.dates.stm ? thaiDate(d.dates.stm) : '–'}
            </span>
          </div>

          <div className="panel trk-list" id="trk-list">
            <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
              <div>
                <h5 className="mb-0">{title}</h5>
                <div className="small muted">{hint}</div>
              </div>
              <div className="d-flex gap-2 align-items-center">
                {loading && <span className="spinner-border spinner-border-sm text-secondary" />}
                <form className="input-group input-group-sm" style={{ width: 220 }} onSubmit={(e) => { e.preventDefault(); setSearch(input.trim()); setPage(1); }}>
                  <input className="form-control" placeholder="ค้นหา HN / ชื่อ" value={input} onChange={(e) => setInput(e.target.value)} aria-label="ค้นหา" />
                  <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
                </form>
                <a className={`btn btn-sm btn-outline-secondary ${d.count ? '' : 'disabled'}`} href={exportUrl}>
                  <i className="bi bi-file-earmark-excel me-1" />Excel
                </a>
              </div>
            </div>
            {!d.rows.length ? (
              <div className="text-center text-success py-4 fw-semibold">✓ ไม่มีรายการ{search ? 'ตามคำค้นหา' : ''}</div>
            ) : (
              <div className="table-wrap">
                <table className="table data-table trk-table mb-0">
                  <thead>
                    <tr>
                      <th>วันที่</th><th>HN</th><th>ชื่อ</th>{allRooms && <th>ห้อง/แผนก</th>}
                      <th title="พบในทะเบียน / HOSxP / REP / Statement หรือไม่">ทะเบียน · HOSxP · REP · STM</th>
                      {showStageCol && <th>ติดที่ขั้น</th>}
                      <th>สาเหตุ</th><th>ต้องทำอะไร</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((x) => {
                      const isOpen = open === x.key;
                      const cols = 7 + (allRooms ? 1 : 0) + (showStageCol ? 1 : 0);
                      return (
                        <Fragment key={x.key}>
                          <tr className={`trk-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : x.key)} tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter') setOpen(isOpen ? null : x.key); }} aria-expanded={isOpen}>
                            <td className="text-nowrap">{thaiDate(x.sdate)}</td>
                            <td className="fw-semibold">{x.hn || '–'}</td>
                            <td>{x.patient_name}</td>
                            {allRooms && <td className="small muted">{x.rooms}</td>}
                            <td className="prog-cell"><Dots x={x} /></td>
                            {showStageCol && (
                              <td>{x.stage === 6 ? <span className="text-success fw-semibold">✓ ครบ</span>
                                : x.stage ? <span className="todo-k bad">{x.stage}. {STEP_NAME[x.stage]}</span> : '–'}</td>
                            )}
                            <td className="small">{x.cause}</td>
                            <td>
                              {x.todo ? <span className={x.wait ? 'muted' : 'fw-semibold'}>{x.todo}</span> : <span className="muted">–</span>}
                              {x.wait && <span className="badge text-bg-light border ms-1">รอผล</span>}
                            </td>
                          </tr>
                          {isOpen && <tr className="detail-row"><td colSpan={cols}><Sources x={x} /></td></tr>}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
              <span className="small muted">คลิกแถวเพื่อดูว่าพบในแหล่งไหนบ้าง</span>
              <Pagination page={page} pageSize={PAGE_SIZE} total={d.count} onChange={setPage} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
