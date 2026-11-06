import * as XLSX from 'xlsx';
import { db } from '../config/db.js';
import { env } from '../config/env.js';
import { baseParams } from './reconService.js';
import { fundCte } from './fundService.js';
import { annotateErrors, formatCodes } from './errorCodeService.js';
import { departments, listPoints, pointEntries } from './pointService.js';
import { registryTags, roomsOf, shortName } from './threeWayService.js';
import { sortRows } from '../utils/sort.js';

/* =====================================================================
 * รายชื่อคนไข้ (รวมหน้ากระทบยอด OPD, แยกกองทุน OPD และเทียบ 3 แหล่ง)
 *  หนึ่งแถว = 1 visit ใน 1 กองทุน (visit ที่ไม่เข้าเกณฑ์กองทุนใด = 1 แถว ไม่มีกองทุน)
 *  ขั้นตอน : ให้บริการ -> เข้าเกณฑ์ -> ส่งเบิก -> ได้รับเงิน (REP) -> ได้รับโอนจริง (Statement)
 *  Statement: เชื่อมกับ REP ด้วย TRAN_ID (รวมทุกรอบ) ขั้นได้รับโอนจริงนับเฉพาะกองทุนที่ "ต้องมี Statement"
 *             รายการ Statement ที่ไม่พบ TRAN_ID ใน REP จับคู่กับ visit ด้วยเลขบัตร/HN + วันที่ (ไม่พบ = แถวแยก)
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
  STM_NO_REP: { label: 'อยู่ใน STM แต่ไม่พบใน REP', level: 'warn' },
  STM_DIFF: { label: 'ยอด STM ไม่ตรงกับ REP', level: 'warn' },
  NOT_IN_REG: { label: 'มีใน HOSxP แต่ไม่อยู่ในทะเบียน', level: 'warn' },
  REG_DIFF: { label: 'ยอดทะเบียนไม่ตรงกับ HOSxP', level: 'warn' },
  EXTRA:    { label: 'ได้เงินแต่ไม่เข้าเกณฑ์', level: 'info' },
};
const P_ORDER = Object.keys(PROBLEMS);
export const NO_FUND = '_none';
const ELIGIBLE = ['PAID', 'NOT_PAID', 'DENIED', 'NOT_SENT'];

const money = (v) => Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => Number(v || 0);
/** '2026-08-11' -> '11/08/2569' (พ.ศ.) */
const thaiDay = (d) => { const [y, m, dd] = String(d).split('-'); return `${dd}/${m}/${Number(y) + 543}`; };
const round2 = (v) => Math.round(v * 100) / 100;
const personKey = (r) => r.cid || (r.hn ? `HN:${String(r.hn).replace(/^0+/, '')}` : r.key);

/* ---------- เหตุผลที่ visit ไม่เข้าเกณฑ์กองทุน (กรณี REP จ่ายกองทุนนั้น) ----------
 * ตรวจตามเงื่อนไขเดียวกับ fundCte ทีละข้อ แล้วบอกข้อที่ไม่ผ่าน เช่น สิทธิไม่ได้เลือกไว้ / เรียกเก็บเป็น 0 */
const icdNorm = (v) => String(v || '').toUpperCase().replace(/\./g, '');
function icdHit(code, list) {
  const c = icdNorm(code);
  if (!c) return false;
  return list.some((x) => {
    const v = String(x);
    if (v.includes('-')) {
      const [a, b] = v.split('-');
      return c.slice(0, a.length) >= a && c.slice(0, b.length) <= b;
    }
    return c.startsWith(v);
  });
}

async function explainExtra(extra) {
  const out = new Map();
  if (!extra.length) return out;
  const vns = [...new Set(extra.map((b) => b.vn))];
  const codes = [...new Set(extra.map((b) => b.fund_code))];
  const [{ rows: funds }, { rows: fitems }, { rows: visits }, { rows: dx }, { rows: items }] = await Promise.all([
    db.query(`SELECT code, match_mode, pttypes, hipdata_codes, icd10_codes, icd10_scope FROM funds WHERE code = ANY($1)`, [codes]),
    db.query('SELECT fund_code, icode FROM fund_items WHERE fund_code = ANY($1)', [codes]),
    db.query('SELECT vn, pttype, pttype_name, hipdata_code, pdx, uc_money FROM his_opd_visits WHERE vn = ANY($1)', [vns]),
    db.query('SELECT vn, icd10 FROM his_opd_dx WHERE vn = ANY($1)', [vns]),
    db.query('SELECT DISTINCT vn, icode FROM his_opd_items WHERE vn = ANY($1)', [vns]),
  ]);
  const { rows: acts } = await db.query(`
    SELECT a.id, a.fund_code, a.name, a.items_mode, a.icd10_codes, a.icd10_scope,
           COALESCE(array_agg(ai.icode::text) FILTER (WHERE ai.icode IS NOT NULL), '{}') AS icodes
    FROM fund_activities a LEFT JOIN fund_activity_items ai ON ai.activity_id = a.id
    WHERE a.fund_code = ANY($1) AND a.is_active GROUP BY a.id ORDER BY a.sort_order, a.id`, [codes]);
  const actsOf = new Map();
  acts.forEach((a) => (actsOf.get(a.fund_code) || actsOf.set(a.fund_code, []).get(a.fund_code)).push(a));
  const fundMap = new Map(funds.map((f) => [f.code, f]));
  const fundIcodes = new Map();
  fitems.forEach((i) => (fundIcodes.get(i.fund_code) || fundIcodes.set(i.fund_code, new Set()).get(i.fund_code)).add(String(i.icode)));
  const visit = new Map(visits.map((v) => [v.vn, v]));
  const dxOf = new Map();
  dx.forEach((d) => (dxOf.get(d.vn) || dxOf.set(d.vn, []).get(d.vn)).push(d.icd10));
  const itemsOf = new Map();
  items.forEach((i) => (itemsOf.get(i.vn) || itemsOf.set(i.vn, new Set()).get(i.vn)).add(String(i.icode)));

  extra.forEach((b) => {
    const f = fundMap.get(b.fund_code);
    const v = visit.get(b.vn);
    if (!f || !v) return;
    const why = [];
    const hip = v.hipdata_code || '';
    const pttypes = f.pttypes || [];
    const hips = f.hipdata_codes || [];
    const icds = f.icd10_codes || [];
    if (env.excludedHipdata.includes(hip.toUpperCase())) why.push(`สิทธิกลุ่ม ${hip} ไม่นับเข้ากองทุนใด (EXCLUDED_HIPDATA)`);
    if (pttypes.length && !pttypes.includes(v.pttype)) why.push(`สิทธิ ${v.pttype || '-'} ${v.pttype_name || ''} ไม่ได้เลือกไว้ในกองทุน ${f.code}`.replace(/\s+/g, ' '));
    else if (!pttypes.length && hips.length && !hips.includes(hip)) why.push(`กลุ่มสิทธิ ${hip || '-'} (${v.pttype_name || ''}) ไม่อยู่ในเงื่อนไขกองทุน ${f.code}`);
    if (icds.length) {
      const ok = f.icd10_scope === 'pdx' ? icdHit(v.pdx, icds) : (dxOf.get(b.vn) || [v.pdx]).some((c) => icdHit(c, icds));
      if (!ok) why.push(`รหัสโรค ${v.pdx || '(ไม่มี PDX)'} ไม่ตรงเงื่อนไข ICD-10 ของกองทุน`);
    }
    const fActs = f.match_mode === 'items' ? actsOf.get(f.code) || [] : [];
    if (fActs.length) {
      // กิจกรรมย่อย: บอกเหตุผลของกิจกรรมที่มีรายการอยู่แล้ว (ขาดรายการ / รหัสโรคไม่ตรง)
      const have = itemsOf.get(b.vn) || new Set();
      const dxList = dxOf.get(b.vn) || [v.pdx];
      const near = fActs.filter((a) => a.icodes.some((i) => have.has(i)));
      if (!near.length) why.push(`visit ไม่มีรายการของกิจกรรมใดในกองทุน ${f.code} (${fActs.map((a) => a.name).join(', ')})`);
      near.forEach((a) => {
        const miss = a.items_mode === 'all' ? a.icodes.filter((i) => !have.has(i)) : [];
        const icdOk = !(a.icd10_codes || []).length
          || (a.icd10_scope === 'pdx' ? icdHit(v.pdx, a.icd10_codes) : dxList.some((c) => icdHit(c, a.icd10_codes)));
        const parts = [];
        if (miss.length) parts.push(`ขาดรายการ ${miss.join(', ')}`);
        if (!icdOk) parts.push(`รหัสโรค ${(a.icd10_scope === 'pdx' ? [v.pdx] : dxList).filter(Boolean).join(', ') || '(ไม่มี)'} ไม่ตรง ${a.icd10_codes.join(', ')}`);
        if (parts.length) why.push(`${a.name}: ${parts.join(' และ ')}`);
      });
    } else if (f.match_mode === 'items') {
      const set = fundIcodes.get(f.code);
      if (!set?.size) why.push(`กองทุน ${f.code} ยังไม่ได้ตั้งรายการค่าบริการ`);
      else if (![...(itemsOf.get(b.vn) || [])].some((i) => set.has(i))) why.push(`visit ไม่มีรายการค่าบริการ/ยาที่ตั้งไว้ในกองทุน ${f.code}`);
    } else {
      if (f.match_mode === 'icd' && !icds.length) why.push(`กองทุน ${f.code} คัดตาม ICD-10 แต่ยังไม่ได้ใส่รหัสโรค`);
      if (num(v.uc_money) <= 0) why.push('เรียกเก็บ (HOSxP) เป็น 0 บาท (ตรวจ paidst ของรายการ หรือดึงข้อมูล HOSxP ใหม่)');
    }
    out.set(`${b.vn}|${b.fund_code}`, why.length ? why.join(' · ') : 'ไม่ตรงเงื่อนไขกองทุน (ตรวจการตั้งค่ากองทุน)');
  });
  return out;
}

