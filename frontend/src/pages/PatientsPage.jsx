import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client.js';
import MultiSelect from '../components/MultiSelect.jsx';
import Pagination from '../components/Pagination.jsx';
import PeriodFields from '../components/PeriodFields.jsx';
import SortTh from '../components/SortTh.jsx';
import { PointUploadModal } from '../components/RegistryUploads.jsx';
import { Box, BoxReason, BreakdownTable, DeptPopover, Field, RegistryBox, UploadHistory } from '../components/VisitParts.jsx';
import { useSortState } from '../hooks/useSort.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { int, lastMonthRange, money, rangeErrorOf, thaiDate } from '../utils/format.js';
import { pullHosxpOpd } from '../utils/hosxp.js';

/* =====================================================================
 * รายชื่อคนไข้: คนไข้แต่ละคนไปถึงขั้นไหน (ให้บริการ -> เข้าเกณฑ์ -> ส่งเบิก -> ได้รับเงิน)
 * และต้องทำอะไรต่อ  หนึ่งแถว = 1 visit ใน 1 กองทุน
 * ===================================================================== */
const PAGE_SIZE = 50;
const NO_FUND = '_none';
const STEPS = [
  { n: 1, key: 'served', label: 'ให้บริการ', dot: '#6b7775' },
  { n: 2, key: 'eligible', label: 'เข้าเกณฑ์เบิก', dot: '#3b5bdb' },
  { n: 3, key: 'sent', label: 'ส่งเบิกแล้ว', dot: '#b26a00' },
  { n: 4, key: 'paid', label: 'ได้รับเงิน', dot: '#2f7d4f' },
];
/** ปัญหาแบ่ง 2 กลุ่ม: ทะเบียนกับ HOSxP (งานหน้างาน) และการเบิก (งานเคลม) */
const PROBLEM_GROUPS = [
  { label: 'ทะเบียน', ok: 'ตรงกับ HOSxP ทั้งหมด (หรือยังไม่มีทะเบียนในช่วงนี้)', keys: ['REG_NO_HIS', 'NOT_IN_REG', 'REG_DIFF'] },
  { label: 'การเบิก', ok: 'ไม่มีปัญหา', keys: ['NO_HIS', 'DENIED', 'NOT_SENT', 'NOT_PAID', 'REP_DIFF', 'EXTRA'] },
];
const LEVEL_COLOR = { bad: 'var(--st-denied)', warn: 'var(--st-diff)', info: '#3b5bdb' };
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');
const list = (v) => (v ? v.split(',').filter(Boolean) : []);

