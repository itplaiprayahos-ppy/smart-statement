import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client.js';
import MultiSelect from '../components/MultiSelect.jsx';
import Pagination from '../components/Pagination.jsx';
import PeriodFields from '../components/PeriodFields.jsx';
import SortTh from '../components/SortTh.jsx';
import { PointUploadModal } from '../components/RegistryUploads.jsx';
import { Box, BoxReason, BreakdownTable, DeptPopover, Field, RegistryBox, UploadHistory } from '../components/VisitParts.jsx';
import DataCoverage from '../components/DataCoverage.jsx';
import RoomSummary from '../components/RoomSummary.jsx';
import RegistryTracker from '../components/RegistryTracker.jsx';
import { useSortState } from '../hooks/useSort.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { int, lastMonthRange, money, rangeErrorOf, thaiDate } from '../utils/format.js';
import { pullHosxpOpd } from '../utils/hosxp.js';

/* =====================================================================
 * รายชื่อคนไข้: คนไข้แต่ละคนไปถึงขั้นไหน (ให้บริการ -> เข้าเกณฑ์ -> ส่งเบิก -> ได้รับเงิน -> ได้รับโอนจริง)
 * และต้องทำอะไรต่อ  หนึ่งแถว = 1 visit ใน 1 กองทุน
 * ===================================================================== */
const PAGE_SIZE = 50;
const NO_FUND = '_none';
const STEPS = [
  { n: 1, key: 'served', label: 'ให้บริการ', dot: '#6b7775' },
  { n: 2, key: 'eligible', label: 'เข้าเกณฑ์เบิก', dot: '#3b5bdb' },
  { n: 3, key: 'sent', label: 'ส่งเบิกแล้ว', dot: '#b26a00' },
  { n: 4, key: 'paid', label: 'ได้รับเงิน', dot: '#2f7d4f' },
  { n: 5, key: 'stm', label: 'ได้รับโอนจริง', dot: '#0b7285' },
];
/** ปัญหาแบ่ง 2 กลุ่ม: ทะเบียนกับ HOSxP (งานหน้างาน) และการเบิก (งานเคลม) */
const PROBLEM_GROUPS = [
  { label: 'ทะเบียน', ok: 'ตรงกับ HOSxP ทั้งหมด (หรือยังไม่มีทะเบียนในช่วงนี้)', keys: ['REG_NO_HIS', 'NOT_IN_REG', 'REG_DIFF'] },
  { label: 'การเบิก', ok: 'ไม่มีปัญหา', keys: ['NO_HIS', 'DENIED', 'NOT_SENT', 'NOT_PAID', 'REP_DIFF', 'STM_NO_REP', 'STM_DIFF', 'EXTRA'] },
];
/** ยอดเงินของแต่ละขั้น (ระดับ visit: ค่าใช้จ่าย / เรียกเก็บ (REP) · ระดับกองทุน: ตั้งเบิก / ได้รับ) */
/** ขั้นต้นทางเมื่อนับจากทะเบียน */
const REG_STEP = { n: 0, key: 'registry', label: 'อยู่ในทะเบียน', dot: '#7048e8' };
/** ตกหล่นที่ขั้นไหน (ตรงกับ DROPS ใน backend) */
const DROP_LABEL = { 1: 'ไม่พบใน HOSxP', 2: 'ไม่เข้าเกณฑ์กองทุน', 3: 'ยังไม่ส่งเบิก', 4: 'ยังไม่ได้รับเงิน / ติด C', 5: 'รอ Statement' };
const DROP_OK = { 1: 'พบใน HOSxP ครบ', 2: 'เข้าเกณฑ์ครบ', 3: 'ส่งเบิกครบ', 4: 'ได้รับเงินครบ', 5: 'ได้รับโอนจริงครบ' };
const STEP_MONEY = { registry: 'ยอดทะเบียน', served: 'ค่าใช้จ่าย', eligible: 'ตั้งเบิก', sent: 'เรียกเก็บ (REP)', paid: 'ได้รับ', stm: 'โอนจริง (STM)' };
const LEVEL_COLOR = { bad: 'var(--st-denied)', warn: 'var(--st-diff)', info: '#3b5bdb' };
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');
const list = (v) => (v ? v.split(',').filter(Boolean) : []);

/* ---------- จุด 4 ขั้นของแต่ละแถว ---------- */
/**
 * พบในแหล่งไหนบ้าง: ทะเบียน · HOSxP · REP · STM (Statement)
 *  เทา = ไม่มี · เขียว = มี · เหลือง = มีแต่มีเรื่องต้องตรวจ (ดูรายละเอียดเมื่อคลิกแถว)
 *  STM เส้นประจาง = กองทุนนี้ไม่ต้องใช้ Statement และยังไม่มี Statement
 *  คำนวณจากข้อมูลของแถวเอง (ไม่พึ่งค่าสรุปจากเซิร์ฟเวอร์)
 */