/** ข้อมูลดิบทั้งหมดของช่วงวันที่ (ไม่ขึ้นกับตัวกรองอื่น) */
async function loadAll(range) {
  const params = [...baseParams({ ...range, fund: null, onlyClaimable: false }), null];
  const [{ rows: base }, { rows: deps }, points, entries, depts, { rows: stmRows }] = await Promise.all([
    db.query(`${fundCte()}
      SELECT r.vn, COALESCE(r.hn, r.nhso_hn) AS hn, COALESCE(r.cid, r.pid) AS cid, r.patient_name,
             r.sdate::text AS sdate, r.pttype, r.pttype_name, r.hipdata_code, r.income, r.uc_money,
             r.line_id, r.rep_no, r.tran_id, r.claim_amount, r.compensated, r.error_code,
             r.status AS rep_status, r.grp_n,
             x.fund_code, f.name AS fund_name, f.stm_required AS fund_stm, x.fund_status, x.stm_fund_amount, x.his_fund_amount,
             fact2.acts AS act_ids, fact2.names AS act_names
      FROM r
      LEFT JOIN x ON COALESCE(x.vn, '') = COALESCE(r.vn, '') AND COALESCE(x.line_id, 0) = COALESCE(r.line_id, 0)
      LEFT JOIN funds f ON f.code = x.fund_code
      LEFT JOIN fact2 ON fact2.vn = x.vn AND fact2.fund_code = x.fund_code`, params),
    db.query(`SELECT vn, dep_code, SUM(amount) AS amount, SUM(optional_amount) AS optional_amount,
                     SUM(optional_drug_amount) AS optional_drug_amount
              FROM his_opd_dep WHERE vstdate BETWEEN $1 AND $2 GROUP BY vn, dep_code`, [range.dateFrom, range.dateTo]),
    listPoints(), pointEntries(range), departments(),
    // Statement รวมทุกรอบต่อ TRAN_ID (has_rep = มี TRAN_ID นี้ใน REP ที่นำเข้าแล้ว ไม่จำกัดช่วงวันที่)
    db.query(`SELECT s.tran_id, SUM(s.paid_amount) AS paid, COUNT(*)::int AS lines,
                     string_agg(DISTINCT s.stm_doc, ', ') AS docs, MAX(s.stm_date)::text AS stm_date,
                     MAX(s.pid) AS pid, MAX(s.hn) AS hn, MAX(s.service_date)::text AS sdate,
                     MAX(s.patient_name) AS patient_name, MAX(s.fund) AS fund,
                     EXISTS (SELECT 1 FROM nhso_lines n WHERE n.tran_id = s.tran_id AND n.claim_type = 'OPD') AS has_rep
              FROM stm_lines s WHERE s.claim_type = 'OPD' AND s.service_date BETWEEN $1 AND $2
              GROUP BY s.tran_id`, [range.dateFrom, range.dateTo]),
  ]);
  const stm = linkStatements(base, stmRows);

  const pointName = new Map(points.map((p) => [p.code, p.name]));
  const depOwner = new Map();
  points.filter((p) => p.is_active).forEach((p) => (p.dep_codes || []).forEach((d) => depOwner.set(String(d), p.code)));
  const depName = new Map(depts.map((d) => [String(d.code), d.name]));
  const maps = { depOwner, depName, pointName, stm };

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
  const reasons = await explainExtra(base.filter((b) => b.fund_status === 'EXTRA_PAID' && b.vn));
  const rows = [];
  groups.forEach((list) => {
    const main = list.filter((b) => b.fund_status !== 'RECEIVED');
    const tracked = list.filter((b) => b.fund_status === 'RECEIVED');
    if (!main.length) main.push({ ...list[0], fund_code: null, fund_name: null, fund_status: null, stm_fund_amount: null, his_fund_amount: null });
    main.forEach((b) => rows.push(buildRow(b, { depMap, regByVn, maps, reasons })));
    tracked.forEach((b) => rows.push({ ...buildRow(b, { depMap, regByVn, maps }), tracked: true }));
  });
  regNoVisit.forEach((list, key) => {
    const e = list[0];
    const registries = registryTags(list, pointName);
    rows.push(finish({
      key, vn: null, sdate: e.sdate, hn: e.hn, cid: e.cid, patient_name: e.patient_name, pttype_name: null,
      fund: null, eligible: false, sent: false, paid: false, served: false,
      his_total: null, uc_money: null, rep: null, rep_status: null, grp_n: 0, fund_paid: null,
      stm: null, stm_required: false, stm_ok: false,
      registries, rooms: registries.map((t) => t.code), room_names: registries.map((t) => t.name).sort().join(', '), depAmounts: {},
      problems: ['REG_NO_HIS'],
      noHisText: 'ทะเบียนจดไว้ แต่ไม่พบ visit ใน HOSxP วันนี้: ตรวจ HN และวันที่ในทะเบียน หรือดึงข้อมูล HOSxP ใหม่',
    }));
  });
  // Statement ที่ไม่พบทั้งใน REP และ visit ใน HOSxP: แถวแยก
  stm.standalone.forEach((g) => {
    const st = stmInfo([], [g]);
    rows.push(finish({
      key: `S:${g.tran_id}`, vn: null, sdate: g.sdate, hn: g.hn, cid: g.pid, patient_name: g.patient_name, pttype_name: g.fund,
      fund: null, eligible: false, sent: false, paid: false, served: false,
      his_total: null, uc_money: null, rep: null, rep_status: null, grp_n: 0, fund_paid: null,
      stm: st, stm_required: false, stm_ok: false,
      registries: [], rooms: [], room_names: '', depAmounts: {},
      problems: g.has_rep ? [] : ['STM_NO_REP'],
      noHisText: g.has_rep
        ? 'Statement มีรายการ (TRAN_ID อยู่ใน REP คนละช่วงวันที่) แต่ไม่พบ visit ใน HOSxP ช่วงนี้'
        : 'Statement มีรายการ แต่ไม่พบ TRAN_ID ใน REP และไม่พบ visit ใน HOSxP: นำเข้า REP รอบนั้น และตรวจ HN/วันที่',
    }));
  });
  return { rows, depMap, maps };
}

