import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SortTh from './SortTh.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useSort } from '../hooks/useSort.js';
import { int, money, thaiDate, thaiDateTime } from '../utils/format.js';

/* ส่วนประกอบที่ใช้ร่วมกันระหว่างหน้ารายชื่อคนไข้และหน้าเทียบ 3 แหล่ง:
 * ป๊อปอัปค่าใช้จ่ายแยกห้อง, ป้ายทะเบียน, กล่องรายละเอียด และประวัติอัปโหลดทะเบียน */

/** สถานะของแต่ละทะเบียนเทียบกับ HOSxP */
export const TAG_STYLE = {
  MATCH:           { cls: 'ok',      icon: 'bi-check-lg',          text: 'ตรงกับ HOSxP' },
  HIS_DIFF:        { cls: 'bad',     icon: 'bi-exclamation-lg',    text: 'ไม่ตรงกับ HOSxP' },
  NOT_IN_REGISTRY: { cls: 'missing', icon: 'bi-dash-lg',           text: 'มีใน HOSxP แต่ไม่อยู่ในทะเบียน' },
  NO_VISIT:        { cls: 'bad',     icon: 'bi-x-lg',              text: 'ไม่พบ visit ใน HOSxP' },
};
/** สถานะทะเบียนของแต่ละห้องในป๊อปอัปแยกห้อง */
export const DEP_REG = {
  ok:      { cls: 'ok',      text: 'ตรงทะเบียน' },
  diff:    { cls: 'bad',     text: 'ไม่ตรงทะเบียน' },
  missing: { cls: 'missing', text: 'ไม่อยู่ในทะเบียน' },
  none:    { cls: 'none',    text: 'ไม่มีทะเบียน' },
};

