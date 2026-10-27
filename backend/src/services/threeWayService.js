import * as XLSX from 'xlsx';
import { db } from '../config/db.js';
import { baseCte, baseParams } from './reconService.js';
import { annotateErrors, formatCodes } from './errorCodeService.js';
import { departments, listPoints, pointEntries } from './pointService.js';
import { fundsOfVisits } from './fundService.js';
import { sortRows } from '../utils/sort.js';

/* =====================================================================
 * เทียบ 3 แหล่งแบบรวม (หน้าเดียว ไม่ต้องเลือกห้องหรือกองทุน)
 *  หนึ่งแถว = หนึ่ง visit (หรือคนไข้ 1 คนใน 1 วัน ถ้าหา visit ไม่พบ)
 *  ทะเบียน : ทะเบียนของห้อง/แผนก (จุดบริการ) ที่เกี่ยวกับ visit นั้น
 *  กองทุน  : กองทุนที่ visit เข้าเกณฑ์ใน HOSxP (ตามการตั้งค่ากองทุน ไม่ใช้ทะเบียนกองทุน)
 *  HOSxP   : ยอดทั้ง visit แยกตามห้องที่บันทึก (dep_code)
 *  REP     : เรียกเก็บ / ได้รับ / ติด C ของ visit นั้น
 * ===================================================================== */

/** ผลการเทียบ เรียงจากเรื่องที่ต้องแก้ก่อน */
export const THREE_WAY_STATUSES = {
  NO_VISIT:        { label: 'ไม่พบ visit ใน HOSxP' },
  HIS_DIFF:        { label: 'ทะเบียนไม่ตรงกับ HOSxP' },
  NOT_IN_REGISTRY: { label: 'ไม่อยู่ในทะเบียน' },
  // ฝั่ง REP ใช้ผลและชื่อเดียวกับหน้ากระทบยอด OPD (เรียกเก็บ (HOSxP) = uc_money เทียบ เรียกเก็บ (REP))
  DENIED:          { label: 'ถูกปฏิเสธ / ติด C' },
  NOT_IN_REP:      { label: 'ยังไม่พบใน REP' },
  REP_DIFF:        { label: 'ยอดต่าง (HOSxP–REP)' },
  MATCH:           { label: 'ตรงกันครบ 3 แหล่ง' },
};
const ORDER = Object.keys(THREE_WAY_STATUSES);
const worst = (list) => list.reduce((a, s) => (ORDER.indexOf(s) < ORDER.indexOf(a) ? s : a), 'MATCH');
const money = (v) => Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ชื่อห้องแบบสั้น: ตัดเลขลำดับหน้าชื่อ เช่น "007 ห้องตรวจทันตกรรม" -> "ห้องตรวจทันตกรรม" */
export const shortName = (name) => String(name || '').replace(/^[\d.\-\s]+/, '') || String(name || '');

// สถานะฝั่งทะเบียน-HOSxP (ใช้ทำป้ายในคอลัมน์ทะเบียน) สถานะฝั่ง REP ถือว่าทะเบียนปกติ
const REG_SIDE = ['NO_VISIT', 'HIS_DIFF', 'NOT_IN_REGISTRY'];

/**
 * ป้ายทะเบียนของ visit: หนึ่งป้ายต่อห้อง/แผนก (entries จาก pointEntries ของ visit เดียวกัน)
 * status = ผลฝั่งทะเบียน-HOSxP (MATCH / HIS_DIFF / NOT_IN_REGISTRY / NO_VISIT)
 */