/**
 * เชื่อม Statement กับรายการเบิก
 *  byTran   : TRAN_ID -> ยอด Statement (ใช้กับแถวที่ REP มี TRAN_ID นั้น)
 *  byVisit  : vn -> Statement ที่ไม่พบ TRAN_ID ในแถว REP ใด แต่ตรงกับ visit (เลขบัตรหรือ HN + วันที่)
 *  standalone: Statement ที่หา visit ไม่พบ
 */
function linkStatements(base, stmRows) {
  const byTran = new Map(stmRows.map((g) => [g.tran_id, g]));
  const used = new Set();
  const visitKey = new Map();
  base.forEach((b) => {
    if (b.line_id && b.tran_id) String(b.tran_id).split(', ').forEach((t) => used.add(t));
    if (!b.vn) return;
    if (b.cid && /^\d{13}$/.test(b.cid)) visitKey.set(`${b.cid}|${b.sdate}`, b.vn);
    if (b.hn) visitKey.set(`HN:${String(b.hn).replace(/^0+/, '')}|${b.sdate}`, b.vn);
  });
  const byVisit = new Map();
  const standalone = [];
  stmRows.filter((g) => !used.has(g.tran_id)).forEach((g) => {
    const vn = visitKey.get(`${g.pid}|${g.sdate}`) || (g.hn ? visitKey.get(`HN:${String(g.hn).replace(/^0+/, '')}|${g.sdate}`) : null);
    if (vn) (byVisit.get(vn) || byVisit.set(vn, []).get(vn)).push(g);
    else standalone.push(g);
  });
  return { byTran, byVisit, standalone };
}

/** เหตุผลที่ visit ไม่เข้าเกณฑ์กองทุนใดเลย (ใช้ติดตามคนในทะเบียนที่ตกขั้นเข้าเกณฑ์) */
function noFundReason(b) {
  const hip = String(b.hipdata_code || '').toUpperCase();
  if (env.excludedHipdata.includes(hip)) return `สิทธิ ${b.pttype_name || hip} (${hip}) ไม่นับเข้ากองทุนใด: ตรวจสิทธิใน HOSxP ถ้าคนไข้มีสิทธิเบิกได้`;
  if (num(b.uc_money) <= 0) return 'เรียกเก็บ (HOSxP) เป็น 0 บาท: ตรวจสิทธิ/paidst ของรายการใน HOSxP แล้วดึงข้อมูลใหม่';
  return `สิทธิ ${b.pttype || '-'} ${b.pttype_name || ''} ไม่ตรงกองทุนที่ตั้งค่า หรือไม่มีรายการ/รหัสโรคตามเงื่อนไขกองทุน: ตรวจการตั้งค่ากองทุน`.replace(/\s+/g, ' ');
}

/** สรุป Statement ของแถว: linked = พบ TRAN_ID ของ REP แถวนี้, noRep = TRAN_ID ที่ไม่พบใน REP */
function stmInfo(linked, loose) {
  if (!linked.length && !loose.length) return null;
  const all = [...linked, ...loose];
  const docs = [...new Set(all.flatMap((g) => String(g.docs || '').split(', ')).filter(Boolean))];
  return {
    paid: round2(linked.reduce((a, g) => a + num(g.paid), 0)),          // โอนจริง (STM) ของ TRAN_ID ที่อยู่ใน REP
    total: round2(all.reduce((a, g) => a + num(g.paid), 0)),            // รวมทุกรายการ Statement ของแถว
    linked: linked.length > 0,
    tran_ids: linked.map((g) => g.tran_id).join(', ') || null,
    no_rep: loose.filter((g) => !g.has_rep).map((g) => ({ tran_id: g.tran_id, paid: num(g.paid) })),
    other: loose.filter((g) => g.has_rep).map((g) => ({ tran_id: g.tran_id, paid: num(g.paid) })),
    docs: docs.join(', ') || null,
    stm_date: all.map((g) => g.stm_date).filter(Boolean).sort().pop() || null,
    lines: all.reduce((a, g) => a + g.lines, 0),
  };
}

function buildRow(b, { depMap, regByVn, maps, reasons }) {
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

  // Statement ของแถว: TRAN_ID ของ REP แถวนี้ + Statement ที่ไม่พบใน REP แต่ตรงกับ visit นี้
  const tids = sent && b.tran_id ? String(b.tran_id).split(', ').filter(Boolean) : [];
  const linked = tids.map((t) => maps.stm.byTran.get(t)).filter(Boolean);
  const stm = stmInfo(linked, b.vn ? maps.stm.byVisit.get(b.vn) || [] : []);

  const problems = [];
  if (!b.vn) problems.push('NO_HIS');
  if (b.rep_status === 'DENIED') problems.push('DENIED');
  // มี Statement ของ visit นี้แต่ไม่พบใน REP = ส่งเบิกแล้ว (ยังไม่ได้นำเข้า REP รอบนั้น) ไม่ใช่ยังไม่ส่ง
  if (eligible && !sent && !stm?.no_rep.length) problems.push('NOT_SENT');
  if (fs === 'NOT_PAID') problems.push('NOT_PAID');
  if (b.vn && sent && b.rep_status !== 'DENIED' && Math.abs(num(b.claim_amount) - ucMoney) >= 0.01) problems.push('REP_DIFF');
  if (stm?.no_rep.length) problems.push('STM_NO_REP');
  if (stm?.linked && Math.abs(stm.paid - num(b.compensated)) >= 0.01) problems.push('STM_DIFF');
  if (registries.some((t) => t.status === 'NOT_IN_REGISTRY')) problems.push('NOT_IN_REG');
  if (registries.some((t) => t.status === 'HIS_DIFF' || t.status === 'NO_VISIT')) problems.push('REG_DIFF');
  if (fs === 'EXTRA_PAID') problems.push('EXTRA');

  return finish({
    noFundReason: b.vn && !b.fund_code ? noFundReason(b) : null,
    key: `${b.vn || `L${b.line_id}`}:${b.fund_code || NO_FUND}`,
    vn: b.vn, sdate: b.sdate, hn: b.hn, cid: b.cid, patient_name: b.patient_name, pttype_name: b.pttype_name,
    fund: b.fund_code ? { code: b.fund_code, name: b.fund_name, status: fs, reason: reasons?.get(`${b.vn}|${b.fund_code}`) || null,
      activities: b.act_names || null, act_ids: b.act_ids || [] } : null,
    eligible, sent, paid, served: !!b.vn,
    his_total: b.vn ? (deps.length ? deps.reduce((a, d) => a + d.amount, 0) : num(b.income)) : null,
    uc_money: ucMoney,
    rep: sent ? { claim_amount: num(b.claim_amount), compensated: num(b.compensated), tran_id: b.tran_id, rep_no: b.rep_no, error_code: formatCodes(b.error_code) } : null,
    rep_status: b.rep_status, grp_n: Number(b.grp_n || 0),
    fund_paid: b.fund_code ? num(b.stm_fund_amount) : null,
    stm, stm_required: !!(b.fund_code && b.fund_stm && eligible), stm_ok: !!stm?.linked,
    his_fund_amount: b.his_fund_amount === null ? null : num(b.his_fund_amount),
    registries, rooms, depAmounts, problems,
    room_names: rooms.map((c) => shortName(maps.pointName.get(c) || c)).sort().join(', '),
  });
}