/* ---------- จุด 4 ขั้นของแต่ละแถว ---------- */
/**
 * พบในแหล่งไหนบ้าง: ทะเบียน · HOSxP · REP
 *  เทา = ไม่มี · เขียว = มี · เหลือง = มีแต่มีเรื่องต้องตรวจ (ดูรายละเอียดเมื่อคลิกแถว)
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
  return [['ทะเบียน', reg], ['HOSxP', his], ['REP', rep]];
}
/** จุด 3 จุดต่อกัน: ทะเบียน → HOSxP → REP (เทา = ไม่มี · เขียว = มี · เหลือง = มีแต่มีปัญหา) */
function Sources({ r }) {
  const list = sourcesOf(r);
  const issue = list.find(([, x]) => x.st === 'warn');
  const full = list.map(([n, x]) => `${n}: ${x.text}`).join('\n');
  return (
    <div className="src-dots" title={full} aria-label={full.replace(/\n/g, ', ')}>
      <div className="pt-prog">
        {list.map(([n, x], i) => (
          <Fragment key={n}>
            {i > 0 && <b className={x.st !== 'na' && list[i - 1][1].st !== 'na' ? 'done' : ''} />}
            <i className={x.st === 'ok' ? 'done' : x.st === 'warn' ? 'warn' : ''} />
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
            {t?.inRegistry && t.amount !== null && <div className="small-id">ทะเบียน {money(t.amount)}</div>}
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
  return (
    <div className="row-detail">
      <div className="src-boxes">
        {r.registries.length ? <RegistryBox r={r} /> : (
          <Box title="ทะเบียน" icon="bi-journal-text" bad={null}>
            <p className="small muted mb-0">ห้องของ visit นี้ไม่มีทะเบียนในช่วงนี้</p>
          </Box>
        )}
        <Box title="HOSxP" icon="bi-hospital" bad={!r.vn || hisIssues.length > 0 || fundBad}>
          {!r.vn ? (
            <p className="small mb-0">ไม่พบ visit วันนี้<span className="d-block muted">ตรวจ HN และวันที่ หรือดึงข้อมูล HOSxP ช่วงนี้ใหม่</span></p>
          ) : (
            <>
              <BoxReason items={[...hisIssues, ...(fundBad ? [`REP จ่ายกองทุน ${r.fund.code} แต่ visit ไม่เข้าเกณฑ์ตามการตั้งค่ากองทุน`] : [])]} />
              <div className="small mb-1">
                <Field label="VN">{r.vn}</Field>
                {r.pttype_name && <Field label="สิทธิ">{r.pttype_name}</Field>}
                <Field label="กองทุน">{r.fund ? `${r.fund.code} ${r.fund.name || ''}` : <span className="muted">ไม่เข้าเกณฑ์กองทุนที่ตั้งค่า</span>}</Field>
                <Field label="เรียกเก็บ (HOSxP)">{money(r.uc_money)}</Field>
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
              {r.fund && <Field label={`ได้รับ (กองทุน ${r.fund.code})`}>{money(r.fund_paid)}</Field>}
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
    sort: sort.key || undefined, dir: sort.key ? sort.dir : undefined,
  }), [range, point, fund, step, problem, search, sort]);

  // เก็บตัวกรองไว้ใน URL: ส่งลิงก์ให้กันได้ และกดย้อนกลับแล้วได้ตัวกรองเดิม
  useEffect(() => {
    const q = { dateFrom: range.dateFrom, dateTo: range.dateTo };
    if (point.length) q.point = point.join(',');
    if (fund.length) q.fund = fund.join(',');
    if (step) q.step = String(step);
    if (problem) q.problem = problem;
    if (search) q.q = search;
    setSp(q, { replace: true });
  }, [range, point, fund, step, problem, search, setSp]);

  const load = useCallback((fresh = false) => {
    if (rangeError) return;
    setLoading(true);
    api.get('/patients', { params: { ...params, page, pageSize: PAGE_SIZE, fresh: fresh ? 1 : undefined } })
      .then((r) => setData(r.data)).catch((err) => showError(err, 'โหลดรายชื่อไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [params, page, rangeError]);
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
  const pickStep = (n) => { setStep(step === n ? 0 : n); setProblem(''); setPage(1); };
  const pickProblem = (k) => { setProblem(problem === k ? '' : k); setStep(0); setPage(1); };
  const clearAll = () => { setPoint([]); setFund([]); setStep(0); setProblem(''); setSearch(''); setSearchInput(''); setPage(1); };

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
    ...funds.map((x) => ({ value: x.code, label: `${x.code} ${x.name}`, hint: x.track_only ? 'ติดตามยอดรับ' : undefined })),
    { value: NO_FUND, label: 'ไม่เข้าเกณฑ์กองทุนใด' },
  ];
  const filtered = point.length || fund.length || step || problem || search;
  const stepLabel = STEPS.find((s) => s.n === step)?.label;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>รายชื่อคนไข้</h1>
          <p>คนไข้แต่ละคนไปถึงขั้นไหนแล้ว: ให้บริการ → เข้าเกณฑ์ → ส่งเบิก → ได้รับเงิน และต้องทำอะไรต่อ (กองทุนดูจากการตั้งค่ากองทุน · ทะเบียนจากห้อง/แผนก)</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <button type="button" className="btn btn-outline-primary" disabled={!!rangeError}
            title="ดึง visit และรายการค่าใช้จ่ายของช่วงวันที่ที่เลือกจาก HOSxP ใหม่ (แทนที่ข้อมูลเดิมของช่วงนี้)"
            onClick={async () => { if (await pullHosxpOpd(range)) load(); }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setModal('point')}>
            <i className="bi bi-upload me-1" />อัปโหลดทะเบียน
          </button>
        </div>
      </div>

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
      {data && (
        <div className={`panel ${loading ? 'is-loading' : ''}`}>
          <div className="pt-funnel" role="group" aria-label="ขั้นตอน (กดเพื่อกรอง)">
            {STEPS.map((s, i) => {
              const v = f[s.key];
              const prev = i > 0 ? f[STEPS[i - 1].key] : null;
              return (
                <button key={s.n} type="button" className={`pt-step ${step === s.n ? 'active' : ''}`} aria-pressed={step === s.n} onClick={() => pickStep(s.n)}>
                  <span className="t"><span className="dot" style={{ background: s.dot }} />{s.label}</span>
                  <span className="n">{int(v.persons)} <small>คน{prev ? ` · ${pct(v.persons, prev.persons)}` : ''}</small></span>
                  <span className="m">{int(v.visits)} visit · {money(v.amount)} บาท</span>
                  {s.key === 'served' && <span className="m">{fund.length || point.length ? 'ตามตัวกรองที่เลือก' : 'ทุก visit ในช่วงนี้'}</span>}
                  {s.key === 'eligible' && <span className="m">ไม่เข้าเกณฑ์ {int(Math.max(f.served.visits - v.visits, 0))} visit</span>}
                  {s.key === 'sent' && f.notSent.visits > 0 && <span className="drop">ยังไม่ส่ง {int(f.notSent.persons)} คน · {money(f.notSent.amount)}</span>}
                  {s.key === 'paid' && f.notPaid.visits > 0 && <span className="drop">ติด C / ยังไม่ได้รับ {int(f.notPaid.persons)} คน</span>}
                </button>
              );
            })}
          </div>

          {PROBLEM_GROUPS.map((g) => {
            const items = g.keys.map((k) => [k, data.problems[k]]).filter(([k, p]) => p && (p.count > 0 || problem === k));
            return (
              <div key={g.label} className="cmp-pills mt-3" role="group" aria-label={`กรองตาม${g.label}`}>
                <span className="small muted me-1 pill-group">{g.label}:</span>
                {items.map(([k, p]) => (
                  <button key={k} type="button" className={`cmp-pill ${problem === k ? 'active' : ''}`} aria-pressed={problem === k}
                    title={`${int(p.count)} visit · ${int(p.persons)} คน`}
                    style={{ '--c': LEVEL_COLOR[p.level] }} onClick={() => pickProblem(k)}>
                    {p.label} <span className="n">{int(p.persons)} คน</span>
                  </button>
                ))}
                {!items.length && <span className="small text-success"><i className="bi bi-check-circle me-1" />{g.ok}</span>}
              </div>
            );
          })}

          <div className="cmp-strip mt-3" aria-label="ยอดเงินตามตัวกรอง">
            <span className="item"><span className="lbl">{m.roomOnly ? 'ค่าใช้จ่ายของห้องที่เลือก' : 'ค่าใช้จ่ายทั้ง visit'}</span><strong>{money(m.cost)}</strong></span>
            <span className="item"><span className="lbl">เรียกเก็บ (HOSxP)</span><strong>{money(m.hisClaim)}</strong></span>
            <span className="item"><span className="lbl">เรียกเก็บ (REP)</span><strong>{money(m.repClaim)}</strong></span>
            <span className="item"><span className="lbl">ได้รับ (REP)</span><strong className="paid">{money(m.repPaid)}</strong></span>
          </div>
        </div>
      )}

      {data && (
        <div className="panel">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
            <div>
              <strong>{int(data.total)} รายการ</strong>
              <span className="small muted ms-2">
                {int(data.visits)} visit · {int(data.persons)} คน
                {stepLabel && ` · ขั้น ${stepLabel}`}
                {problem && ` · ${data.problems[problem]?.label}`}
                {' · '}คลิกแถวเพื่อดูรายละเอียด
              </span>
            </div>
            <span className="d-flex align-items-center gap-2">
              {loading && <span className="spinner-border spinner-border-sm text-secondary" />}
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => load(true)} disabled={loading}
                title="คำนวณรายชื่อใหม่จากข้อมูลล่าสุดในระบบ (ปกติระบบคำนวณใหม่เองเมื่อข้อมูลเปลี่ยน)">
                <i className="bi bi-arrow-clockwise" /><span className="visually-hidden">คำนวณใหม่</span>
              </button>
              <a className={`btn btn-sm btn-outline-secondary ${data.total ? '' : 'disabled'}`} href={exportUrl}>
                <i className="bi bi-file-earmark-excel me-1" />Excel รายชื่อนี้
              </a>
            </span>
          </div>
          <div className="table-wrap">
            <table className="table data-table pt-table">
              <thead>
                <tr>
                  <SortTh k="sdate" sort={sort} onSort={onSort}>วันที่</SortTh>
                  <SortTh k="hn" sort={sort} onSort={onSort}>คนไข้</SortTh>
                  <SortTh k="room" sort={sort} onSort={onSort}>ห้อง/แผนก</SortTh>
                  <SortTh k="fund" sort={sort} onSort={onSort}>กองทุน</SortTh>
                  <SortTh k="sources" sort={sort} onSort={onSort} title="พบในทะเบียน / HOSxP / REP หรือไม่ (เรียงจากพบน้อยไปมาก)">ทะเบียน · HOSxP · REP</SortTh>
                  <SortTh k="his" sort={sort} onSort={onSort} className="num" title="ค่าใช้จ่ายทั้ง visit ชี้หรือกดเพื่อดูแยกตามห้อง ตัวเล็กคือเรียกเก็บ (HOSxP)">HOSxP</SortTh>
                  <SortTh k="rep" sort={sort} onSort={onSort} className="num" title="เรียกเก็บ (REP) ตัวเล็กคือได้รับ (REP)">REP</SortTh>
                  <SortTh k="todo" sort={sort} onSort={onSort}>ต้องทำอะไรต่อ</SortTh>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={8} className="text-center muted py-4">ไม่มีรายชื่อตามตัวกรองนี้</td></tr>}
                {data.rows.map((r) => {
                  const isOpen = open === r.key;
                  const toggle = () => setOpen(isOpen ? null : r.key);
                  return (
                    <Fragment key={r.key}>
                      <tr className={`cmp-row ${isOpen ? 'open' : ''}`} onClick={toggle} tabIndex={0} aria-expanded={isOpen}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggle(); } }}>
                        <td className="text-nowrap">{thaiDate(r.sdate)}</td>
                        <td className="pt-cell"><span className="hn">{r.hn || '–'}</span><div className="small-id text-truncate">{r.patient_name}</div></td>
                        <td className="reg-cell-td"><RoomCell r={r} pointName={pointName} /></td>
                        <td className="fund-cell">{r.fund ? <span title={r.fund.name}>{r.fund.code}<div className="small-id">{r.fund.name}</div></span> : <span className="muted small">ไม่เข้าเกณฑ์</span>}</td>
                        <td className="prog-cell"><Sources r={r} /></td>
                        <td className="num">
                          {!r.vn ? <span className="muted small">ไม่พบ visit</span> : (
                            <button type="button" className={`amt-btn ${pop?.key === r.key ? 'on' : ''}`} aria-haspopup="dialog"
                              aria-label={`ยอด HOSxP ทั้ง visit ${money(r.vn_total)} บาท ดูแยกตามห้อง`}
                              onMouseEnter={(e) => showPop(e, r.key, r)} onMouseLeave={laterClose}
                              onFocus={(e) => showPop(e, r.key, r)} onBlur={laterClose}
                              onClick={(e) => togglePop(e, r.key, r)}>
                              {money(r.vn_total)}
                            </button>
                          )}
                          {r.vn && <div className="small-id">เรียกเก็บ {money(r.uc_money)}</div>}
                        </td>
                        <td className="num">
                          {r.rep ? (<>{money(r.rep.claim_amount)}<div className="small-id">ได้รับ {money(r.rep.compensated)}</div></>)
                            : <span className="muted small">{r.vn ? 'ยังไม่พบ' : '–'}</span>}
                        </td>
                        <td className="todo-cell">
                          <div className="d-flex align-items-start gap-2">
                            <div className="min-w-0 flex-grow-1">
                              <span className={`todo-k ${r.todo.level}`}>{r.todo.title}</span>
                              {r.todo.text && r.todo.text !== '–' && <div className="reason" title={r.todo.text}>{r.todo.text}</div>}
                            </div>
                            <i className={`bi ${isOpen ? 'bi-chevron-up' : 'bi-chevron-down'} muted chev`} aria-hidden="true" />
                          </div>
                        </td>
                      </tr>
                      {isOpen && <tr className="detail-row"><td colSpan={8}><RowDetail r={r} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
            <span className="small muted">หนึ่งแถว = 1 visit ใน 1 กองทุน · ชี้ยอด HOSxP เพื่อดูแยกตามห้อง</span>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </div>
        </div>
      )}
      {pop && <DeptPopover pop={pop} onEnter={cancelClose} onLeave={laterClose} onClose={closePop} />}

      <UploadHistory uploads={uploads} onRemove={removeUpload} />

      <div className="small muted mt-3">
        มุมมองเดิม (ยังใช้ได้ระหว่างเปลี่ยนผ่าน):{' '}
        <Link to="/recon/opd">กระทบยอด OPD</Link> · <Link to="/recon/funds">แยกกองทุน OPD (วิเคราะห์รายการ, สรุปรายเดือน)</Link> · <Link to="/registry">เทียบ 3 แหล่ง</Link>
      </div>

      {modal === 'point' && <PointUploadModal points={points} onClose={() => setModal(null)} onDone={() => { setModal(null); loadLists(); load(); }} />}
    </>
  );
}