export function registryTags(entries, pointName) {
  const tagMap = new Map();
  entries.forEach((e) => {
    const k = `${e.kind}:${e.code}`;
    if (!tagMap.has(k)) {
      tagMap.set(k, {
        kind: e.kind, code: e.code,
        name: shortName(pointName.get(e.code) || e.code),
        full: pointName.get(e.code) || e.code,
        entries: [],
      });
    }
    tagMap.get(k).entries.push(e);
  });
  return [...tagMap.values()].map((t) => {
    const regStatus = worst(t.entries.map((e) => (REG_SIDE.includes(e.status) ? e.status : 'MATCH')));
    const inReg = t.entries.some((e) => e.src === 'REG');
    const amounts = t.entries.filter((e) => e.src === 'REG').map((e) => e.reg_amount)
      .filter((a) => a !== null && a !== undefined);
    return {
      kind: t.kind, code: t.code, name: t.name, full: t.full, status: regStatus, inRegistry: inReg,
      amount: amounts.length ? amounts.reduce((a, b) => a + Number(b), 0) : null,
      his_amount: t.entries[0].his_amount,
      optional_amount: t.entries[0].optional_amount,
      optional_drug_amount: t.entries[0].optional_drug_amount,
      note: t.entries.map((e) => e.note).find(Boolean) || null,
      rows: t.entries.reduce((a, e) => a + (e.reg_rows || 0), 0),
      label: THREE_WAY_STATUSES[regStatus].label,
      issues: [...new Set(t.entries.flatMap((e) => e.issues))],
    };
  });
}

/** ข้อมูล HOSxP และ REP ของ visit ทั้งหมดที่เกี่ยวข้อง */
async function visitData(vns, range) {
  if (!vns.length) return { visits: new Map(), deps: new Map(), reps: new Map() };
  const [{ rows: visits }, { rows: deps }, { rows: reps }] = await Promise.all([
    db.query('SELECT vn, hn, cid, ptname, vstdate::text AS vstdate, pttype_name, uc_money FROM his_opd_visits WHERE vn = ANY($1)', [vns]),
    db.query(`SELECT vn, dep_code, SUM(amount) AS amount, SUM(optional_amount) AS optional_amount, SUM(optional_drug_amount) AS optional_drug_amount FROM his_opd_dep
              WHERE vn = ANY($1) GROUP BY vn, dep_code ORDER BY vn, SUM(amount) DESC`, [vns]),
    db.query(`${baseCte('claim')} SELECT vn, line_id, claim_amount, compensated, error_code, tran_id, rep_no, status, uc_money, grp_n
              FROM r WHERE vn = ANY($5)`, [...baseParams({ ...range, fund: null, onlyClaimable: false }), vns]),
  ]);
  const depMap = new Map();
  deps.forEach((d) => {
    (depMap.get(d.vn) || depMap.set(d.vn, []).get(d.vn))
      .push({ dep: d.dep_code, amount: Number(d.amount), optional_amount: Number(d.optional_amount || 0), optional_drug_amount: Number(d.optional_drug_amount || 0) });
  });
  return {
    visits: new Map(visits.map((v) => [v.vn, v])),
    deps: depMap,
    reps: new Map((await annotateErrors(reps)).map((r) => [r.vn, r])),
  };
}