/** ขั้นที่ไปถึง และ "ต้องทำอะไรต่อ" จากปัญหาที่สำคัญที่สุด */
function finish(r) {
  r.stage = !r.served ? 0 : !r.eligible ? 1 : !r.sent ? 2 : !r.paid ? 3 : r.stm_ok ? 5 : 4;
  // พบในแหล่งไหนบ้าง: ทะเบียน (yes/no/none = ห้องไม่มีทะเบียน) · HOSxP · REP
  r.reg_presence = r.registries.some((t) => t.inRegistry) ? 'yes' : r.registries.some((t) => t.status === 'NOT_IN_REGISTRY') ? 'no' : 'none';
  // สถานะแต่ละแหล่ง (ตรงกับจุด 4 จุดบนหน้าจอ): 0 = ไม่มี, 1 = มีแต่มีปัญหา, 2 = มี
  const listed = r.registries.filter((t) => t.inRegistry);
  const regSt = !listed.length ? 0 : listed.some((t) => t.status === 'HIS_DIFF' || t.status === 'NO_VISIT') ? 1 : 2;
  const hisSt = !r.served ? 0 : r.problems.includes('EXTRA') ? 1 : 2;
  const repSt = !r.sent ? 0 : ['DENIED', 'REP_DIFF', 'NOT_PAID'].some((p) => r.problems.includes(p)) ? 1 : 2;
  const stmSt = !r.stm ? 0 : ['STM_DIFF', 'STM_NO_REP'].some((p) => r.problems.includes(p)) ? 1 : 2;
  // เรียง: พบน้อย/มีปัญหามากก่อน (ผลรวม) แล้วจัดกลุ่มตามรูปแบบ ทะเบียน-HOSxP-REP-STM
  r.presence = (regSt + hisSt + repSt + stmSt) * 1000 + regSt * 27 + hisSt * 9 + repSt * 3 + stmSt;
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
    case 'STM_NO_REP': text = r.noHisText || `Statement มี TRAN_ID ${r.stm.no_rep.map((x) => x.tran_id).join(', ')} แต่ไม่พบใน REP: นำเข้าไฟล์ REP รอบนั้น หรือตรวจว่าส่งเบิกซ้ำ`; break;
    case 'STM_DIFF': text = `ได้รับ (REP) ${money(r.rep?.compensated)} แต่โอนจริง (STM) ${money(r.stm.paid)}: ตรวจรอบปรับปรุง/อุทธรณ์ หรือนำเข้า Statement ให้ครบทุกรอบ`; break;
    case 'NOT_IN_REG': case 'REG_DIFF': {
      const t = r.registries.find((x) => (first === 'NOT_IN_REG' ? x.status === 'NOT_IN_REGISTRY' : x.status === 'HIS_DIFF' || x.status === 'NO_VISIT'));
      text = first === 'NOT_IN_REG'
        ? `${t.name}: ${t.issues[0] || 'มีค่าใช้จ่ายใน HOSxP แต่ไม่อยู่ในทะเบียน'} (ให้หน้างานเพิ่มชื่อในทะเบียน)`
        : `${t.name}: ${t.issues[0] || t.label}`;
      break;
    }
    case 'EXTRA': text = `REP จ่ายกองทุน ${fundName} แต่ visit ไม่เข้าเกณฑ์: ${r.fund?.reason || 'ตรวจการตั้งค่ากองทุน หรือยอดเรียกเก็บใน HOSxP'}`; break;
    default:
      text = r.fund?.status === 'RECEIVED' ? `ได้รับเงินกองทุน ${fundName} (ติดตามยอดรับ)`
        : r.paid && r.stm_ok ? `Statement ยืนยันโอนจริง ${money(r.stm.paid)}${r.stm.stm_date ? ` (งวด ${thaiDay(r.stm.stm_date)})` : ''}`
          : r.paid && r.stm_required ? `REP จ่ายแล้ว รอ Statement ยืนยันการโอน${days !== null ? ` (รับบริการมาแล้ว ${days} วัน)` : ''}`
            : r.paid ? 'ได้รับเงินแล้ว' : !r.fund ? (r.sent ? 'ส่งเบิกแล้ว (ไม่เข้าเกณฑ์กองทุนที่ตั้งค่า)' : r.noFundReason || 'ไม่เข้าเกณฑ์กองทุนที่ตั้งค่า') : '–';
  }
  if (r.grp_n > 1 && first && !['NO_HIS', 'REG_NO_HIS', 'STM_NO_REP'].includes(first)) text += ' (มาหลายครั้งในวันเดียว ควรตรวจการจับคู่)';
  r.todo = first
    ? { level: PROBLEMS[first].level, title: first === 'DENIED' && r.rep?.error_code ? `ติด ${r.rep.error_code}` : PROBLEMS[first].label, text }
    : {
      level: r.paid && !(r.stm_required && !r.stm_ok) ? 'ok' : 'none',
      title: r.paid && r.stm_ok ? 'ได้รับโอนแล้ว' : r.paid && r.stm_required ? 'รอ Statement' : r.paid ? 'เรียบร้อย' : !r.fund ? 'ไม่เข้าเกณฑ์' : 'รอผล',
      text,
    };
  delete r.noHisText;
  r.no_fund_reason = r.noFundReason || null;
  r.drop = Number(Object.keys(DROPS).find((k) => DROPS[k].test(r)) || 0) || null;
  delete r.noFundReason;
  return r;
}

/* ---------- ตัวกรอง ---------- */
/** อยู่ในทะเบียน (ของห้องที่เลือก ถ้าเลือกห้อง) */
const inRegistry = (r, pts) => r.registries.some((t) => t.inRegistry && (!pts || pts.has(t.code)));
/** HOSxP มีค่าใช้จ่ายของห้องที่ส่งทะเบียนวันนั้น แต่ไม่อยู่ในทะเบียน */
const missingFromRegistry = (r, pts) => r.registries.some((t) => t.status === 'NOT_IN_REGISTRY' && (!pts || pts.has(t.code)));

function scope(rows, { point, fund, search, base }, includeTracked = false) {
  const pts = point?.length ? new Set(point) : null;
  const fds = fund?.length ? new Set(fund) : null;
  const q = search?.trim().toLowerCase();
  const reg = base === 'reg';
  // base = reg: คนที่อยู่ในทะเบียน (ต้นทางของการติดตาม 100 คน -> 100 คน)
  //   รวมคนที่ HOSxP มีค่าใช้จ่ายของห้องที่ส่งทะเบียนแต่ไม่อยู่ในทะเบียน (ต้องเพิ่มในทะเบียน) ไว้ในตารางด้วย แต่ไม่นับในขั้นตอน
  return rows.filter((r) => (reg ? inRegistry(r, pts) || missingFromRegistry(r, pts) : !pts || r.rooms.some((c) => pts.has(c)))
    // กองทุน หรือกิจกรรมย่อย (รหัส "PP.a12" = กองทุน PP กิจกรรม id 12)
    && (fds ? fds.has(r.fund?.code || NO_FUND) || (r.fund?.act_ids || []).some((id) => fds.has(`${r.fund.code}.a${id}`)) : includeTracked || !r.tracked)
    && (!q || [r.hn, r.cid, r.vn, r.patient_name, r.pttype_name, r.rep?.tran_id, r.rep?.rep_no, r.stm?.docs, ...(r.stm?.no_rep || []).map((x) => x.tran_id), r.fund?.code, r.fund?.name, r.fund?.activities]
      .some((v) => v && String(v).toLowerCase().includes(q))));
}
const STEP_OK = {
  1: (r) => r.served,
  2: (r) => r.eligible,
  3: (r) => r.eligible && r.sent,
  4: (r) => r.eligible && r.paid,
  5: (r) => r.eligible && r.paid && r.stm_ok,
};
/**
 * ตกหล่นที่ขั้นไหน (ผ่านขั้นก่อนหน้า แต่ไม่ผ่านขั้นนี้)
 *  1 อยู่ในทะเบียนแต่ไม่พบใน HOSxP · 2 ไม่เข้าเกณฑ์กองทุน · 3 ยังไม่ส่งเบิก · 4 ส่งแล้วยังไม่ได้เงิน (รวมติด C)
 *  5 ได้รับเงินแล้วแต่ยังไม่พบใน Statement (เฉพาะกองทุนที่ต้องมี Statement)
 */
