import * as XLSX from 'xlsx';
import { db } from '../config/db.js';
import { baseParams } from './reconService.js';
import { fundCte } from './fundService.js';
import { annotateErrors, formatCodes } from './errorCodeService.js';
import { departments, listPoints, pointEntries } from './pointService.js';
import { registryTags, roomsOf, shortName } from './threeWayService.js';
import { sortRows } from '../utils/sort.js';

/* =====================================================================
 * รายชื่อคนไข้ (รวมหน้ากระทบยอด OPD, แยกกองทุน OPD และเทียบ 3 แหล่ง)
 *  หนึ่งแถว = 1 visit ใน 1 กองทุน (visit ที่ไม่เข้าเกณฑ์กองทุนใด = 1 แถว ไม่มีกองทุน)
 *  ขั้นตอน : ให้บริการ -> เข้าเกณฑ์ -> ส่งเบิก -> ได้รับเงิน
 *  ปัญหา   : เรื่องที่เจ้าหน้าที่ต้องแก้ (หนึ่งแถวมีได้หลายเรื่อง)
 *  ห้อง/แผนก: visit ที่มีค่าใช้จ่ายของห้องนั้นใน HOSxP หรือมีชื่อในทะเบียนของห้องนั้น
 * ===================================================================== */

/** ปัญหา เรียงจากเรื่องที่ต้องแก้ก่อน (level: bad = แดง, warn = ส้ม, info = น้ำเงิน) */
export const PROBLEMS = {
  REG_NO_HIS: { label: 'อยู่ในทะเบียน แต่ไม่พบใน HOSxP', level: 'bad' },
  NO_HIS:   { label: 'อยู่ใน REP แต่ไม่พบใน HOSxP', level: 'bad' },
  DENIED:   { label: 'ติด C', level: 'bad' },
  NOT_SENT: { label: 'เข้าเกณฑ์แต่ยังไม่ส่งเบิก', level: 'bad' },
  NOT_PAID: { label: 'ส่งแล้ว ยังไม่ได้เงินกองทุน', level: 'warn' },
  REP_DIFF: { label: 'ยอดต่าง (HOSxP–REP)', level: 'warn' },
  NOT_IN_REG: { label: 'มีใน HOSxP แต่ไม่อยู่ในทะเบียน', level: 'warn' },
  REG_DIFF: { label: 'ยอดทะเบียนไม่ตรงกับ HOSxP', level: 'warn' },
  EXTRA:    { label: 'ได้เงินแต่ไม่เข้าเกณฑ์', level: 'info' },
};
const P_ORDER = Object.keys(PROBLEMS);
export const NO_FUND = '_none';
const ELIGIBLE = ['PAID', 'NOT_PAID', 'DENIED', 'NOT_SENT'];

const money = (v) => Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => Number(v || 0);
const personKey = (r) => r.cid || (r.hn ? `HN:${String(r.hn).replace(/^0+/, '')}` : r.key);