async function buildRows(range) {
  const [points, pEntries, depts] = await Promise.all([listPoints(), pointEntries(range), departments()]);
  const pointName = new Map(points.map((p) => [p.code, p.name]));
  const depOwner = new Map();
  points.filter((p) => p.is_active).forEach((p) => (p.dep_codes || []).forEach((d) => depOwner.set(String(d), p.code)));
  const depName = new Map(depts.map((d) => [String(d.code), d.name]));

  // จัดกลุ่มตาม visit (ไม่พบ visit: คนไข้ + วันที่)
  const groups = new Map();
  pEntries.forEach((e) => {
    const who = String(e.hn || '').replace(/^0+/, '') || e.cid || `?${e.reg_id || Math.random()}`;
    const key = e.vn || `nv:${e.sdate}:${who}`;
    if (!groups.has(key)) groups.set(key, { key, vn: e.vn || null, sdate: e.sdate, hn: e.hn, cid: e.cid, patient_name: e.patient_name, entries: [] });
    const g = groups.get(key);
    g.entries.push(e);
    if (!g.patient_name && e.patient_name) g.patient_name = e.patient_name;
    if (!g.cid && e.cid) g.cid = e.cid;
  });

  const vns = [...groups.values()].map((g) => g.vn).filter(Boolean);
  const [{ visits, deps, reps }, fundMap] = await Promise.all([visitData(vns, range), fundsOfVisits(range, vns)]);

  return [...groups.values()].map((g) => {
    const v = g.vn ? visits.get(g.vn) : null;
    const rep = g.vn ? reps.get(g.vn) : null;
    const breakdown = g.vn ? (deps.get(g.vn) || []) : [];
    const vnTotal = breakdown.reduce((a, b) => a + b.amount, 0);

    const registries = registryTags(g.entries, pointName);

    // REP ระดับ visit: เกณฑ์เดียวกับหน้ากระทบยอด OPD (ผลจับคู่ status จาก baseCte)
    //   DENIED = ติด C / NOT_IN_STM = ยังไม่พบใน REP / เรียกเก็บ (REP) ต่างจาก เรียกเก็บ (HOSxP) = ยอดต่าง
    const err = rep ? formatCodes(rep.error_code) : null;
    const ucMoney = v ? Number(rep?.uc_money ?? v.uc_money ?? 0) : null;
    let repStatus = null;
    let repIssue = null;
    if (g.vn) {
      if (rep?.status === 'DENIED') {
        repStatus = 'DENIED';
        repIssue = `ติด ${err || 'C'}${rep.error_detail ? `: ${rep.error_detail.split('\n')[0].replace(/^\w+: /, '')}` : ''}`;
      } else if (!rep?.line_id) {
        repStatus = 'NOT_IN_REP'; repIssue = 'ยังไม่พบใน REP';
      } else if (Math.abs(Number(rep.claim_amount || 0) - ucMoney) >= 0.01) {
        repStatus = 'REP_DIFF';
        repIssue = `เรียกเก็บ (HOSxP) ${money(ucMoney)} แต่เรียกเก็บ (REP) ${money(rep.claim_amount || 0)}`;
      }
      if (rep?.grp_n > 1) {
        const note = 'คนไข้มาหลายครั้งในวันเดียว ระบบจับคู่ REP ตามลำดับยอดเงิน ควรตรวจ';
        repIssue = repIssue ? `${repIssue} (${note})` : null;
      }
    }

    const status = worst([...g.entries.map((e) => e.status), repStatus || 'MATCH']);
    const issues = [];
    registries.forEach((t) => t.issues.forEach((s) => issues.push(`${t.name}: ${s}`)));
    if (repIssue) issues.push(`REP: ${repIssue}`);

    return {
      key: g.key, vn: g.vn, sdate: v?.vstdate || g.sdate,
      hn: v?.hn || g.hn, cid: v?.cid || g.cid, patient_name: g.patient_name || v?.ptname, pttype_name: v?.pttype_name || null,
      registries,
      // กองทุนที่ visit เข้าเกณฑ์ (eligible=false: REP จ่ายเงินกองทุนนี้ แต่ visit ไม่เข้าเกณฑ์ตามการตั้งค่า)
      funds: (fundMap.get(g.vn) || []).map((f) => ({ code: f.code, name: f.name, eligible: f.fund_status !== 'EXTRA_PAID' })),
      vn_total: g.vn ? vnTotal : null,
      breakdown: roomsOf(breakdown, registries, { depOwner, depName, pointName }),
      uc_money: ucMoney,
      rep: rep?.line_id ? {
        claim_amount: rep.claim_amount, compensated: rep.compensated, tran_id: rep.tran_id, rep_no: rep.rep_no,
        error_code: err, error_detail: err ? rep.error_detail : null, error_guidance: err ? rep.error_guidance : null,
      } : null,
      rep_status: repStatus,
      status,
      issues: status === 'MATCH' ? [] : issues,
    };
  });
}

/**
 * ค่าใช้จ่ายของ visit จัดกลุ่มตามห้อง/แผนก (แผนกที่ผูกกับห้องเดียวกันอยู่กลุ่มเดียวกัน)
 * สถานะทะเบียนเป็นของ "ห้อง" ไม่ใช่ของแต่ละแผนก:
 *   ok = ตรงทะเบียน / diff = ไม่ตรง / missing = ไม่อยู่ในทะเบียน / none = ไม่มีทะเบียนของห้องนี้ใน visit นี้
 */