export const DROPS = {
  1: { label: 'ไม่พบใน HOSxP', test: (r) => !r.served && r.registries.some((t) => t.inRegistry) },
  2: { label: 'ไม่เข้าเกณฑ์กองทุน', test: (r) => r.served && !r.eligible },
  3: { label: 'ยังไม่ส่งเบิก', test: (r) => r.eligible && !r.sent },
  4: { label: 'ยังไม่ได้รับเงิน / ติด C', test: (r) => r.eligible && r.sent && !r.paid },
  5: { label: 'รอ Statement', test: (r) => r.eligible && r.paid && r.stm_required && !r.stm_ok },
};
const DROP_TEST = Object.fromEntries(Object.entries(DROPS).map(([k, d]) => [k, d.test]));

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

/** ยอดในทะเบียนของแถว (เฉพาะห้องที่เลือก) */
const regAmountOf = (r, pts) => r.registries.filter((t) => t.inRegistry && (!pts || pts.includes(t.code)))
  .reduce((a, t) => a + num(t.amount), 0);

function funnel(rows, pts) {
  const served = rows.filter(STEP_OK[1]);
  const elig = rows.filter(STEP_OK[2]);
  const sent = rows.filter(STEP_OK[3]);
  const paid = rows.filter(STEP_OK[4]);
  return {
    served: stepStat(served, (x) => visitSum(x, (r) => costOf(r, pts))),
    eligible: stepStat(elig, (x) => x.reduce((a, r) => a + num(r.his_fund_amount), 0)),
    sent: stepStat(sent, (x) => visitSum(x, (r) => r.rep?.claim_amount)),
    paid: stepStat(paid, (x) => x.reduce((a, r) => a + num(r.fund_paid), 0)),
    notSent: stepStat(elig.filter((r) => !r.sent), (x) => x.reduce((a, r) => a + num(r.his_fund_amount), 0)),
    notPaid: stepStat(sent.filter((r) => !r.paid), (x) => visitSum(x, (r) => r.rep?.claim_amount)),
    // ขั้นได้รับโอนจริง: ฐาน = ได้รับเงินแล้วในกองทุนที่ต้องมี Statement (หรือมี Statement แล้ว)
    stm: stepStat(paid.filter(STEP_OK[5]), (x) => visitSum(x, (r) => r.stm?.paid)),
    stmBase: stepStat(paid.filter((r) => r.stm_required || r.stm_ok), (x) => x.reduce((a, r) => a + num(r.fund_paid), 0)),
    waitStm: stepStat(paid.filter((r) => r.stm_required && !r.stm_ok), (x) => x.reduce((a, r) => a + num(r.fund_paid), 0)),
    registry: stepStat(rows.filter((r) => inRegistry(r, pts ? new Set(pts) : null)), (x) => visitSum(x, (r) => regAmountOf(r, pts))),
    // ตกหล่นแต่ละขั้น (นับคน: คนที่มีบาง visit ตกหล่นนับด้วย)
    drops: Object.fromEntries(Object.entries(DROPS).map(([k, d]) => {
      const hit = rows.filter(d.test);
      return [k, { label: d.label, persons: new Set(hit.map(personKey)).size, visits: new Set(hit.map((r) => r.vn || r.key)).size }];
    })),
  };
}