/* ---------- ป๊อปอัปค่าใช้จ่ายแยกตามห้อง (portal + fixed: ไม่ถูกกรอบเลื่อนของตารางตัด) ---------- */
const POP_W = 360;
export function DeptPopover({ pop, onEnter, onLeave, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const a = pop.rect; const h = el.offsetHeight; const vw = window.innerWidth; const vh = window.innerHeight;
    const left = Math.max(8, Math.min(a.right - POP_W, vw - POP_W - 8));
    const below = a.bottom + 6;
    const top = below + h > vh - 8 && a.top - h - 6 > 8 ? a.top - h - 6 : Math.min(below, Math.max(8, vh - h - 8));
    setPos({ left, top });
  }, [pop]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    const away = (e) => { if (pop.pinned && ref.current && !ref.current.contains(e.target) && !pop.anchor?.contains(e.target)) onClose(); };
    const gone = () => onClose();
    document.addEventListener('keydown', esc);
    document.addEventListener('mousedown', away);
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('keydown', esc); document.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', gone, true); window.removeEventListener('resize', gone);
    };
  }, [pop, onClose]);
  const r = pop.row;
  return createPortal(
    <div ref={ref} className="dept-pop" role="dialog" aria-label={`ค่าใช้จ่ายแยกตามห้อง VN ${r.vn}`}
      style={{ width: POP_W, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="dept-pop-head">ค่าใช้จ่ายใน HOSxP แยกตามห้อง <span className="small-id">VN {r.vn}</span></div>
      <BreakdownTable row={r} />
    </div>,
    document.body,
  );
}

/**
 * ค่าใช้จ่ายแยกตามห้อง: แผนกที่ผูกกับห้อง/แผนกเดียวกันอยู่กลุ่มเดียวกัน
 * สถานะทะเบียนแสดงครั้งเดียวต่อห้อง (เทียบยอดรวมของห้องกับทะเบียน)
 */
export function BreakdownTable({ row }) {
  if (!row.breakdown?.length) return <div className="small muted">ไม่มีค่าใช้จ่ายใน visit นี้</div>;
  return (
    <table className="table table-sm mb-0 dept-table">
      <tbody>
        {row.breakdown.map((g) => {
          const st = DEP_REG[g.reg] || DEP_REG.none;
          const grouped = g.code && (g.deps.length > 1 || g.reg !== 'none');
          // ค่าบริการอัตโนมัติ และยา แยกบรรทัด (ยอดยกเว้นรวม = ค่าบริการอัตโนมัติ + ยา)
          const optNote = (amt, drug = 0) => {
            const d = Math.min(Number(drug || 0), Number(amt || 0));
            const fee = Number(amt || 0) - d;
            return (
              <>
                {fee > 0 && <div className="small-id">ค่าบริการอัตโนมัติ {money(fee)}</div>}
                {d > 0 && <div className="small-id">ยา {money(d)}</div>}
              </>
            );
          };
          if (!grouped) {
            const d = g.deps[0];
            return (
              <tr key={`d-${d.dep}`}>
                <td>{d.name || `แผนก ${d.dep}`}{optNote(d.optional_amount, d.optional_drug_amount)}</td>
                <td className="num">{money(d.amount)}</td>
                <td className="reg-cell"><span className={`reg-state ${st.cls}`}>{st.text}</span></td>
              </tr>
            );
          }
          return (
            <Fragment key={`p-${g.code}`}>
              <tr className="room-head">
                <td>
                  {g.name}
                  <div className="small-id">
                    {g.reg_amount !== null ? `ทะเบียน ${money(g.reg_amount)}` : g.reg === 'missing' ? 'ไม่อยู่ในทะเบียน' : g.reg === 'none' ? 'ไม่มีทะเบียน' : 'ทะเบียนไม่มียอด'}
                    {g.note?.includes('ไม่รวม') && (() => {
                      const d = Math.min(Number(g.optional_drug_amount || 0), Number(g.optional_amount || 0));
                      const fee = Number(g.optional_amount || 0) - d;
                      return ` (ไม่รวม${[fee > 0 && `ค่าบริการอัตโนมัติ ${money(fee)}`, d > 0 && `ยา ${money(d)}`].filter(Boolean).join(' + ')})`;
                    })()}
                  </div>
                </td>
                <td className="num">{money(g.amount)}</td>
                <td className="reg-cell"><span className={`reg-state ${st.cls}`}>{st.text}</span></td>
              </tr>
              {g.deps.map((d) => (
                <tr key={d.dep} className="room-dep">
                  <td>{d.name || `แผนก ${d.dep}`}{optNote(d.optional_amount, d.optional_drug_amount)}</td>
                  <td className="num">{money(d.amount)}</td>
                  <td />
                </tr>
              ))}
            </Fragment>
          );
        })}
        <tr className="total"><td>รวมทั้ง visit</td><td className="num">{money(row.vn_total || 0)}</td><td /></tr>
      </tbody>
    </table>
  );
}

/* ---------- ป้ายทะเบียนในตาราง ---------- */
export function RegTags({ r }) {
  return (
    <div className="reg-tags">
      {r.registries.map((t) => {
        const st = TAG_STYLE[t.status] || TAG_STYLE.MATCH;
        return (
          <span key={`${t.kind}-${t.code}`} className={`reg-tag ${st.cls}`} title={`${t.full}: ${st.text}`}>
            <i className={`bi ${st.icon}`} aria-hidden="true" />{t.name}
            {t.inRegistry && t.amount !== null && <span className="amt">{money(t.amount)}</span>}
            {!t.inRegistry && <span className="amt">ไม่อยู่ในทะเบียน</span>}
          </span>
        );
      })}
    </div>
  );
}

/* ---------- รายละเอียดเมื่อคลิกแถว ---------- */
export function Field({ label, children }) {
  return <div className="d-flex justify-content-between gap-2"><span className="muted">{label}</span><span className="text-end">{children}</span></div>;
}
export function Box({ title, icon, bad, children }) {
  return (
    <div className={`src-box ${bad === null ? 'na' : bad ? 'bad' : 'ok'}`}>
      <div className="src-box-head"><i className={`bi ${icon} me-1`} />{title}
        {bad !== null && <i className={`bi ${bad ? 'bi-exclamation-circle-fill' : 'bi-check-circle-fill'} ms-auto`} aria-label={bad ? 'มีจุดที่ต่าง' : 'ปกติ'} />}
      </div>
      {children}
    </div>
  );
}

/** ยอดในทะเบียนของห้อง/แผนก */
export function regAmount(t) {
  if (!t.inRegistry) return <span className="text-danger-emphasis">ไม่อยู่ในทะเบียน</span>;
  return t.amount === null ? <span className="muted">ไม่มียอด</span> : money(t.amount);
}

/** ข้อความเมื่อตรง: ทะเบียนที่ไม่มียอด เทียบได้แค่รายชื่อ จึงบอกให้ชัดว่าตรงในเรื่องอะไร */
export const matchText = (t) => (t.amount === null
  ? 'พบค่าใช้จ่ายของห้องนี้ใน HOSxP (ทะเบียนไม่มียอด จึงเทียบเฉพาะรายชื่อ)'
  : 'ยอดตรงกับ HOSxP');

export function RegistryBox({ r }) {
  const bad = r.registries.some((t) => t.status !== 'MATCH');
  return (
    <Box title="ทะเบียน" icon="bi-journal-text" bad={bad}>
      {r.registries.map((t) => (
        <div key={`${t.kind}-${t.code}`} className="reg-entry small">
          <div className="d-flex justify-content-between gap-2"><span>{t.full}</span><span className="text-end text-nowrap fw-semibold">{regAmount(t)}</span></div>
          {t.status === 'MATCH'
            ? <div className="entry-ok">{matchText(t)}</div>
            : (
              <div className="entry-issue">
                <span className="fw-semibold">{t.label}</span>
                {t.issues.map((x) => <div key={x}>{x}</div>)}
              </div>
            )}
        </div>
      ))}
    </Box>
  );
}

/** เหตุผลที่กล่องขึ้นสีแดง (ใส่ไว้ในกล่องเลย ไม่ต้องเลื่อนลงไปดูด้านล่าง) */
export function BoxReason({ items }) {
  if (!items.length) return null;
  return <div className="entry-issue mb-2">{items.map((x) => <div key={x}>{x}</div>)}</div>;
}

/* ---------- ประวัติอัปโหลด (ทุกชนิดรวมกัน) ---------- */
export function UploadHistory({ uploads, onRemove }) {
  const { user, isAdmin } = useAuth();
  const [show, setShow] = useState(false);
  const s = useSort(uploads, { key: 'created_at', dir: 'desc' });
  return (
    <div className="panel">
      <button type="button" className="btn btn-link p-0" onClick={() => setShow((v) => !v)}>
        <i className={`bi ${show ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`} />ประวัติอัปโหลดทะเบียน ({uploads.length})
      </button>
      {show && (
        <div className="table-wrap mt-2">
          <table className="table table-sm data-table mb-0">
            <thead>
              <tr>
                <SortTh k="created_at" sort={s.sort} onSort={s.toggle}>เวลา</SortTh>
                <SortTh k="target_name" sort={s.sort} onSort={s.toggle}>ทะเบียน</SortTh>
                <SortTh k="file_name" sort={s.sort} onSort={s.toggle}>ไฟล์</SortTh>
                <SortTh k="date_from" sort={s.sort} onSort={s.toggle}>ช่วงวันที่</SortTh>
                <SortTh k="current_rows" sort={s.sort} onSort={s.toggle} className="num">ใช้อยู่</SortTh>
                <SortTh k="uploaded_by_name" sort={s.sort} onSort={s.toggle}>ผู้อัปโหลด</SortTh>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.sorted.map((b) => (
                <tr key={`${b.kind}-${b.id}`}>
                  <td className="text-nowrap">{thaiDateTime(b.created_at)}</td>
                  <td>{b.target_name || b.target_code}</td>
                  <td>{b.file_name}</td>
                  <td className="text-nowrap">{thaiDate(b.date_from)} – {thaiDate(b.date_to)}</td>
                  <td className="num">{b.current_rows ? int(b.current_rows) : <span className="muted">ถูกแทนที่</span>}</td>
                  <td>{b.uploaded_by_name || '–'}</td>
                  <td className="text-end">
                    {(isAdmin || b.uploaded_by === user.id) && (
                      <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => onRemove(b)} title="ลบ">
                        <i className="bi bi-trash" /><span className="visually-hidden">ลบ</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {uploads.length === 0 && <tr><td colSpan={7} className="muted text-center">ยังไม่มีการอัปโหลด</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