export function roomsOf(deps, registries, { depOwner, depName, pointName }) {
  const rooms = new Map();
  deps.forEach((b) => {
    const owner = depOwner.get(String(b.dep)) || null;
    const key = owner ? `p:${owner}` : `d:${b.dep}`;
    if (!rooms.has(key)) {
      const t = owner ? registries.find((x) => x.kind === 'point' && x.code === owner) : null;
      rooms.set(key, {
        code: owner, name: owner ? pointName.get(owner) : null,
        reg: !t ? 'none' : t.status === 'MATCH' ? 'ok' : t.status === 'NOT_IN_REGISTRY' ? 'missing' : 'diff',
        reg_amount: t?.inRegistry ? t.amount : null, note: t?.note || null,
        amount: 0, optional_amount: 0, optional_drug_amount: 0, deps: [],
      });
    }
    const r = rooms.get(key);
    r.amount += b.amount; r.optional_amount += b.optional_amount; r.optional_drug_amount += b.optional_drug_amount || 0;
    r.deps.push({ ...b, name: depName.get(String(b.dep)) || null });
  });
  return [...rooms.values()].sort((a, b) => (a.reg === 'none') - (b.reg === 'none') || b.amount - a.amount);
}

const SORT = {
  sdate: (r) => r.sdate, hn: (r) => r.hn, registry: (r) => r.registries.map((t) => t.name).join(','),
  his: (r) => r.vn_total, rep: (r) => (r.rep ? Number(r.rep.claim_amount) : null), status: (r) => ORDER.indexOf(r.status),
};
const DEFAULT_SORT = (rows) => rows.sort((a, b) => String(a.sdate).localeCompare(String(b.sdate))
  || String(a.hn || '').localeCompare(String(b.hn || '')));

/** ห้อง/แผนก (เลือกได้หลายห้อง): มีทะเบียนของห้องที่เลือก หรือมีค่าใช้จ่ายของห้องนั้นใน HOSxP · กองทุน (หลายกองทุน): visit เข้าเกณฑ์กองทุนที่เลือก */
function scopeRows(all, { point, fund }) {
  const pts = point?.length ? new Set(point) : null;
  const fds = fund?.length ? new Set(fund) : null;
  return all.filter((r) => (!pts || r.registries.some((t) => t.kind === 'point' && pts.has(t.code))
      || r.breakdown.some((g) => pts.has(g.code) && Number(g.amount || 0) > 0))
    && (!fds || r.funds.some((f) => f.eligible && fds.has(f.code))));
}

function filterRows(all, { status, search, point, fund }) {
  const q = search?.trim().toLowerCase();
  return scopeRows(all, { point, fund }).filter((r) => (!status || r.status === status)
    && (!q || [r.hn, r.cid, r.vn, r.patient_name, r.rep?.tran_id, ...r.registries.map((t) => t.full),
      ...r.funds.flatMap((f) => [f.code, f.name])]
      .some((v) => v && String(v).toLowerCase().includes(q))));
}