const SORT = {
  sdate: (r) => r.sdate, hn: (r) => r.hn, patient: (r) => r.patient_name, fund: (r) => r.fund?.code,
  room: (r) => r.room_names, stage: (r) => r.stage, sources: (r) => r.presence, his: (r) => r.his_total, rep: (r) => r.rep?.claim_amount, stm: (r) => r.stm?.total,
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
      (SELECT md5(COALESCE(string_agg(a::text, '|' ORDER BY a.id), '')) FROM fund_activities a),
      (SELECT md5(COALESCE(string_agg(ai::text, '|' ORDER BY ai.activity_id, ai.icode), '')) FROM fund_activity_items ai),
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
  const ptSet = opts.point?.length ? new Set(opts.point) : null;
  // โหมดทะเบียน: ขั้นตอน/ตกหล่น นับเฉพาะคนในทะเบียน
  const regOnly = (r) => opts.base !== 'reg' || inRegistry(r, ptSet);
  const pass = (r) => (!opts.step || (STEP_OK[opts.step]?.(r) && regOnly(r))) && (!opts.problem || r.problems.includes(opts.problem))
    && (!opts.drop || (DROP_TEST[opts.drop]?.(r) && regOnly(r)));
  const filtered = scoped.filter(pass);
  // ได้รับ (กองทุน) นับรวมกองทุนติดตามยอดรับด้วย (ตรงกับหน้าภาพรวม)
  const withTracked = scope(all, opts, true).filter(pass);
  return { scoped, filtered, withTracked, funnelRows: opts.base === 'reg' ? scoped.filter((r) => inRegistry(r, ptSet)) : scoped };
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

/* ---------- สรุปตามห้อง/แผนก: แต่ละห้องตกหล่นที่ขั้นไหน ----------
 * base = reg นับเฉพาะคนในทะเบียนของห้องนั้น · ไม่เช่นนั้นนับ visit ที่มีค่าใช้จ่ายหรือมีชื่อในทะเบียนของห้อง */
function roomSummary(all, opts, maps) {
  const rows = scope(all, { ...opts, point: null });
  const reg = opts.base === 'reg';
  const only = opts.point?.length ? new Set(opts.point) : null;
  const codes = new Set();
  rows.forEach((r) => (reg ? r.registries.filter((t) => t.inRegistry).map((t) => t.code) : r.rooms).forEach((c) => codes.add(c)));
  const persons = (list) => new Set(list.map(personKey)).size;
  return [...codes].filter((c) => !only || only.has(c)).map((c) => {
    const mine = rows.filter((r) => (reg ? r.registries.some((t) => t.inRegistry && t.code === c) : r.rooms.includes(c)));
    const tag = (r) => r.registries.find((t) => t.code === c);
    return {
      code: c, name: maps.pointName.get(c) || c,
      registry: persons(mine.filter((r) => tag(r)?.inRegistry)),
      served: persons(mine.filter(STEP_OK[1])), eligible: persons(mine.filter(STEP_OK[2])),
      sent: persons(mine.filter(STEP_OK[3])), paid: persons(mine.filter(STEP_OK[4])),
      stmBase: persons(mine.filter((r) => STEP_OK[4](r) && (r.stm_required || r.stm_ok))), stm: persons(mine.filter(STEP_OK[5])),
      drops: Object.fromEntries(Object.entries(DROPS).map(([k, d]) => [k, persons(mine.filter(d.test))])),
      notInReg: persons(rows.filter((r) => tag(r)?.status === 'NOT_IN_REGISTRY')),
      regDiff: persons(mine.filter((r) => tag(r)?.status === 'HIS_DIFF')),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

/* ---------- ความครอบคลุมของข้อมูลรายวัน: แต่ละแหล่งมีข้อมูลวันไหน และวันไหนตกหล่น ----------
 *  HOSxP      : วันที่ดึงแล้ว (his_pull_logs) / จำนวน visit
 *  ทะเบียน     : ห้องที่เคยส่งทะเบียน แต่วันนั้นไม่มีทะเบียน ขณะที่ HOSxP มีค่าใช้จ่ายของห้องนั้น = ขาดทะเบียน
 *  REP        : visit เข้าเกณฑ์วันนั้นที่ยังไม่พบใน REP
 *  Statement  : visit ที่ REP จ่ายแล้ว (กองทุนต้องมี Statement) แต่ยังไม่พบใน Statement */
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function mergeRanges(list, from, to) {
  const out = [];
  list.map((x) => [x.date_from > from ? x.date_from : from, x.date_to < to ? x.date_to : to])
    .filter(([a, b]) => a <= b).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .forEach(([a, b]) => {
      const last = out[out.length - 1];
      if (last && a <= addDays(last[1], 1)) { if (b > last[1]) last[1] = b; } else out.push([a, b]);
    });
  return out;
}
const inRanges = (d, ranges) => ranges.some(([a, b]) => d >= a && d <= b);

async function coverage(rows, opts, maps) {
  const { dateFrom: from, dateTo: to } = opts;
  const [{ rows: pulls }, { rows: repDays }, { rows: stmDays }, { rows: regBatches }] = await Promise.all([
    db.query(`SELECT date_from::text, date_to::text FROM his_pull_logs WHERE claim_type = 'OPD' AND date_to >= $1 AND date_from <= $2`, [from, to]),
    db.query(`SELECT service_date::text AS d, COUNT(*)::int AS n FROM nhso_lines WHERE claim_type = 'OPD' AND service_date BETWEEN $1 AND $2 GROUP BY 1`, [from, to]),
    db.query(`SELECT service_date::text AS d, COUNT(*)::int AS n FROM stm_lines WHERE claim_type = 'OPD' AND service_date BETWEEN $1 AND $2 GROUP BY 1`, [from, to]),
    // ทะเบียนที่ยังใช้อยู่ (มีแถว) ของห้องที่เปิดใช้งาน
    db.query(`SELECT b.point_code, b.date_from::text, b.date_to::text FROM point_registry_batches b
              JOIN service_points p ON p.code = b.point_code AND p.is_active
              WHERE EXISTS (SELECT 1 FROM point_registry_rows x WHERE x.batch_id = b.id)`),
  ]);
  const only = opts.point?.length ? new Set(opts.point) : null;
  const hisRanges = mergeRanges(pulls, from, to);
  const repMap = new Map(repDays.map((x) => [x.d, x.n]));
  const stmMap = new Map(stmDays.map((x) => [x.d, x.n]));
  // ห้องที่ส่งทะเบียน: ช่วงวันที่ที่มีทะเบียน (ห้องที่ไม่เคยส่งทะเบียน ไม่นับว่าขาด)
  const regPoints = new Map();
  regBatches.filter((b) => !only || only.has(b.point_code))
    .forEach((b) => (regPoints.get(b.point_code) || regPoints.set(b.point_code, []).get(b.point_code)).push(b));
  const regCover = new Map([...regPoints].map(([c, list]) => [c, mergeRanges(list, from, to)]));

  const day = new Map();
  const get = (d) => {
    if (!day.has(d)) {
      day.set(d, { reg: new Set(), regNoHis: new Set(), notInReg: new Set(), his: new Set(), elig: new Set(), sent: new Set(),
        notSent: new Set(), stmBase: new Set(), stm: new Set(), waitStm: new Set(), roomCost: new Map() });
    }
    return day.get(d);
  };
  rows.forEach((r) => {
    if (!r.sdate || r.sdate < from || r.sdate > to) return;
    const x = get(r.sdate);
    const k = r.vn || r.key;
    if (r.registries.some((t) => t.inRegistry)) x.reg.add(personKey(r));
    if (r.problems.includes('REG_NO_HIS')) x.regNoHis.add(personKey(r));
    if (r.problems.includes('NOT_IN_REG')) x.notInReg.add(personKey(r));
    if (r.served) x.his.add(k);
    if (r.eligible) x.elig.add(k);
    if (r.eligible && r.sent) x.sent.add(k);
    if (DROP_TEST[3](r)) x.notSent.add(k);
    if (STEP_OK[4](r) && (r.stm_required || r.stm_ok)) x.stmBase.add(k);
    if (STEP_OK[5](r)) x.stm.add(k);
    if (DROP_TEST[5](r)) x.waitStm.add(k);
    Object.entries(r.depAmounts || {}).forEach(([c, a]) => { if (a > 0) x.roomCost.set(c, (x.roomCost.get(c) || 0) + 1); });
  });

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const x = day.get(d) || get(d);
    const regGap = [...regCover].filter(([c, rg]) => !inRanges(d, rg) && x.roomCost.get(c) > 0).map(([c]) => c);
    days.push({
      d, pulled: inRanges(d, hisRanges), his: x.his.size,
      reg: x.reg.size, regNoHis: x.regNoHis.size, notInReg: x.notInReg.size, regGap,
      regCovered: [...regCover].filter(([, rg]) => inRanges(d, rg)).map(([c]) => c),
      elig: x.elig.size, sent: x.sent.size, notSent: x.notSent.size, repLines: repMap.get(d) || 0,
      stmBase: x.stmBase.size, stm: x.stm.size, waitStm: x.waitStm.size, stmLines: stmMap.get(d) || 0,
    });
  }
  const span = (m) => {
    const ds = [...m.keys()].sort();
    return ds.length ? { first: ds[0], last: ds[ds.length - 1], days: ds.length, lines: [...m.values()].reduce((a, b) => a + b, 0) } : null;
  };
  return {
    days,
    ranges: {
      his: hisRanges,
      rep: span(repMap),
      stm: span(stmMap),
      registry: [...regCover].map(([code, rg]) => ({ code, name: maps.pointName.get(code) || code, ranges: rg }))
        .sort((a, b) => a.name.localeCompare(b.name, 'th')),
    },
  };
}

export async function listPatients(opts) {
  const { rows: all, depMap, maps } = await loadCached(opts);
  const pts = opts.point?.length ? opts.point : null;
  const { scoped, filtered, withTracked, funnelRows } = applyFilters(all, opts);
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
    funnel: { ...funnel(funnelRows, pts), notInRegistry: stepStat(scoped.filter((r) => missingFromRegistry(r, pts ? new Set(pts) : null)), () => 0) },
    base: opts.base === 'reg' ? 'reg' : 'all',
    rooms: roomSummary(all, opts, maps),
    // ความครอบคลุมของข้อมูลดูทุกแหล่ง (ไม่จำกัดเฉพาะคนในทะเบียน)
    coverage: await coverage(scope(all, { ...opts, base: 'all' }), opts, maps),
    problems,
    // ยอดเงินตามตัวกรองห้อง/กองทุน/ช่วงวันที่/ค้นหา (ไม่เปลี่ยนตามขั้นหรือปัญหาที่กดดู) v54
    money: {
      cost: visitSum(scoped.filter((r) => r.served), (r) => costOf(r, pts)),
      hisClaim: visitSum(scoped.filter((r) => r.served), (r) => r.uc_money),
      repClaim: visitSum(scoped.filter((r) => r.sent), (r) => r.rep?.claim_amount),
      repPaid: visitSum(scoped.filter((r) => r.sent), (r) => r.rep?.compensated),
      stmPaid: visitSum(scoped.filter((r) => r.stm), (r) => r.stm.total),
      // ระดับกองทุน (ตรงกับหน้าภาพรวม)
      fundClaim: scoped.filter((r) => r.eligible).reduce((a, r) => a + num(r.his_fund_amount), 0),
      fundPaid: scope(all, opts, true).filter((r) => r.fund).reduce((a, r) => a + num(r.fund_paid), 0),
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

const STAGE_LABEL = ['ไม่พบ visit', 'ให้บริการ (ไม่เข้าเกณฑ์)', 'เข้าเกณฑ์ ยังไม่ส่งเบิก', 'ส่งเบิกแล้ว ยังไม่ได้รับเงิน', 'ได้รับเงินแล้ว (REP)', 'ได้รับโอนจริง (STM)'];

export async function exportPatients(opts) {
  const { rows: all, maps } = await loadCached(opts);
  const pts = opts.point?.length ? opts.point : null;
  const rows = sortRows(applyFilters(all, opts).filtered, SORT, opts);
  const data = rows.map((r) => ({
    'ขั้นตอน': STAGE_LABEL[r.stage],
    'ตกหล่นที่ขั้น': Object.values(DROPS).find((d) => d.test(r))?.label || null,
    'อยู่ในทะเบียน': r.registries.some((t) => t.inRegistry) ? 'ใช่' : '',
    'ปัญหา': r.problems.map((p) => PROBLEMS[p].label).join(', '),
    'ต้องทำอะไรต่อ': r.todo.text,
    'วันที่รับบริการ': r.sdate,
    'HN': r.hn,
    'เลขบัตรประชาชน': r.cid,
    'ชื่อ-สกุล': r.patient_name,
    'VN': r.vn,
    'สิทธิ': r.pttype_name,
    'กองทุน': r.fund ? `${r.fund.code} ${r.fund.name || ''}`.trim() : 'ไม่เข้าเกณฑ์กองทุน',
    'กิจกรรมย่อย': r.fund?.activities || null,
    'ห้อง/แผนก': r.rooms.map((c) => maps.pointName.get(c) || c).join(', '),
    'ทะเบียน': r.registries.map((t) => `${t.full}${t.amount !== null ? ` ${money(t.amount)}` : ''}${t.inRegistry ? '' : ' (ไม่อยู่ในทะเบียน)'}`).join(', '),
    [pts ? 'ค่าใช้จ่ายของห้องที่เลือก' : 'ค่าใช้จ่ายทั้ง visit']: r.served ? costOf(r, pts) : null,
    'เรียกเก็บ (HOSxP)': r.uc_money,
    'เรียกเก็บ (REP)': r.rep ? r.rep.claim_amount : null,
    'ได้รับ (REP)': r.rep ? r.rep.compensated : null,
    'ตั้งเบิก (กองทุน)': r.eligible ? r.his_fund_amount : null,
    'ได้รับ (กองทุน)': r.fund ? r.fund_paid : null,
    'เหตุผลที่ไม่เข้าเกณฑ์': r.fund?.reason || null,
    'TRAN_ID': r.rep?.tran_id || null,
    'REP No.': r.rep?.rep_no || null,
    'โอนจริง (STM)': r.stm ? r.stm.total : null,
    'เลขที่ STM': r.stm?.docs || null,
    'งวด STM': r.stm?.stm_date ? thaiDay(r.stm.stm_date) : null,
    'รหัสข้อผิดพลาด': r.rep?.error_code || null,
    'ผลการแก้ไข / หมายเหตุ': '',
  }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ 'ขั้นตอน': 'ไม่มีข้อมูล' }]);
  ws['!cols'] = [24, 22, 10, 30, 50, 12, 11, 15, 22, 14, 22, 26, 26, 30, 14, 14, 14, 14, 14, 14, 40, 16, 12, 14, 36, 12, 12, 28].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'รายชื่อคนไข้');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: data.length };
}

/* =====================================================================
 * ติดตามทะเบียน (v53): ทุกรายการในทะเบียน (1 รายการ = คน 1 คนใน 1 วัน = 1 visit) มีสถานะเดียว
 *  ติดที่ขั้น 1 ไม่พบใน HOSxP · 2 เบิกไม่ได้ · 3 ยังไม่ส่งเบิก · 4 ยังไม่ได้รับเงิน · 5 ยังไม่มีเงินเข้า · 6 ครบ
 *  visit ที่มีหลายกองทุน: ใช้ขั้นที่ต่ำที่สุดของกองทุนที่เข้าเกณฑ์ (ต้องครบทุกกองทุนจึงนับว่าครบ)
 *  ขั้น 5 ใช้กับกองทุนที่ "ต้องมี Statement" เท่านั้น กองทุนอื่นนับว่าเงินเข้าเมื่อ สปสช. จ่าย
 * ===================================================================== */
export const TRACK_STEPS = [
  { k: 1, label: 'พบใน HOSxP', stuck: 'หาใน HOSxP ไม่เจอ', hint: 'HN หรือวันที่ในทะเบียนอาจพิมพ์ผิด หรือยังไม่ได้ดึงข้อมูล HOSxP วันนั้น: ให้หน้างานตรวจแล้วอัปโหลดใหม่' },
  { k: 2, label: 'เบิกได้', stuck: 'เบิกไม่ได้', hint: 'สิทธิ รายการ หรือรหัสโรคใน HOSxP ไม่ตรงเงื่อนไขกองทุน: ตรวจสิทธิและการลงรายการ' },
  { k: 3, label: 'ส่งเบิกแล้ว', stuck: 'ยังไม่ส่งเบิก', hint: 'เบิกได้แล้ว แต่ยังไม่พบในผลการส่งเบิก (REP): ส่งเบิกใน e-Claim' },
  { k: 4, label: 'สปสช. จ่าย', stuck: 'ยังไม่ได้รับเงิน', hint: 'ส่งแล้ว แต่ถูกปฏิเสธ (ติด C) หรือยังไม่จ่าย: แก้ตามรหัสแล้วส่งใหม่' },
  { k: 5, label: 'เงินเข้าแล้ว', stuck: 'ยังไม่มีเงินเข้า', hint: 'สปสช. จ่ายแล้ว แต่ยังไม่พบในไฟล์ยืนยันการโอนเงิน (Statement)' },
];
const TRACK_SEL = ['all', '1', '2', '3', '4', '5', 'done', 'out', 'diff'];
export const isTrackSel = (v) => TRACK_SEL.includes(String(v));

/** สถานะของ visit จากแถวกองทุนของ visit นั้น */
function visitStage(list) {
  const r0 = list[0];
  if (!r0.served) return 1;
  const elig = list.filter((r) => r.eligible);
  if (!elig.length) return 2;
  if (elig.some((r) => !r.sent)) return 3;
  if (elig.some((r) => !r.paid)) return 4;
  if (elig.some((r) => r.stm_required && !r.stm_ok)) return 5;
  return 6;
}

/** สาเหตุ / ต้องทำอะไร / รอผล ของรายการที่ติดขั้นนั้น */
function trackCause(stage, list, dates) {
  const r = list[0];
  const elig = list.filter((x) => x.eligible);
  const funds = [...new Set(elig.map((x) => x.fund.code))].join(', ');
  const split = (t) => { const i = String(t || '').indexOf(': '); return i > 0 ? [t.slice(0, i), t.slice(i + 2)] : [t, null]; };
  switch (stage) {
    case 1: return { cause: `HN ${r.hn || '-'} ไม่พบ visit ใน HOSxP วันที่นี้`, todo: 'ตรวจ HN และวันที่ในทะเบียน แล้วอัปโหลดใหม่' };
    case 2: {
      const why = list.map((x) => x.no_fund_reason || x.fund?.reason).find(Boolean);
      const [c, t] = split(why || 'ไม่ตรงเงื่อนไขกองทุนที่ตั้งค่า');
      return { cause: `${r.pttype_name && !String(c).includes('สิทธิ') ? `สิทธิ ${r.pttype_name} · ` : ''}${c}`, todo: t || 'ตรวจสิทธิ/รายการใน HOSxP หรือการตั้งค่ากองทุน' };
    }
    case 3: {
      const x = elig.find((e) => !e.sent);
      const wait = dates.rep && r.sdate > dates.rep;
      return { cause: `เบิกได้ ${money(x.his_fund_amount ?? x.uc_money)} บาท · ${x.fund.code}`, todo: wait ? 'รอนำเข้าผลการส่งเบิก (REP) รอบถัดไป' : 'ส่งเบิกใน e-Claim', wait };
    }
    case 4: {
      const x = elig.find((e) => e.sent && !e.paid);
      if (x.rep_status === 'DENIED') return { cause: `ถูกปฏิเสธ ${x.rep?.error_code || ''} · ${x.fund.code}`, todo: 'แก้ตามรหัสข้อผิดพลาด แล้วส่งเบิกใหม่', code: x.rep?.error_code };
      return { cause: `ส่งแล้ว เรียกเก็บ ${money(x.rep?.claim_amount)} บาท ยังไม่ได้รับเงินกองทุน ${x.fund.code}`, todo: 'รอ สปสช. หรือตรวจรายการที่ส่ง', wait: true };
    }
    case 5: {
      const x = elig.find((e) => e.stm_required && !e.stm_ok);
      const wait = !dates.stm || r.sdate > dates.stm;
      return { cause: `สปสช. จ่าย ${money(x.fund_paid)} บาท · ${x.fund.code}`, todo: wait ? 'รอไฟล์ Statement รอบถัดไป' : 'ตรวจว่า Statement มี TRAN_ID นี้หรือไม่', wait };
    }
    default: {
      const stm = list.find((x) => x.stm)?.stm;
      return { cause: stm ? `เงินเข้า ${money(stm.total)} บาท` : `สปสช. จ่าย ${money(elig.reduce((a, x) => a + num(x.fund_paid), 0))} บาท (${funds})`, todo: null };
    }
  }
}

export async function trackRegistry(opts) {
  const { rows: all, depMap, maps } = await loadCached(opts);
  const pts = opts.point?.length ? new Set(opts.point) : null;
  const { rows: [d] } = await db.query(`
    SELECT (SELECT MAX(service_date)::text FROM nhso_lines WHERE claim_type = 'OPD') AS rep,
           (SELECT MAX(service_date)::text FROM stm_lines WHERE claim_type = 'OPD') AS stm,
           (SELECT MAX(date_to)::text FROM his_pull_logs WHERE claim_type = 'OPD') AS his`);
  const base = all.filter((r) => !r.tracked);

  // รายการในทะเบียน = visit (หรือคน+วันที่ ถ้าไม่พบ visit) ที่อยู่ในทะเบียนของห้องที่เลือก
  const groups = new Map();
  base.filter((r) => inRegistry(r, pts)).forEach((r) => {
    const k = r.vn || r.key;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  });
  const items = [...groups.values()].map((list) => {
    const stage = visitStage(list);
    const r = list[0];
    const tags = r.registries.filter((t) => t.inRegistry && (!pts || pts.has(t.code)));
    return { list, stage, r, rooms: tags.map((t) => t.name).join(', '), regAmount: tags.some((t) => t.amount !== null) ? tags.reduce((a, t) => a + num(t.amount), 0) : null,
      diff: tags.some((t) => t.status === 'HIS_DIFF') };
  });
  const total = items.length;
  const steps = TRACK_STEPS.map((s) => ({ ...s, reached: items.filter((x) => x.stage > s.k).length, stuckCount: items.filter((x) => x.stage === s.k).length }));
  const outRows = base.filter((r) => missingFromRegistry(r, pts));
  const outMap = new Map(); outRows.forEach((r) => outMap.set(r.vn, r));

  // รายชื่อของกลุ่มที่เลือก
  const sel = String(opts.sel || 'all');
  let picked;
  if (sel === 'out') picked = [...outMap.values()].map((r) => ({ kind: 'out', r }));
  else if (sel === 'diff') picked = items.filter((x) => x.diff).map((x) => ({ kind: 'diff', ...x }));
  else if (sel === 'done') picked = items.filter((x) => x.stage === 6).map((x) => ({ kind: 'item', ...x }));
  else if (sel === 'all') picked = items.map((x) => ({ kind: 'item', ...x }));
  else picked = items.filter((x) => x.stage === Number(sel)).map((x) => ({ kind: 'item', ...x }));

  const q = opts.search?.trim().toLowerCase();
  if (q) picked = picked.filter((x) => [x.r.hn, x.r.cid, x.r.patient_name, x.r.vn].some((v) => v && String(v).toLowerCase().includes(q)));
  picked.sort((a, b) => plain(a.r.sdate, b.r.sdate) || plain(a.r.hn, b.r.hn));

  const toRow = (x) => {
    const r = x.r;
    const base0 = { key: r.vn || r.key, vn: r.vn, sdate: r.sdate, hn: r.hn, cid: r.cid, patient_name: r.patient_name };
    if (x.kind === 'out') {
      const t = r.registries.find((y) => y.status === 'NOT_IN_REGISTRY' && (!pts || pts.has(y.code)));
      return { ...base0, rooms: t?.name || '', cause: `ค่าใช้จ่ายของห้องนี้ใน HOSxP ${money(t?.his_amount)} บาท`, todo: 'เพิ่มชื่อในทะเบียน แล้วอัปโหลดใหม่', stage: null,
        sources: { reg: null, his: r.his_total, pttype: r.pttype_name, rep: r.rep ? { tran_id: r.rep.tran_id, claim: r.rep.claim_amount, paid: r.rep.compensated, error: r.rep.error_code } : null, stm: r.stm?.total ?? null } };
    }
    const c = x.kind === 'diff'
      ? { cause: x.list[0].registries.filter((t) => t.status === 'HIS_DIFF').flatMap((t) => t.issues)[0] || 'ยอดไม่ตรง', todo: 'ตรวจรายการใน HOSxP หรือแก้ยอดในทะเบียน' }
      : trackCause(x.stage, x.list, d);
    const any = (f) => x.list.some(f);
    return {
      ...base0, rooms: x.rooms, stage: x.stage, diffFlag: !!x.diff, ...c,
      sources: {
        reg: x.regAmount, his: r.served ? r.his_total : null, pttype: r.pttype_name,
        rep: any((y) => y.rep) ? { tran_id: x.list.find((y) => y.rep).rep.tran_id, claim: x.list.find((y) => y.rep).rep.claim_amount, paid: x.list.find((y) => y.rep).rep.compensated, error: x.list.find((y) => y.rep).rep.error_code } : null,
        stm: x.list.find((y) => y.stm)?.stm?.total ?? null,
        funds: [...new Set(x.list.filter((y) => y.fund).map((y) => y.fund.code))].join(', ') || null,
      },
    };
  };
  const size = Math.min(Math.max(Number(opts.pageSize) || 20, 10), 500);
  const page = Math.max(Number(opts.page) || 1, 1);
  const pageRows = picked.slice((page - 1) * size, page * size).map(toRow);
  // คำอธิบายรหัสข้อผิดพลาด (เฉพาะแถวที่แสดง)
  const ann = await annotateErrors(pageRows.map((x) => ({ key: x.key, error_code: x.code || null })));
  const annMap = new Map(ann.map((a) => [a.key, a]));
  pageRows.forEach((x) => { if (x.code) { const a = annMap.get(x.key); const strip = (t) => t.split('\n')[0].replace(/^[A-Z]?\d+\s*:\s*/, '');
      if (a?.error_guidance) x.todo = strip(a.error_guidance); if (a?.error_detail) x.cause += ` · ${strip(a.error_detail)}`; } delete x.code; });

  return {
    total, steps, done: items.filter((x) => x.stage === 6).length,
    out: outMap.size, diff: items.filter((x) => x.diff).length,
    dates: d, sel, count: picked.length, page, pageSize: size, rows: pageRows,
    _pick: picked, _toRow: toRow,
  };
}

export async function exportTrack(opts) {
  const data = await trackRegistry({ ...opts, page: 1, pageSize: 500 });
  const rows = data._pick.map(data._toRow);
  const stepName = (s) => (s === 6 ? 'ครบ (เงินเข้าแล้ว)' : s ? `${s}. ${TRACK_STEPS[s - 1].stuck}` : '');
  const out = rows.map((x) => ({
    'วันที่รับบริการ': x.sdate ? thaiDay(x.sdate) : null, 'HN': x.hn, 'เลขบัตรประชาชน': x.cid, 'ชื่อ-สกุล': x.patient_name, 'ห้อง/แผนก': x.rooms,
    'ติดที่ขั้น': stepName(x.stage), 'สาเหตุ': x.cause, 'ต้องทำอะไร': x.todo || '', 'รอผล': x.wait ? 'ใช่' : '',
    'กองทุน': x.sources?.funds || '', 'TRAN_ID': x.sources?.rep?.tran_id || '', 'ผลการแก้ไข / หมายเหตุ': '',
  }));
  const ws = XLSX.utils.json_to_sheet(out.length ? out : [{ 'วันที่รับบริการ': 'ไม่มีข้อมูล' }]);
  ws['!cols'] = [12, 11, 15, 24, 22, 22, 50, 40, 8, 12, 16, 28].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ติดตามทะเบียน');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: out.length };
}