const REG_PROBLEM = { HIS_DIFF: 'ยอดไม่ตรง HOSxP', NO_VISIT: 'ไม่พบใน HOSxP' };
function sourcesOf(r) {
  const listed = r.registries.filter((t) => t.inRegistry);
  const regIssue = listed.map((t) => REG_PROBLEM[t.status]).find(Boolean);
  const reg = !listed.length ? { st: 'na', text: 'ไม่มี' }
    : regIssue ? { st: 'warn', text: `มี · ${regIssue}` } : { st: 'ok', text: 'มี' };
  const his = !r.served ? { st: 'na', text: 'ไม่มี' }
    : r.problems.includes('EXTRA') ? { st: 'warn', text: 'มี · ไม่เข้าเกณฑ์กองทุน' } : { st: 'ok', text: 'มี' };
  const repIssue = r.problems.includes('DENIED') ? `ติด ${r.rep?.error_code || 'C'}`
    : r.problems.includes('REP_DIFF') ? 'ยอดต่างจาก HOSxP'
      : r.problems.includes('NOT_PAID') ? 'ยังไม่ได้รับเงิน' : null;
  const rep = !r.sent ? { st: 'na', text: 'ไม่มี' }
    : repIssue ? { st: 'warn', text: `มี · ${repIssue}` } : { st: 'ok', text: r.paid ? 'มี · ได้รับเงิน' : 'มี' };
  const stmIssue = r.problems.includes('STM_NO_REP') ? 'ไม่พบใน REP'
    : r.problems.includes('STM_DIFF') ? 'ยอดต่างจาก REP' : null;
  const stm = r.stm
    ? (stmIssue ? { st: 'warn', text: `มี · ${stmIssue}` } : { st: 'ok', text: 'มี · โอนแล้ว' })
    : r.stm_required ? { st: 'na', text: r.paid ? 'ยังไม่พบ (รอ Statement)' : 'ไม่มี' } : { st: 'off', text: 'ไม่ต้องใช้ Statement' };
  return [['ทะเบียน', reg], ['HOSxP', his], ['REP', rep], ['STM', stm]];
}
/** จุด 4 จุดต่อกัน: ทะเบียน → HOSxP → REP → STM (เทา = ไม่มี · เขียว = มี · เหลือง = มีแต่มีปัญหา) */
function Sources({ r }) {
  const list = sourcesOf(r);
  const issue = list.find(([, x]) => x.st === 'warn');
  const full = list.map(([n, x]) => `${n}: ${x.text}`).join('\n');
  return (
    <div className="src-dots" title={full} aria-label={full.replace(/\n/g, ', ')}>
      <div className="pt-prog">
        {list.map(([n, x], i) => (
          <Fragment key={n}>
            {i > 0 && <b className={['ok', 'warn'].includes(x.st) && ['ok', 'warn'].includes(list[i - 1][1].st) ? 'done' : ''} />}
            <i className={x.st === 'ok' ? 'done' : x.st === 'warn' ? 'warn' : x.st === 'off' ? 'off' : ''} />
          </Fragment>
        ))}
      </div>
      <div className="src-names">{list.map(([n, x]) => <span key={n} className={x.st}>{n}</span>)}</div>
      {issue && <div className="src-issue">{issue[0]}: {issue[1].text.replace(/^มี · /, '')}</div>}
    </div>
  );
}