/** ข้อมูลดิบทั้งหมดของช่วงวันที่ (ไม่ขึ้นกับตัวกรองอื่น) */
async function loadAll(range) {
  const params = [...baseParams({ ...range, fund: null, onlyClaimable: false }), null];
  const [{ rows: base }, { rows: deps }, points, entries, depts] = await Promise.all([
    db.query(`${fundCte()}
      SELECT r.vn, COALESCE(r.hn, r.nhso_hn) AS hn, COALESCE(r.cid, r.pid) AS cid, r.patient_name,
             r.sdate::text AS sdate, r.pttype_name, r.income, r.uc_money,
             r.line_id, r.rep_no, r.tran_id, r.claim_amount, r.compensated, r.error_code,
             r.status AS rep_status, r.grp_n,
             x.fund_code, f.name AS fund_name, x.fund_status, x.stm_fund_amount, x.his_fund_amount
      FROM r
      LEFT JOIN x ON COALESCE(x.vn, '') = COALESCE(r.vn, '') AND COALESCE(x.line_id, 0) = COALESCE(r.line_id, 0)
      LEFT JOIN funds f ON f.code = x.fund_code`, params),
    db.query(`SELECT vn, dep_code, SUM(amount) AS amount, SUM(optional_amount) AS optional_amount,
                     SUM(optional_drug_amount) AS optional_drug_amount
              FROM his_opd_dep WHERE vstdate BETWEEN $1 AND $2 GROUP BY vn, dep_code`, [range.dateFrom, range.dateTo]),
    listPoints(), pointEntries(range), departments(),
  ]);

  const pointName = new Map(points.map((p) => [p.code, p.name]));
  const depOwner = new Map();
  points.filter((p) => p.is_active).forEach((p) => (p.dep_codes || []).forEach((d) => depOwner.set(String(d), p.code)));
  const depName = new Map(depts.map((d) => [String(d.code), d.name]));
  const maps = { depOwner, depName, pointName };

  const depMap = new Map();
  deps.forEach((d) => (depMap.get(d.vn) || depMap.set(d.vn, []).get(d.vn))
    .push({ dep: d.dep_code, amount: num(d.amount), optional_amount: num(d.optional_amount), optional_drug_amount: num(d.optional_drug_amount) }));
  depMap.forEach((list) => list.sort((a, b) => b.amount - a.amount));

  // ทะเบียนห้อง/แผนก: ตาม visit และรายการที่หา visit ไม่พบ (คนไข้ + วันที่)
  const regByVn = new Map();
  const regNoVisit = new Map();
  entries.forEach((e) => {
    if (e.vn) { (regByVn.get(e.vn) || regByVn.set(e.vn, []).get(e.vn)).push(e); return; }
    const k = `nv:${e.sdate}:${String(e.hn || '').replace(/^0+/, '') || e.cid}`;
    (regNoVisit.get(k) || regNoVisit.set(k, []).get(k)).push(e);
  });

  // กองทุนแบบติดตามยอดรับ (RECEIVED) ไม่ได้คัดเกณฑ์: แสดงเฉพาะเมื่อกรองกองทุนนั้น
  // visit ที่มีแค่กองทุนติดตามยอดรับ ได้แถว "ไม่เข้าเกณฑ์กองทุน" อีกแถวด้วย
  const groups = new Map();
  base.forEach((b) => {
    const k = b.vn || `L${b.line_id}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(b);
  });
  const rows = [];
  groups.forEach((list) => {
    const main = list.filter((b) => b.fund_status !== 'RECEIVED');
    const tracked = list.filter((b) => b.fund_status === 'RECEIVED');
    if (!main.length) main.push({ ...list[0], fund_code: null, fund_name: null, fund_status: null, stm_fund_amount: null, his_fund_amount: null });
    main.forEach((b) => rows.push(buildRow(b, { depMap, regByVn, maps })));
    tracked.forEach((b) => rows.push({ ...buildRow(b, { depMap, regByVn, maps }), tracked: true }));
  });
  regNoVisit.forEach((list, key) => {
    const e = list[0];
    const registries = registryTags(list, pointName);
    rows.push(finish({
      key, vn: null, sdate: e.sdate, hn: e.hn, cid: e.cid, patient_name: e.patient_name, pttype_name: null,
      fund: null, eligible: false, sent: false, paid: false, served: false,
      his_total: null, uc_money: null, rep: null, rep_status: null, grp_n: 0, fund_paid: null,
      registries, rooms: registries.map((t) => t.code), room_names: registries.map((t) => t.name).sort().join(', '), depAmounts: {},
      problems: ['REG_NO_HIS'],
      noHisText: 'ทะเบียนจดไว้ แต่ไม่พบ visit ใน HOSxP วันนี้: ตรวจ HN และวันที่ในทะเบียน หรือดึงข้อมูล HOSxP ใหม่',
    }));
  });
  return { rows, depMap, maps };
}

function buildRow(b, { depMap, regByVn, maps }) {
  const deps = b.vn ? depMap.get(b.vn) || [] : [];
  const depAmounts = {};
  deps.forEach((d) => {
    const owner = maps.depOwner.get(String(d.dep));
    if (owner && d.amount > 0) depAmounts[owner] = (depAmounts[owner] || 0) + d.amount;
  });
  const registries = b.vn ? registryTags(regByVn.get(b.vn) || [], maps.pointName) : [];
  const rooms = [...new Set([...Object.keys(depAmounts), ...registries.map((t) => t.code)])];

  const fs = b.fund_status;
  const eligible = ELIGIBLE.includes(fs);
  const sent = !!b.line_id;
  const paid = b.fund_code ? (eligible ? fs === 'PAID' : num(b.stm_fund_amount) > 0) : num(b.compensated) > 0;
  const ucMoney = b.vn ? num(b.uc_money) : null;

  const problems = [];
  if (!b.vn) problems.push('NO_HIS');
  if (b.rep_status === 'DENIED') problems.push('DENIED');
  if (eligible && !sent) problems.push('NOT_SENT');
  if (fs === 'NOT_PAID') problems.push('NOT_PAID');
  if (b.vn && sent && b.rep_status !== 'DENIED' && Math.abs(num(b.claim_amount) - ucMoney) >= 0.01) problems.push('REP_DIFF');
  if (registries.some((t) => t.status === 'NOT_IN_REGISTRY')) problems.push('NOT_IN_REG');
  if (registries.some((t) => t.status === 'HIS_DIFF' || t.status === 'NO_VISIT')) problems.push('REG_DIFF');
  if (fs === 'EXTRA_PAID') problems.push('EXTRA');

  return finish({
    key: `${b.vn || `L${b.line_id}`}:${b.fund_code || NO_FUND}`,
    vn: b.vn, sdate: b.sdate, hn: b.hn, cid: b.cid, patient_name: b.patient_name, pttype_name: b.pttype_name,
    fund: b.fund_code ? { code: b.fund_code, name: b.fund_name, status: fs } : null,
    eligible, sent, paid, served: !!b.vn,
    his_total: b.vn ? (deps.length ? deps.reduce((a, d) => a + d.amount, 0) : num(b.income)) : null,
    uc_money: ucMoney,
    rep: sent ? { claim_amount: num(b.claim_amount), compensated: num(b.compensated), tran_id: b.tran_id, rep_no: b.rep_no, error_code: formatCodes(b.error_code) } : null,
    rep_status: b.rep_status, grp_n: Number(b.grp_n || 0),
    fund_paid: b.fund_code ? num(b.stm_fund_amount) : null,
    his_fund_amount: b.his_fund_amount === null ? null : num(b.his_fund_amount),
    registries, rooms, depAmounts, problems,
    room_names: rooms.map((c) => shortName(maps.pointName.get(c) || c)).sort().join(', '),
  });
}

/** ขั้นที่ไปถึง และ "ต้องทำอะไรต่อ" จากปัญหาที่สำคัญที่สุด */
function finish(r) {
  r.stage = !r.served ? 0 : !r.eligible ? 1 : !r.sent ? 2 : !r.paid ? 3 : 4;
  // พบในแหล่งไหนบ้าง: ทะเบียน (yes/no/none = ห้องไม่มีทะเบียน) · HOSxP · REP
  r.reg_presence = r.registries.some((t) => t.inRegistry) ? 'yes' : r.registries.some((t) => t.status === 'NOT_IN_REGISTRY') ? 'no' : 'none';
  // สถานะแต่ละแหล่ง (ตรงกับจุด 3 จุดบนหน้าจอ): 0 = ไม่มี, 1 = มีแต่มีปัญหา, 2 = มี
  const listed = r.registries.filter((t) => t.inRegistry);
  const regSt = !listed.length ? 0 : listed.some((t) => t.status === 'HIS_DIFF' || t.status === 'NO_VISIT') ? 1 : 2;
  const hisSt = !r.served ? 0 : r.problems.includes('EXTRA') ? 1 : 2;
  const repSt = !r.sent ? 0 : ['DENIED', 'REP_DIFF', 'NOT_PAID'].some((p) => r.problems.includes(p)) ? 1 : 2;
  // เรียง: พบน้อย/มีปัญหามากก่อน (ผลรวม) แล้วจัดกลุ่มตามรูปแบบ ทะเบียน-HOSxP-REP
  r.presence = (regSt + hisSt + repSt) * 100 + regSt * 9 + hisSt * 3 + repSt;
  const first = P_ORDER.find((p) => r.problems.includes(p));
  const days = r.sdate ? Math.floor((Date.now() - new Date(`${r.sdate}T00:00:00+07:00`).getTime()) / 86400000) : null;
  const fundName = r.fund ? r.fund.code : '';
  let text;
  switch (first) {
    case 'REG_NO_HIS': text = r.noHisText; break;
    case 'NO_HIS': text = 'REP มีรายการ แต่ไม่พบ visit ใน HOSxP: ตรวจ HN และวันที่ หรือดึงข้อมูล HOSxP ใหม่'; break;
    case 'DENIED': text = `แก้ ${r.rep?.error_code || 'รหัสข้อผิดพลาด'} แล้วส่งเบิกใหม่`; break;
    case 'NOT_SENT': text = `ส่งเบิก ${fundName} ใน e-Claim${days !== null ? ` (รับบริการมาแล้ว ${days} วัน)` : ''}`; break;
    case 'NOT_PAID': text = `ส่งแล้ว แต่ REP ยังไม่จ่ายกองทุน ${fundName}: รอ Statement หรือตรวจรายการที่ส่ง`; break;
    case 'REP_DIFF': text = `เรียกเก็บ (HOSxP) ${money(r.uc_money)} แต่เรียกเก็บ (REP) ${money(r.rep?.claim_amount)}`; break;
    case 'NOT_IN_REG': case 'REG_DIFF': {
      const t = r.registries.find((x) => (first === 'NOT_IN_REG' ? x.status === 'NOT_IN_REGISTRY' : x.status === 'HIS_DIFF' || x.status === 'NO_VISIT'));
      text = first === 'NOT_IN_REG'
        ? `${t.name}: ${t.issues[0] || 'มีค่าใช้จ่ายใน HOSxP แต่ไม่อยู่ในทะเบียน'} (ให้หน้างานเพิ่มชื่อในทะเบียน)`
        : `${t.name}: ${t.issues[0] || t.label}`;
      break;
    }
    case 'EXTRA': text = `REP จ่ายกองทุน ${fundName} แต่ visit ไม่เข้าเกณฑ์: ตรวจการตั้งค่ากองทุน หรือยอดเรียกเก็บใน HOSxP`; break;
    default:
      text = r.fund?.status === 'RECEIVED' ? `ได้รับเงินกองทุน ${fundName} (ติดตามยอดรับ)` : r.paid ? 'ได้รับเงินแล้ว' : !r.fund ? (r.sent ? 'ส่งเบิกแล้ว (ไม่เข้าเกณฑ์กองทุนที่ตั้งค่า)' : 'ไม่เข้าเกณฑ์กองทุนที่ตั้งค่า') : '–';
  }
  if (r.grp_n > 1 && first && first !== 'NO_HIS' && first !== 'REG_NO_HIS') text += ' (มาหลายครั้งในวันเดียว ควรตรวจการจับคู่)';
  r.todo = first
    ? { level: PROBLEMS[first].level, title: first === 'DENIED' && r.rep?.error_code ? `ติด ${r.rep.error_code}` : PROBLEMS[first].label, text }
    : { level: r.paid ? 'ok' : 'none', title: r.paid ? 'เรียบร้อย' : !r.fund ? 'ไม่เข้าเกณฑ์' : 'รอผล', text };
  delete r.noHisText;
  return r;
}

/* ---------- ตัวกรอง ---------- */
function scope(rows, { point, fund, search }) {
  const pts = point?.length ? new Set(point) : null;
  const fds = fund?.length ? new Set(fund) : null;
  const q = search?.trim().toLowerCase();
  return rows.filter((r) => (!pts || r.rooms.some((c) => pts.has(c)))
    && (fds ? fds.has(r.fund?.code || NO_FUND) : !r.tracked)
    && (!q || [r.hn, r.cid, r.vn, r.patient_name, r.pttype_name, r.rep?.tran_id, r.rep?.rep_no, r.fund?.code, r.fund?.name]
      .some((v) => v && String(v).toLowerCase().includes(q))));
}
const STEP_OK = {
  1: (r) => r.served,
  2: (r) => r.eligible,
  3: (r) => r.eligible && r.sent,
  4: (r) => r.eligible && r.paid,
};

/** ค่าใช้จ่ายของ visit: ถ้ากรองห้อง ใช้เฉพาะค่าใช้จ่ายของห้องที่เลือก */
const costOf = (r, pts) => (pts ? pts.reduce((a, c) => a + (r.depAmounts[c] || 0), 0) : num(r.his_total));

/** รวมยอดระดับ visit โดยนับ visit ละครั้ง (visit ที่อยู่หลายกองทุนไม่นับซ้ำ) */
function visitSum(rows, f) {
  const seen = new Set(); let total = 0;
  rows.forEach((r) => { const k = r.vn || r.key; if (seen.has(k)) return; seen.add(k); total += num(f(r)); });
  return total;
}
function stepStat(rows, money) {
  return {
    persons: new Set(rows.map(personKey)).size,
    visits: new Set(rows.map((r) => r.vn || r.key)).size,
    amount: money(rows),
  };
}

function funnel(rows, pts) {
  const served = rows.filter(STEP_OK[1]);
  const elig = rows.filter(STEP_OK[2]);
  const sent = rows.filter(STEP_OK[3]);
  const paid = rows.filter(STEP_OK[4]);
  return {
    served: stepStat(served, (x) => visitSum(x, (r) => costOf(r, pts))),
    eligible: stepStat(elig, (x) => visitSum(x, (r) => r.uc_money)),
    sent: stepStat(sent, (x) => visitSum(x, (r) => r.rep?.claim_amount)),
    paid: stepStat(paid, (x) => x.reduce((a, r) => a + num(r.fund_paid), 0)),
    notSent: stepStat(elig.filter((r) => !r.sent), (x) => visitSum(x, (r) => r.uc_money)),
    notPaid: stepStat(sent.filter((r) => !r.paid), (x) => visitSum(x, (r) => r.rep?.claim_amount)),
  };
}

const SORT = {
  sdate: (r) => r.sdate, hn: (r) => r.hn, patient: (r) => r.patient_name, fund: (r) => r.fund?.code,
  room: (r) => r.room_names, stage: (r) => r.stage, sources: (r) => r.presence, his: (r) => r.his_total, rep: (r) => r.rep?.claim_amount,
  todo: (r) => { const i = P_ORDER.findIndex((p) => r.problems.includes(p)); return i < 0 ? 99 : i; },
};
/** ลำดับเริ่มต้น: วันที่ แล้ว HN (เทียบสตริงตรง ๆ เร็วกว่าเรียงด้วยภาษาไทยมากเมื่อมีหลักแสนแถว) */
const plain = (a, b) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : a < b ? -1 : 1);
const DEFAULT_SORT = (rows) => rows.slice().sort((a, b) => plain(a.sdate, b.sdate) || plain(a.hn, b.hn) || plain(a.key, b.key));

/* ---------- เก็บผลคำนวณไว้ชั่วคราว ----------
 * คำนวณทุก visit ของช่วงวันที่ครั้งเดียว แล้วเปลี่ยนตัวกรอง/หน้า/การเรียงได้ทันที
 * ล้างอัตโนมัติเมื่อข้อมูลเปลี่ยน (นำเข้า REP, ดึง HOSxP, อัปโหลดทะเบียน, แก้ตั้งค่ากองทุน/ห้อง/ค่าบริการอัตโนมัติ)
 * โดยเทียบ "ลายเซ็นข้อมูล" ที่คำนวณได้เร็วทุกครั้งที่เรียก */
const CACHE_MAX = 4;
const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();

async function dataStamp() {
  const { rows: [r] } = await db.query(`
    SELECT concat_ws('|',
      (SELECT MAX(id) FROM import_batches), (SELECT COUNT(*) FROM import_batches),
      (SELECT MAX(id) FROM his_pull_logs),
      (SELECT MAX(id) FROM point_registry_batches), (SELECT COUNT(*) FROM point_registry_batches),
      (SELECT md5(COALESCE(string_agg(f::text, '|' ORDER BY f.code), '')) FROM funds f),
      (SELECT md5(COALESCE(string_agg(i::text, '|' ORDER BY i.fund_code, i.icode), '')) FROM fund_items i),
      (SELECT md5(COALESCE(string_agg(p::text, '|' ORDER BY p.code), '')) FROM service_points p),
      (SELECT MAX(updated_at)::text FROM app_settings)) AS stamp`);
  return r.stamp;
}

async function loadCached(range) {
  const key = `${range.dateFrom}|${range.dateTo}`;
  if (range.fresh) cache.delete(key);                       // ผู้ใช้กด "คำนวณใหม่"
  const stamp = await dataStamp();
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_TTL) {
    cache.delete(key); cache.set(key, hit);                 // ใช้ล่าสุดไว้ท้าย (LRU)
    return hit.promise;
  }
  const promise = loadAll(range).then((d) => ({ ...d, rows: DEFAULT_SORT(d.rows) }));
  cache.set(key, { stamp, at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return promise;
}

function applyFilters(all, opts) {
  const scoped = scope(all, opts);
  const filtered = scoped.filter((r) => (!opts.step || STEP_OK[opts.step]?.(r))
    && (!opts.problem || r.problems.includes(opts.problem)));
  return { scoped, filtered };
}

/** เติมรายละเอียดเฉพาะแถวที่แสดง: แยกห้อง และคำอธิบายรหัสข้อผิดพลาด */
async function enrich(rows, { depMap, maps }) {
  const annotated = await annotateErrors(rows.map((r) => ({ key: r.key, error_code: r.rep?.error_code || null })));
  const err = new Map(annotated.map((a) => [a.key, a]));
  return rows.map((r) => {
    const deps = r.vn ? depMap.get(r.vn) || [] : [];
    const e = err.get(r.key);
    return {
      ...r,
      breakdown: roomsOf(deps, r.registries, maps),
      vn_total: r.his_total,
      rep: r.rep ? { ...r.rep, error_detail: e?.error_detail || null, error_guidance: e?.error_guidance || null } : null,
    };
  });
}

export async function listPatients(opts) {
  const { rows: all, depMap, maps } = await loadCached(opts);
  const pts = opts.point?.length ? opts.point : null;
  const { scoped, filtered } = applyFilters(all, opts);
  const sorted = sortRows(filtered, SORT, opts);
  const size = Math.min(Math.max(Number(opts.pageSize) || 50, 10), 500);
  const page = Math.max(Number(opts.page) || 1, 1);

  // นับเป็น visit (visit ที่อยู่หลายกองทุนนับครั้งเดียว) และจำนวนคนไม่ซ้ำ
  const problems = Object.fromEntries(P_ORDER.map((k) => {
    const hit = scoped.filter((r) => r.problems.includes(k));
    return [k, { ...PROBLEMS[k], count: new Set(hit.map((r) => r.vn || r.key)).size, persons: new Set(hit.map(personKey)).size }];
  }));
  const { rows: [st] } = await db.query(`
    SELECT (SELECT COUNT(*)::int FROM point_registry_rows WHERE service_date BETWEEN $1 AND $2) AS reg_rows,
           (SELECT MAX(created_at) FROM point_registry_batches) AS uploaded_at,
           (SELECT MAX(created_at) FROM his_pull_logs WHERE claim_type = 'OPD') AS pulled_at,
           (SELECT updated_at FROM app_settings WHERE key = 'optional_fee_items') AS fee_at`, [opts.dateFrom, opts.dateTo]);

  return {
    funnel: funnel(scoped, pts),
    problems,
    money: {
      cost: visitSum(filtered.filter((r) => r.served), (r) => costOf(r, pts)),
      hisClaim: visitSum(filtered.filter((r) => r.served), (r) => r.uc_money),
      repClaim: visitSum(filtered.filter((r) => r.sent), (r) => r.rep?.claim_amount),
      repPaid: visitSum(filtered.filter((r) => r.sent), (r) => r.rep?.compensated),
      roomOnly: !!pts,
    },
    total: filtered.length,
    visits: new Set(filtered.map((r) => r.vn || r.key)).size,
    persons: new Set(filtered.map(personKey)).size,
    page, pageSize: size,
    rows: await enrich(sorted.slice((page - 1) * size, page * size), { depMap, maps }),
    registryRows: st.reg_rows,
    stale: !!(st.uploaded_at && st.pulled_at && st.uploaded_at > st.pulled_at),
    staleFee: !!(st.fee_at && st.pulled_at && st.fee_at > st.pulled_at),
  };
}

const STAGE_LABEL = ['ไม่พบ visit', 'ให้บริการ (ไม่เข้าเกณฑ์)', 'เข้าเกณฑ์ ยังไม่ส่งเบิก', 'ส่งเบิกแล้ว ยังไม่ได้รับเงิน', 'ได้รับเงินแล้ว'];

export async function exportPatients(opts) {
  const { rows: all, maps } = await loadCached(opts);
  const pts = opts.point?.length ? opts.point : null;
  const rows = sortRows(applyFilters(all, opts).filtered, SORT, opts);
  const data = rows.map((r) => ({
    'ขั้นตอน': STAGE_LABEL[r.stage],
    'ปัญหา': r.problems.map((p) => PROBLEMS[p].label).join(', '),
    'ต้องทำอะไรต่อ': r.todo.text,
    'วันที่รับบริการ': r.sdate,
    'HN': r.hn,
    'เลขบัตรประชาชน': r.cid,
    'ชื่อ-สกุล': r.patient_name,
    'VN': r.vn,
    'สิทธิ': r.pttype_name,
    'กองทุน': r.fund ? `${r.fund.code} ${r.fund.name || ''}`.trim() : 'ไม่เข้าเกณฑ์กองทุน',
    'ห้อง/แผนก': r.rooms.map((c) => maps.pointName.get(c) || c).join(', '),
    'ทะเบียน': r.registries.map((t) => `${t.full}${t.amount !== null ? ` ${money(t.amount)}` : ''}${t.inRegistry ? '' : ' (ไม่อยู่ในทะเบียน)'}`).join(', '),
    [pts ? 'ค่าใช้จ่ายของห้องที่เลือก' : 'ค่าใช้จ่ายทั้ง visit']: r.served ? costOf(r, pts) : null,
    'เรียกเก็บ (HOSxP)': r.uc_money,
    'เรียกเก็บ (REP)': r.rep ? r.rep.claim_amount : null,
    'ได้รับ (REP)': r.rep ? r.rep.compensated : null,
    'ได้รับ (กองทุนนี้)': r.fund ? r.fund_paid : null,
    'TRAN_ID': r.rep?.tran_id || null,
    'REP No.': r.rep?.rep_no || null,
    'รหัสข้อผิดพลาด': r.rep?.error_code || null,
    'ผลการแก้ไข / หมายเหตุ': '',
  }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ 'ขั้นตอน': 'ไม่มีข้อมูล' }]);
  ws['!cols'] = [24, 30, 50, 12, 11, 15, 22, 14, 22, 26, 26, 30, 14, 14, 14, 14, 14, 12, 16, 12, 28].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'รายชื่อคนไข้');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: data.length };
}