export async function compareAll({ dateFrom, dateTo, status, search, point, fund, page = 1, pageSize = 50, sort, dir }) {
  const all = scopeRows(DEFAULT_SORT(await buildRows({ dateFrom, dateTo })), { point, fund });
  const summary = Object.fromEntries(ORDER.map((k) => [k, 0]));
  all.forEach((r) => { summary[r.status] += 1; });
  const totals = {
    visits: all.length,
    his: all.reduce((a, r) => a + Number(r.vn_total || 0), 0),
    hisClaim: all.reduce((a, r) => a + Number(r.uc_money || 0), 0),
    repClaim: all.reduce((a, r) => a + Number(r.rep?.claim_amount || 0), 0),
    repPaid: all.reduce((a, r) => a + Number(r.rep?.compensated || 0), 0),
  };
  const filtered = sortRows(filterRows(all, { status, search }), SORT, { sort, dir });
  const size = Math.min(Math.max(Number(pageSize) || 50, 10), 500);
  const p = Math.max(Number(page) || 1, 1);

  // สถานะทะเบียนที่มีในช่วงนี้ + ทะเบียนใหม่กว่าข้อมูล HOSxP + ชื่อรายการที่ยังไม่รู้จัก
  const { rows: [st] } = await db.query(`
    SELECT (SELECT COUNT(*)::int FROM point_registry_rows WHERE service_date BETWEEN $1 AND $2) AS reg_rows,
           (SELECT MAX(created_at) FROM point_registry_batches) AS uploaded_at,
           (SELECT MAX(created_at) FROM his_pull_logs WHERE claim_type = 'OPD') AS pulled_at,
           (SELECT updated_at FROM app_settings WHERE key = 'optional_fee_items') AS fee_at`, [dateFrom, dateTo]);

  return {
    summary, statuses: THREE_WAY_STATUSES, totals, total: filtered.length, page: p, pageSize: size,
    rows: filtered.slice((p - 1) * size, p * size),
    registryRows: st.reg_rows,
    stale: !!(st.uploaded_at && st.pulled_at && st.uploaded_at > st.pulled_at),
    // ตั้งค่าค่าบริการอัตโนมัติหลังดึงข้อมูล HOSxP: ต้องดึงใหม่จึงจะแยกยอดรายการนี้ได้
    staleFee: !!(st.fee_at && st.pulled_at && st.fee_at > st.pulled_at),
  };
}

export async function exportAll(opts) {
  const rows = sortRows(filterRows(DEFAULT_SORT(await buildRows(opts)), opts), SORT, opts);
  const data = rows.map((r) => ({
    'ผลการเทียบ': THREE_WAY_STATUSES[r.status].label,
    'จุดที่ต่าง': r.issues.join(' / '),
    'วันที่รับบริการ': r.sdate,
    'HN': r.hn,
    'เลขบัตรประชาชน': r.cid,
    'ชื่อ-สกุล': r.patient_name,
    'VN': r.vn,
    'กองทุนที่เข้าเกณฑ์': r.funds.filter((f) => f.eligible).map((f) => f.code).join(', '),
    'ทะเบียน': r.registries.map((t) => `${t.full}${t.amount !== null ? ` ${money(t.amount)}` : ''}${t.inRegistry ? '' : ' (ไม่อยู่ในทะเบียน)'}`).join(', '),
    'HOSxP ทั้ง visit': r.vn_total,
    'เรียกเก็บ (HOSxP)': r.uc_money,
    'HOSxP แยกตามห้อง': r.breakdown.flatMap((g) => g.deps).map((b) => `${b.name || `แผนก ${b.dep}`}: ${money(b.amount)}`).join(', '),
    'เรียกเก็บ (REP)': r.rep ? Number(r.rep.claim_amount || 0) : null,
    'ได้รับ (REP)': r.rep ? Number(r.rep.compensated || 0) : null,
    'REP: TRAN_ID': r.rep?.tran_id || null,
    'รหัสข้อผิดพลาด': r.rep?.error_code || null,
    'ผลการแก้ไข / หมายเหตุ': '',
  }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ 'ผลการเทียบ': 'ไม่มีข้อมูล' }]);
  ws['!cols'] = [22, 60, 12, 11, 15, 22, 14, 16, 40, 14, 14, 50, 14, 14, 14, 12, 28].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'เทียบ 3 แหล่ง');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: data.length };
}

/** ประวัติอัปโหลดทะเบียนห้อง/แผนก */
export async function listUploads() {
  const { rows } = await db.query(`
    SELECT 'point' AS kind, b.id, b.point_code AS target_code, p.name AS target_name, b.file_name, b.date_from, b.date_to,
           b.valid_rows, b.error_rows, b.created_at, b.uploaded_by, u.full_name AS uploaded_by_name,
           (SELECT COUNT(*)::int FROM point_registry_rows r WHERE r.batch_id = b.id) AS current_rows
    FROM point_registry_batches b LEFT JOIN service_points p ON p.code = b.point_code LEFT JOIN users u ON u.id = b.uploaded_by
    ORDER BY created_at DESC LIMIT 100`);
  return rows;
}