/* ---------- ห้อง/แผนกของ visit (สถานะทะเบียนดูที่คอลัมน์ ทะเบียน · HOSxP · REP) ---------- */
function RoomCell({ r, pointName }) {
  if (!r.rooms.length) return <span className="muted small">–</span>;
  return (
    <div className="room-list">
      {r.rooms.map((code) => {
        const t = r.registries.find((x) => x.code === code);
        return (
          <div key={code}>
            {t?.name || pointName.get(code) || code}
            {t?.inRegistry && <div className="small-id">ทะเบียน {t.amount !== null ? money(t.amount) : 'ไม่มียอด'}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- รายละเอียดเมื่อคลิกแถว ---------- */
function RowDetail({ r }) {
  const hisIssues = r.registries.filter((t) => ['HIS_DIFF', 'NO_VISIT'].includes(t.status)).flatMap((t) => t.issues.map((x) => `${t.name}: ${x}`));
  const repIssues = [];
  if (r.problems.includes('DENIED')) repIssues.push(`ติด ${r.rep?.error_code || 'C'}`);
  if (r.problems.includes('REP_DIFF')) repIssues.push(`เรียกเก็บ (HOSxP) ${money(r.uc_money)} แต่เรียกเก็บ (REP) ${money(r.rep?.claim_amount)}`);
  if (r.problems.includes('NOT_PAID')) repIssues.push(`ยังไม่ได้รับเงินกองทุน ${r.fund.code}`);
  if (r.problems.includes('NOT_SENT')) repIssues.push('เข้าเกณฑ์แต่ยังไม่พบใน REP');
  const fundBad = r.problems.includes('EXTRA');
  const stmIssues = [];
  if (r.problems.includes('STM_NO_REP')) stmIssues.push(`TRAN_ID ${r.stm.no_rep.map((x) => x.tran_id).join(', ')} อยู่ใน Statement แต่ไม่พบใน REP`);
  if (r.problems.includes('STM_DIFF')) stmIssues.push(`ได้รับ (REP) ${money(r.rep?.compensated)} แต่โอนจริง (STM) ${money(r.stm.paid)}`);
  return (
    <div className="row-detail">
      <div className="src-boxes four">
        {r.registries.length ? <RegistryBox r={r} /> : (
          <Box title="ทะเบียน" icon="bi-journal-text" bad={null}>
            <p className="small muted mb-0">{r.vn ? 'ห้องของ visit นี้ไม่มีทะเบียนในช่วงนี้' : 'ไม่พบ visit ใน HOSxP จึงเทียบกับทะเบียนไม่ได้'}</p>
          </Box>
        )}
        <Box title="HOSxP" icon="bi-hospital" bad={!r.vn || hisIssues.length > 0 || fundBad}>
          {!r.vn ? (
            <p className="small mb-0">ไม่พบ visit วันนี้<span className="d-block muted">ตรวจ HN และวันที่ หรือดึงข้อมูล HOSxP ช่วงนี้ใหม่</span></p>
          ) : (
            <>
              <BoxReason items={[...hisIssues, ...(fundBad ? [`REP จ่ายกองทุน ${r.fund.code} แต่ visit ไม่เข้าเกณฑ์: ${r.fund.reason || 'ตรวจการตั้งค่ากองทุน'}`] : [])]} />
              <div className="small mb-1">
                <Field label="VN">{r.vn}</Field>
                {r.pttype_name && <Field label="สิทธิ">{r.pttype_name}</Field>}
                <Field label="กองทุน">{r.fund ? `${r.fund.code} ${r.fund.name || ''}` : <span className="muted">ไม่เข้าเกณฑ์กองทุนที่ตั้งค่า</span>}</Field>
                {r.fund?.activities && <Field label="กิจกรรม">{r.fund.activities}</Field>}
                <Field label="เรียกเก็บ (HOSxP)">{money(r.uc_money)}</Field>
                {r.eligible && r.his_fund_amount !== null && Math.abs(r.his_fund_amount - r.uc_money) >= 0.01 && (
                  <Field label={`ตั้งเบิก (กองทุน ${r.fund.code})`}>{money(r.his_fund_amount)}</Field>
                )}
              </div>
              <BreakdownTable row={r} />
            </>
          )}
        </Box>
        <Box title="REP (e-Claim)" icon="bi-cloud-check" bad={r.rep || r.eligible ? repIssues.length > 0 : null}>
          <BoxReason items={repIssues} />
          {!r.rep ? (
            <p className="small mb-0">ยังไม่พบใน REP
              <span className="d-block muted">{r.eligible ? 'ยังไม่ได้ส่งเบิก หรือยังไม่ได้นำเข้าไฟล์ REP ที่มีรายการนี้' : 'visit นี้ไม่เข้าเกณฑ์กองทุนที่ตั้งค่า'}</span>
            </p>
          ) : (
            <div className="small">
              <Field label="เรียกเก็บ (REP)">{money(r.rep.claim_amount)}</Field>
              <Field label="ได้รับ (REP)">{money(r.rep.compensated)}</Field>
              {/* แสดงเมื่อต่างจากยอดทั้ง visit เช่น REP จ่ายหลายกองทุนใน visit เดียว หรือกองทุนนี้ยังไม่จ่าย */}
              {r.fund && Math.abs(Number(r.fund_paid || 0) - Number(r.rep.compensated || 0)) >= 0.01 && (
                <Field label={`ได้รับ (กองทุน ${r.fund.code})`}>{money(r.fund_paid)}</Field>
              )}
              {r.rep.tran_id && <Field label="TRAN_ID">{r.rep.tran_id}</Field>}
              {r.rep.rep_no && <Field label="REP No.">{r.rep.rep_no}</Field>}
              {r.rep.error_code && (
                <div className="err-block">
                  <div className="fw-semibold">ติด {r.rep.error_code}</div>
                  {r.rep.error_detail && r.rep.error_detail.split('\n').map((l) => <div key={l}>{l}</div>)}
                  {r.rep.error_guidance && (
                    <div className="mt-1"><span className="fw-semibold">แนวทางแก้: </span>
                      {r.rep.error_guidance.split('\n').map((l) => <div key={l}>{l}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Box>
        <Box title="Statement (โอนเงิน)" icon="bi-bank" bad={r.stm ? stmIssues.length > 0 : r.stm_required && r.paid ? true : null}>
          <BoxReason items={stmIssues} />
          {!r.stm ? (
            <p className="small mb-0">{r.stm_required ? 'ยังไม่พบใน Statement' : 'ยังไม่มี Statement'}
              <span className="d-block muted">
                {r.stm_required
                  ? (r.paid ? 'REP จ่ายแล้ว รอไฟล์ Statement ที่มี TRAN_ID นี้ (นำเข้าที่หน้านำเข้าไฟล์ สปสช. เลือก Statement)' : 'จะตรวจเมื่อ REP จ่ายเงินแล้ว')
                  : 'กองทุนนี้ไม่ได้ตั้งค่า “ต้องมี Statement”'}
              </span>
            </p>
          ) : (
            <div className="small">
              {r.stm.linked && <Field label="โอนจริง (STM)">{money(r.stm.paid)}</Field>}
              {r.stm.no_rep.map((x) => <Field key={x.tran_id} label="โอนจริง (ไม่พบใน REP)">{money(x.paid)} <span className="small-id">TRAN_ID {x.tran_id}</span></Field>)}
              {r.stm.other.map((x) => <Field key={x.tran_id} label="โอนจริง (REP ช่วงอื่น)">{money(x.paid)} <span className="small-id">TRAN_ID {x.tran_id}</span></Field>)}
              {r.stm.tran_ids && <Field label="TRAN_ID">{r.stm.tran_ids}</Field>}
              {r.stm.docs && <Field label="เลขที่เอกสาร">{r.stm.docs}</Field>}
              {r.stm.stm_date && <Field label="งวดวันที่">{thaiDate(r.stm.stm_date)}</Field>}
              {r.stm.lines > 1 && <Field label="จำนวนรอบ">{r.stm.lines} รายการ (รวมยอดทุกรอบ)</Field>}
            </div>
          )}
        </Box>
      </div>
    </div>
  );
}

/* ---------- หน้าหลัก ---------- */
export default function PatientsPage() {
  const [sp, setSp] = useSearchParams();
  const init = useRef(Object.fromEntries(sp.entries())).current;
  const [range, setRange] = useState(init.dateFrom && init.dateTo ? { dateFrom: init.dateFrom, dateTo: init.dateTo } : lastMonthRange());
  const [point, setPoint] = useState(list(init.point));
  const [fund, setFund] = useState(list(init.fund));
  const [step, setStep] = useState(Number(init.step) || 0);
  const [problem, setProblem] = useState(init.problem || '');
  // นับจาก: all = ทุก visit · reg = เฉพาะคนในทะเบียน (ติดตามจนครบทุกขั้น)
  // v53: โหมดนับจากทะเบียนย้ายไปแท็บติดตามทะเบียน มุมมองนี้นับทุก visit
  const [base, setBase] = useState('all');
  // มุมมอง: all = ทุก visit ใน HOSxP (ค่าเริ่มต้น) · track = ติดตามทะเบียน
  const [view, setView] = useState(init.view === 'track' ? 'track' : 'all');
  const [trackKey, setTrackKey] = useState(0);
  const [trackSel, setTrackSel] = useState(null);   // กลุ่มที่เปิดเมื่อมาจากประวัติอัปโหลด
  const bumpTrack = () => setTrackKey((k) => k + 1);
  const [drop, setDrop] = useState(Number(init.drop) || 0);
  const isReg = base === 'reg';
  const [search, setSearch] = useState(init.q || '');
  const [searchInput, setSearchInput] = useState(init.q || '');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [points, setPoints] = useState([]);
  const [funds, setFunds] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [modal, setModal] = useState(null);
  const [open, setOpen] = useState(null);
  const [pop, setPop] = useState(null);
  const popTimer = useRef(null);
  const [sort, toggleSort] = useSortState();
  const onSort = (k) => { toggleSort(k); setPage(1); };

  const rangeError = rangeErrorOf(range);
  const params = useMemo(() => ({
    dateFrom: range.dateFrom, dateTo: range.dateTo,
    point: point.length ? point.join(',') : undefined, fund: fund.length ? fund.join(',') : undefined,
    step: step || undefined, problem: problem || undefined, search: search || undefined,
    base: isReg ? 'reg' : undefined, drop: drop || undefined,
    sort: sort.key || undefined, dir: sort.key ? sort.dir : undefined,
  }), [range, point, fund, step, problem, search, sort, isReg, drop]);

  // เก็บตัวกรองไว้ใน URL: ส่งลิงก์ให้กันได้ และกดย้อนกลับแล้วได้ตัวกรองเดิม
  useEffect(() => {
    const q = { dateFrom: range.dateFrom, dateTo: range.dateTo };
    if (point.length) q.point = point.join(',');
    if (fund.length) q.fund = fund.join(',');
    if (step) q.step = String(step);
    if (problem) q.problem = problem;
    if (search) q.q = search;
    if (isReg) q.base = 'reg';
    if (view === 'track') q.view = 'track';
    if (drop) q.drop = String(drop);
    setSp(q, { replace: true });
  }, [range, point, fund, step, problem, search, isReg, drop, view, setSp]);

  const load = useCallback((fresh = false) => {
    if (rangeError || view !== 'all') return;
    setLoading(true);
    api.get('/patients', { params: { ...params, page, pageSize: PAGE_SIZE, fresh: fresh ? 1 : undefined } })
      .then((r) => setData(r.data)).catch((err) => showError(err, 'โหลดรายชื่อไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [params, page, rangeError, view]);
  useEffect(() => { load(); setOpen(null); setPop(null); }, [load]);

  const loadLists = useCallback(() => {
    api.get('/points').then((r) => setPoints(r.data.filter((p) => p.is_active))).catch(() => {});
    api.get('/funds').then((r) => setFunds(r.data.filter((f) => f.is_active))).catch(() => {});
    api.get('/registry/uploads').then((r) => setUploads(r.data)).catch(() => {});
  }, []);
  useEffect(() => { loadLists(); }, [loadLists]);
  const pointName = useMemo(() => new Map(points.map((p) => [p.code, p.name.replace(/^[\d.\-\s]+/, '')])), [points]);

  /* ป๊อปอัปแยกห้อง: ชี้ = แสดงชั่วคราว, กด = ปักไว้ */
  const cancelClose = () => clearTimeout(popTimer.current);
  const closePop = useCallback(() => { clearTimeout(popTimer.current); setPop(null); }, []);
  const laterClose = () => { cancelClose(); popTimer.current = setTimeout(() => setPop((p) => (p?.pinned ? p : null)), 180); };
  const showPop = (e, key, row, pinned = false) => {
    cancelClose();
    const anchor = e.currentTarget;
    setPop((p) => (p?.key === key && p.pinned && !pinned ? p : { key, row, rect: anchor.getBoundingClientRect(), anchor, pinned }));
  };
  const togglePop = (e, key, row) => {
    e.stopPropagation();
    if (pop?.key === key && pop.pinned) closePop(); else showPop(e, key, row, true);
  };
  useEffect(() => () => clearTimeout(popTimer.current), []);

  const reset = (fn) => (v) => { fn(v); setPage(1); };
  const pickStep = (n) => { setStep(step === n ? 0 : n); setProblem(''); setDrop(0); setPage(1); };
  const pickProblem = (k) => { setProblem(problem === k ? '' : k); setStep(0); setDrop(0); setPage(1); };
  const clearSteps = () => { setStep(0); setDrop(0); setProblem(''); setPage(1); };
  const pickDrop = (k) => { setDrop(drop === k ? 0 : k); setStep(0); setProblem(''); setPage(1); };
  const clearAll = () => { setPoint([]); setFund([]); setStep(0); setProblem(''); setDrop(0); setSearch(''); setSearchInput(''); setPage(1); };
  /** จากตาราง/ประวัติ: กรองห้อง + ช่วงวันที่ + ตกหล่น/ปัญหา แล้วเลื่อนไปที่รายชื่อ */
  const applyFilter = ({ point: pt, dateFrom, dateTo, drop: dk, problem: pk, base: b }) => {
    if (pt) setPoint([pt]);
    if (dateFrom && dateTo) setRange({ dateFrom, dateTo });
    if (b) setBase(b);
    setStep(0); setDrop(dk || 0); setProblem(pk || ''); setPage(1);
    setTimeout(() => document.getElementById('pt-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  };

  const removeUpload = async (b) => {
    if (!(await confirmAction({ title: 'ลบการอัปโหลดนี้?', text: `${b.file_name}: รายการในทะเบียนจากไฟล์นี้จะถูกลบ`, confirmText: 'ลบ', danger: true }))) return;
    try {
      await api.delete(`/points/batches/${b.id}`);
      notifySuccess('ลบแล้ว'); notifyDataChanged(); loadLists(); load();
    } catch (err) { showError(err); }
  };

  const exportUrl = `/api/patients/export?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined))}`;
  const f = data?.funnel;
  const m = data?.money;
  const fundOptions = [
    ...funds.flatMap((x) => [
      { value: x.code, label: `${x.code} ${x.name}`, hint: x.track_only ? 'ติดตามยอดรับ' : undefined },
      // กิจกรรมย่อยของกองทุน เลือกแยกได้ (รหัส PP.a12)
      ...(x.activities || []).map((a) => ({ value: `${x.code}.a${a.id}`, label: `\u00a0\u00a0└ ${x.code} · ${a.name}` })),
    ]),
    { value: NO_FUND, label: 'ไม่เข้าเกณฑ์กองทุนใด' },
  ];
  const filtered = !!(point.length || fund.length || step || problem || search || drop);
  const stepLabel = STEPS.find((s) => s.n === step)?.label;
  const steps = isReg ? [REG_STEP, ...STEPS] : STEPS;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>รายชื่อคนไข้</h1>
          <p>{view === 'track'
            ? 'ทะเบียนจากหน้างานไปถึงขั้นไหนแล้ว ติดอยู่ตรงไหน และต้องทำอะไรต่อ'
            : 'ทุก visit ใน HOSxP: ให้บริการ → เข้าเกณฑ์ → ส่งเบิก → ได้รับเงิน → ได้รับโอนจริง และต้องทำอะไรต่อ'}</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <button type="button" className="btn btn-outline-primary" disabled={!!rangeError}
            title="ดึง visit และรายการค่าใช้จ่ายของช่วงวันที่ที่เลือกจาก HOSxP ใหม่ (แทนที่ข้อมูลเดิมของช่วงนี้)"
            onClick={async () => { if (await pullHosxpOpd(range)) { load(); bumpTrack(); } }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setModal('point')}>
            <i className="bi bi-upload me-1" />อัปโหลดทะเบียน
          </button>
        </div>
      </div>

      <ul className="nav nav-tabs mb-3" role="tablist">
        <li className="nav-item">
          <button type="button" role="tab" className={`nav-link ${view === 'all' ? 'active' : ''}`} aria-selected={view === 'all'} onClick={() => setView('all')}>
            <i className="bi bi-hospital me-1" />ทุก visit ใน HOSxP <span className="small muted">(งานเคลม)</span>
          </button>
        </li>
        <li className="nav-item">
          <button type="button" role="tab" className={`nav-link ${view === 'track' ? 'active' : ''}`} aria-selected={view === 'track'} onClick={() => setView('track')}>
            <i className="bi bi-journal-check me-1" />ติดตามทะเบียน
          </button>
        </li>
      </ul>

      {view === 'track' && (
        <RegistryTracker key={trackSel || 'auto'} initialSel={trackSel} range={range} onRange={setRange} point={point[0] || null}
          onPoint={(c) => setPoint(c ? [c] : [])} points={points} reloadKey={trackKey} />
      )}

      {view === 'all' && (<>
      <div className="panel">
        <div className="row g-3 align-items-end">
          <PeriodFields idPrefix="pt" value={range} onChange={reset(setRange)} />
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="pt-point">ห้อง/แผนก</label>
            <MultiSelect id="pt-point" allLabel="ทุกห้อง/แผนก" unit="ห้อง/แผนก" value={point}
              options={points.map((p) => ({ value: p.code, label: p.name }))} onChange={reset(setPoint)} />
          </div>
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="pt-fund">กองทุน</label>
            <MultiSelect id="pt-fund" allLabel="ทุกกองทุน" unit="กองทุน" value={fund} options={fundOptions} onChange={reset(setFund)} />
          </div>
          <div className="col-sm-12 col-lg-6">
            <label className="form-label" htmlFor="pt-q">ค้นหา</label>
            <form className="input-group" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
              <input id="pt-q" className="form-control" placeholder="HN, ชื่อ, VN, เลขบัตร, TRAN_ID, สิทธิ" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
              <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
            </form>
          </div>
          {filtered && (
            <div className="col-sm-12 col-lg-6 d-flex align-items-end">
              <button type="button" className="btn btn-link px-0" onClick={clearAll}><i className="bi bi-x-circle me-1" />ล้างตัวกรองทั้งหมด</button>
            </div>
          )}
        </div>
        {rangeError && <div className="text-danger small mt-2">{rangeError}</div>}
      </div>

      {(data?.stale || data?.staleFee) && (
        <div className="alert alert-warning py-2 d-flex flex-wrap align-items-center gap-2">
          <i className="bi bi-arrow-repeat" />
          <span className="me-auto">{data.stale
            ? 'มีทะเบียนอัปโหลดหลังดึงข้อมูล HOSxP ครั้งล่าสุด ควรดึงข้อมูลช่วงนี้ใหม่'
            : 'ตั้งค่าค่าบริการอัตโนมัติ/ยาหลังดึงข้อมูล HOSxP ครั้งล่าสุด ดึงข้อมูลช่วงนี้ใหม่เพื่อให้ระบบแยกยอดรายการนี้'}</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={async () => { if (await pullHosxpOpd(range)) load(); }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
        </div>
      )}

      {!data && loading && (
        <div className="panel text-center py-5 muted">
          <span className="spinner-border spinner-border-sm me-2" />กำลังคำนวณรายชื่อ… ช่วงวันที่ยาว (เช่น ทั้งปีงบประมาณ) ครั้งแรกอาจใช้เวลาหลายวินาที เปลี่ยนตัวกรองหลังจากนั้นจะเร็วขึ้น
        </div>
      )}
      {data && (() => {
        // ขั้นตอนแนวนอน (v54): กดช่อง = รายชื่อที่ติดขั้นนั้น (ช่องแรก = ทุก visit)
        const dv = (k) => f.drops[k]?.visits || 0;
        const cards = [
          { k: 0, label: 'ให้บริการ', num: f.served.visits, of: 'visit ในช่วงนี้', foot: <span className="clear muted">ดูทั้งหมด</span> },
          { k: 2, label: 'เบิกได้', num: f.eligible.visits, of: `จาก ${int(f.served.visits)} visit`, foot: <span className="grey">ไม่เข้าเกณฑ์ {int(dv(2))}</span> },
          { k: 3, label: 'ส่งเบิกแล้ว', num: f.sent.visits, of: `จาก ${int(f.eligible.visits)} ที่เบิกได้`, stuck: dv(3) },
          { k: 4, label: 'ตั้งเบิกแล้ว', num: f.paid.visits, of: `จาก ${int(f.sent.visits)} ที่ส่ง`, stuck: dv(4) },
          { k: 5, label: 'เงินเข้าแล้ว', num: Math.max(f.paid.visits - dv(5), 0), of: `จาก ${int(f.paid.visits)} ที่ตั้งเบิก`, stuck: dv(5), last: true },
        ];
        const other = ['NO_HIS', 'REP_DIFF', 'STM_NO_REP', 'STM_DIFF', 'EXTRA'].map((k) => [k, data.problems[k]]).filter(([k, p]) => p && (p.count > 0 || problem === k));
        const scopeText = [point.length ? point.map((c) => pointName.get(c) || c).join(', ') : 'ทุกห้อง/แผนก',
          fund.length ? `กองทุน ${fund.join(', ')}` : 'ทุกกองทุน', search ? `ค้นหา “${search}”` : null].filter(Boolean).join(' · ');
        const M = [
          [m.roomOnly ? 'ค่าใช้จ่าย (ห้องที่เลือก)' : 'ค่าใช้จ่าย (HOSxP)', m.cost, '', m.roomOnly ? 'เฉพาะค่าใช้จ่ายของห้องที่เลือก' : 'ค่าใช้จ่ายทั้ง visit'],
          ['เรียกเก็บ (HOSxP)', m.hisClaim, '', 'ยอดลูกหนี้สิทธิใน HOSxP'],
          ['ตั้งเบิก (กองทุน)', m.fundClaim, 'grp', 'ยอดของรายการที่เข้าเกณฑ์กองทุน'],
          ['เรียกเก็บ (REP)', m.repClaim, '', 'ยอดที่ส่งเบิกใน REP'],
          ['ได้รับ (REP)', m.repPaid, 'paid', 'ยอดชดเชยใน REP ทั้ง visit'],
          ['ได้รับ (กองทุน)', m.fundPaid, 'paid grp', 'ยอดในคอลัมน์ของกองทุนในไฟล์ REP (ตรงกับหน้าภาพรวม)'],
          ['โอนจริง (STM)', m.stmPaid, 'paid', 'ยอดชดเชยสุทธิในไฟล์ Statement'],
        ];
        return (
          <div className={loading ? 'is-loading' : ''}>
            <div className="av-money">
              <div className="av-mhead"><span>ยอดเงินตามตัวกรอง: <b>{scopeText}</b></span><span>{thaiDate(range.dateFrom)} – {thaiDate(range.dateTo)}</span></div>
              <div className="av-mgrid">
                {M.map(([l, v, c, t]) => <div key={l} className={`av-mi ${c}`} title={t}><div className="l">{l}</div><div className="v">{money(v)}</div></div>)}
              </div>
            </div>
            <div className="trk-steps" role="group" aria-label="ขั้นตอน กดเพื่อดูรายชื่อที่ติดขั้นนั้น">
              {cards.map((c, i) => {
                const on = c.k === 0 ? !drop && !problem && !step : drop === c.k;
                return (
                  <Fragment key={c.k}>
                    {i > 0 && <span className="trk-arrow" aria-hidden="true">›</span>}
                    <button type="button" className={`trk-st ${on ? 'on' : ''} ${c.last ? 'last' : ''}`}
                      onClick={() => (c.k === 0 ? clearSteps() : pickDrop(c.k))}
                      title={c.k === 0 ? 'ดูทุก visit' : `ดูรายชื่อที่ติดขั้นนี้`}>
                      <span className="lb">{c.label}</span>
                      <span className="num">{int(c.num)}</span>
                      <span className="of">{c.of}</span>
                      {c.foot || (c.stuck > 0 ? <span className="stuck">ติด {int(c.stuck)}</span> : <span className="clear">✓ ครบ</span>)}
                    </button>
                  </Fragment>
                );
              })}
            </div>
            <div className="trk-notes">
              {other.length > 0 && <span>ปัญหาอื่น:</span>}
              {other.map(([k, p]) => (
                <button key={k} type="button" className={problem === k ? 'on' : ''} onClick={() => pickProblem(k)} title={`${int(p.persons)} คน`}>
                  {p.label} {int(p.count)}
                </button>
              ))}
              {!other.length && <span className="text-success">ไม่มีปัญหาอื่น</span>}
              {filtered && <button type="button" className="ok" onClick={clearAll}>ล้างตัวกรองทั้งหมด</button>}
            </div>
          </div>
        );
      })()}

      {data && (
        <div className="panel" id="pt-list">
          <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
            <div>
              <h5 className="mb-0">{(() => {
                const t = drop ? { 2: 'ไม่เข้าเกณฑ์กองทุน', 3: 'เบิกได้แต่ยังไม่ส่งเบิก', 4: 'ส่งแล้วยังไม่ได้ตั้งเบิก', 5: 'ตั้งเบิกแล้ว ยังไม่มีเงินเข้า' }[drop]
                  : problem ? data.problems[problem]?.label : 'ทุก visit';
                return `${t} ${int(data.visits)} visit`;
              })()}</h5>
              <div className="small muted">
                {drop === 2 ? 'ปกติไม่ต้องเบิก (เช่น ชำระเงินเอง) ตรวจเฉพาะรายการที่ควรเบิกได้'
                  : drop === 3 ? 'ส่งเบิกใน e-Claim'
                    : drop === 4 ? 'ติด C ต้องแก้แล้วส่งใหม่ ที่เหลือรอ สปสช.'
                      : drop === 5 ? 'เฉพาะกองทุนที่ต้องมี Statement'
                        : `${int(data.total)} แถว (visit ที่มีหลายกองทุนแยกแถวตามกองทุน) · ${int(data.persons)} คน`}
                {' · '}คลิกแถวเพื่อดูรายละเอียด
              </div>
            </div>
            <span className="d-flex align-items-center gap-2">
              {loading && <span className="spinner-border spinner-border-sm text-secondary" />}
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => load(true)} disabled={loading}
                title="คำนวณรายชื่อใหม่จากข้อมูลล่าสุดในระบบ (ปกติระบบคำนวณใหม่เองเมื่อข้อมูลเปลี่ยน)">
                <i className="bi bi-arrow-clockwise" /><span className="visually-hidden">คำนวณใหม่</span>
              </button>
              <a className={`btn btn-sm btn-outline-secondary ${data.total ? '' : 'disabled'}`} href={exportUrl}>
                <i className="bi bi-file-earmark-excel me-1" />Excel
              </a>
            </span>
          </div>
          <div className="table-wrap">
            <table className="table data-table pt-table av-table">
              <thead>
                <tr>
                  <SortTh k="sdate" sort={sort} onSort={onSort}>วันที่</SortTh>
                  <SortTh k="hn" sort={sort} onSort={onSort}>คนไข้</SortTh>
                  {!point.length && <SortTh k="room" sort={sort} onSort={onSort}>ห้อง/แผนก</SortTh>}
                  <SortTh k="fund" sort={sort} onSort={onSort}>กองทุน</SortTh>
                  <SortTh k="sources" sort={sort} onSort={onSort} title="พบในทะเบียน / HOSxP / REP / Statement หรือไม่ (เทา = ไม่มี · เขียว = มี · เหลือง = มีแต่มีปัญหา)">ทะเบียน · HOSxP · REP · STM</SortTh>
                  <SortTh k="todo" sort={sort} onSort={onSort}>สาเหตุ</SortTh>
                  <th>ต้องทำอะไร</th>
                  <SortTh k="his" sort={sort} onSort={onSort} className="num">เรียกเก็บ</SortTh>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={8} className="text-center muted py-4">✓ ไม่มีรายการตามตัวกรองนี้</td></tr>}
                {data.rows.map((r) => {
                  const isOpen = open === r.key;
                  const toggle = () => setOpen(isOpen ? null : r.key);
                  const cols = point.length ? 7 : 8;
                  return (
                    <Fragment key={r.key}>
                      <tr className={`cmp-row ${isOpen ? 'open' : ''}`} onClick={toggle} tabIndex={0} aria-expanded={isOpen}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}>
                        <td className="text-nowrap">{thaiDate(r.sdate)}</td>
                        <td className="pt-cell"><span className="hn">{r.hn || '–'}</span><div className="small-id text-truncate">{r.patient_name}</div></td>
                        {!point.length && <td className="small muted">{r.room_names || '–'}</td>}
                        <td className="fund-cell">{r.fund ? <span title={r.fund.name}>{r.fund.code}<div className="small-id">{r.fund.activities || r.fund.name}</div></span> : <span className="muted small">ไม่เข้าเกณฑ์</span>}</td>
                        <td className="prog-cell"><Sources r={r} /></td>
                        <td><span className={`todo-k ${r.todo.level}`}>{r.todo.title}</span></td>
                        <td className="todo-cell">{r.todo.text && r.todo.text !== '–' ? <span className="reason" title={r.todo.text}>{r.todo.text}</span> : <span className="muted">–</span>}</td>
                        <td className="num">{r.vn ? money(r.uc_money) : <span className="muted small">ไม่พบ visit</span>}</td>
                      </tr>
                      {isOpen && <tr className="detail-row"><td colSpan={cols}><RowDetail r={r} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="d-flex flex-wrap justify-content-end align-items-center gap-2 mt-2">
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </div>
        </div>
      )}

      {data && <RoomSummary rooms={data.rooms} isReg={false} selected={point} defaultOpen={false} onPick={(code, dk) => applyFilter({ point: code, drop: dk })} />}
      {data && <DataCoverage coverage={data.coverage} defaultOpen={false} onPickDay={(d) => applyFilter({ dateFrom: d, dateTo: d })} />}
      </>)}

      <UploadHistory uploads={uploads} onRemove={removeUpload}
        onFilter={(b, k) => {
          // ไปที่แท็บติดตามทะเบียน: ห้อง + ช่วงวันที่ของไฟล์ และเปิดกลุ่มที่กด
          setView('track'); setPoint([b.target_code]); setRange({ dateFrom: b.date_from, dateTo: b.date_to });
          setTrackSel(k.drop ? String(k.drop) : k.problem === 'REG_DIFF' ? 'diff' : k.problem === 'NOT_IN_REG' ? 'out' : 'all');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }} />

      <div className="small muted mt-3">
        มุมมองเดิม (ยังใช้ได้ระหว่างเปลี่ยนผ่าน):{' '}
        <Link to="/recon/opd">กระทบยอด OPD</Link> · <Link to="/recon/funds">แยกกองทุน OPD (วิเคราะห์รายการ, สรุปรายเดือน)</Link> · <Link to="/registry">เทียบ 3 แหล่ง</Link>
      </div>

      {modal === 'point' && <PointUploadModal points={points} onClose={() => setModal(null)} onDone={() => { setModal(null); loadLists(); load(); bumpTrack(); }} />}
    </>
  );
}
