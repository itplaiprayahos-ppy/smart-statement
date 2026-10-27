import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { db, withTransaction } from '../config/db.js';
import { baseCte, baseParams } from './reconService.js';
import { annotateErrors, formatCodes } from './errorCodeService.js';
import { listDepartments } from './hosxpService.js';
import { sortRows } from '../utils/sort.js';

/* =====================================================================
 * เทียบยอดตามห้อง/แผนก
 *  ทะเบียน (ยอดรวมต่อคนไข้ต่อวัน ของห้อง/แผนกนั้น)
 *    เทียบ HOSxP: ผลรวม opitemrece.sum_price ของ dep_code ที่ผูกกับห้องนั้น ใน visit เดียวกัน
 *  HOSxP ทั้ง visit (ทุก dep_code)
 *    เทียบ REP: ยอดเรียกเก็บของ visit นั้น
 *  ยอดต่างกันไม่เกิน 1 บาทถือว่าตรง (เศษสตางค์)
 * ===================================================================== */
const TOLERANCE = 1;

export const POINT_STATUSES = {
  MATCH:           { label: 'ตรงกันครบ 3 แหล่ง' },
  NO_VISIT:        { label: 'ไม่พบ visit ใน HOSxP' },
  NO_CHARGE:       { label: 'ยังไม่ลงค่าใช้จ่ายของห้องนี้ใน HOSxP' },
  HIS_LESS:        { label: 'HOSxP น้อยกว่าทะเบียน' },
  HIS_MORE:        { label: 'HOSxP มากกว่าทะเบียน' },
  DENIED:          { label: 'ติด C' },
  NOT_IN_REP:      { label: 'ยังไม่พบใน REP' },
  REP_DIFF:        { label: 'REP ไม่ตรงกับ HOSxP' },
  NOT_IN_REGISTRY: { label: 'ไม่อยู่ในทะเบียน' },
};
const ORDER = Object.keys(POINT_STATUSES);
const money = (v) => Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- ห้อง/แผนก ---------- */
let deptCache = null;

/**
 * รายชื่อแผนก (ห้อง) ของ HOSxP พร้อมที่มา
 *  source = hosxp  : อ่านจาก kskdepartment ได้ (เก็บแคช 10 นาที)
 *  source = pulled : อ่านไม่ได้ ใช้รหัสแผนกที่พบในข้อมูลที่ดึงมาแล้ว (ไม่มีชื่อ เก็บแคชสั้น ๆ)
 *  source = none   : อ่านไม่ได้และยังไม่มีข้อมูลที่ดึงมา
 */
export async function departmentsInfo({ refresh = false } = {}) {
  const ttl = deptCache?.source === 'hosxp' ? 10 * 60 * 1000 : 20 * 1000;
  if (!refresh && deptCache && Date.now() - deptCache.at < ttl) return deptCache;
  let info;
  try {
    info = { list: await listDepartments(), source: 'hosxp', error: null };
  } catch (err) {
    const { rows } = await db.query(`SELECT DISTINCT dep_code AS code, NULL AS name FROM his_opd_dep WHERE dep_code <> '-' ORDER BY 1`);
    info = {
      list: rows, source: rows.length ? 'pulled' : 'none',
      error: /permission denied/i.test(err.message) ? 'permission' : 'other', detail: String(err.message).slice(0, 200),
    };
  }
  deptCache = { ...info, at: Date.now() };
  return deptCache;
}

export async function departments() {
  return (await departmentsInfo()).list;
}

/** mine = ผู้ใช้เคยอัปโหลดทะเบียนของห้องนี้ หรือ admin กำหนดให้เป็นผู้รับผิดชอบ */
export async function listPoints(userId = null) {
  const { rows } = await db.query(`
    SELECT p.*, (SELECT string_agg(COALESCE(u.full_name, u.username), ', ' ORDER BY u.username)
                   FROM users u WHERE u.is_active AND u.point_codes ? p.code) AS responsible,
           (SELECT MAX(created_at) FROM point_registry_batches b WHERE b.point_code = p.code) AS last_upload,
           (SELECT MAX(created_at) FROM point_registry_batches b WHERE b.point_code = p.code AND b.uploaded_by = $1) AS my_last_upload,
           COALESCE((SELECT u.point_codes ? p.code FROM users u WHERE u.id = $1), FALSE)
             OR EXISTS (SELECT 1 FROM point_registry_batches b WHERE b.point_code = p.code AND b.uploaded_by = $1) AS mine
    FROM service_points p ORDER BY p.sort_order, p.code`, [userId]);
  return rows;
}

const compact = (t) => String(t || '').toLowerCase().replace(/[\s.,;:()[\]{}_\-/]+/g, '');

/**
 * เดาแผนกจากข้อความ (ชื่อไฟล์ ชื่อชีต หัวรายงาน): ชื่อแผนกใน kskdepartment ที่ปรากฏในข้อความ
 * ถ้าชื่อหนึ่งอยู่ในอีกชื่อที่ตรงด้วย (เช่น ทันตกรรม ใน ทันตกรรมเด็ก) เลือกชื่อที่ยาวกว่า
 */
export async function suggestDepCodes(texts) {
  const hay = compact((texts || []).filter(Boolean).join(' '));
  if (!hay) return [];
  // ชื่อแผนกตัดเลขนำหน้า และลองตัดคำนำหน้าทั่วไปด้วย เช่น "ห้องตรวจทันตกรรม" -> "ทันตกรรม"
  const hits = (await departments())
    .map((d) => {
      const full = compact(String(d.name || '').replace(/^[\d.\-\s]+/, ''));
      const core = full.replace(/^(ห้องตรวจ|ห้อง|แผนก|งาน|คลินิก|หน่วย|ตึก)/, '');
      const key = [full, core].find((k) => k.length >= 3 && hay.includes(k));
      return { code: String(d.code), key };
    })
    .filter((d) => d.key);
  return hits.filter((a) => !hits.some((b) => b !== a && b.key.length > a.key.length && b.key.includes(a.key)))
    .map((h) => h.code);
}

/**
 * หาห้อง/แผนกที่ผูกกับแผนกชุดนี้พอดี ถ้ายังไม่มีสร้างให้ (ผู้ใช้ไม่ต้องตั้งค่าล่วงหน้า)
 * ชื่อห้อง/แผนกตั้งจากชื่อแผนก เปลี่ยนชื่อ/รวมแผนกทีหลังได้ที่หน้าตั้งค่าห้อง/แผนก
 */
export async function ensurePoint(depCodes) {
  const codes = [...new Set((depCodes || []).map((d) => String(d).trim()).filter(Boolean))].sort();
  if (!codes.length) throw new Error('กรุณาเลือกห้อง/แผนก อย่างน้อย 1 แผนก');
  const same = (list) => list.find((p) => {
    const have = [...(p.dep_codes || [])].map(String).sort();
    return have.length === codes.length && have.every((c, i) => c === codes[i]);
  });
  const { rows: all } = await db.query('SELECT * FROM service_points ORDER BY is_active DESC, sort_order, code');
  const found = same(all);
  if (found) return { ...found, created: false };

  const names = new Map((await departments()).map((d) => [String(d.code), d.name]));
  const name = codes.map((c) => names.get(c) || c).join(' + ').slice(0, 100);
  const code = (`D${codes.join('-')}`.length <= 20 ? `D${codes.join('-')}` : `D${createHash('md5').update(codes.join(',')).digest('hex').slice(0, 10)}`)
    .toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const { rows: [{ next }] } = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM service_points');
  try {
    const { rows: [p] } = await db.query(
      `INSERT INTO service_points (code, name, dep_codes, sort_order) VALUES ($1, $2, $3, $4) RETURNING *`,
      [code, name, JSON.stringify(codes), next],
    );
    return { ...p, created: true };
  } catch (err) {
    if (err.code !== '23505') throw err;
    const { rows: [p] } = await db.query('SELECT * FROM service_points WHERE code = $1', [code]);
    return { ...p, created: false };
  }
}

/* ---------- นำเข้าทะเบียน ---------- */
export async function importPointRegistry({ point, fileName, parsed, userId }) {
  // ยอดเงินไม่บังคับ: แถวที่ไม่มียอดเทียบเฉพาะว่ามีค่าใช้จ่ายของห้องนี้ใน HOSxP หรือไม่
  const records = parsed.records;
  const errors = parsed.errors;
  if (!records.length) return { inserted: 0, errors };
  return withTransaction(async (c) => {
    const { rows: [b] } = await c.query(
      `INSERT INTO point_registry_batches (point_code, file_name, date_from, date_to, total_rows, valid_rows, error_rows, errors, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [point, fileName, parsed.dateFrom, parsed.dateTo, parsed.totalRows, records.length, errors.length,
        JSON.stringify(errors.slice(0, 300)), userId],
    );
    const { rowCount: replaced } = await c.query(
      'DELETE FROM point_registry_rows WHERE point_code = $1 AND service_date BETWEEN $2 AND $3 AND batch_id <> $4',
      [point, parsed.dateFrom, parsed.dateTo, b.id],
    );
    const cols = ['batch_id', 'point_code', 'row_number', 'service_date', 'hn', 'hn_key', 'cid', 'patient_name', 'amount'];
    for (let i = 0; i < records.length; i += 500) {
      const params = [];
      const values = records.slice(i, i + 500).map((r) => `(${cols.map((col) => {
        params.push(col === 'batch_id' ? b.id : col === 'point_code' ? point : col === 'amount' ? (r.price ?? null) : r[col] ?? null);
        return `$${params.length}`;
      }).join(',')})`);
      await c.query(`INSERT INTO point_registry_rows (${cols.join(',')}) VALUES ${values.join(',')}`, params);
    }
    return {
      batchId: b.id, inserted: records.length, replaced, errors,
      noAmount: records.filter((r) => r.price === null || r.price === undefined).length,
    };
  });
}

/* ---------- เทียบ ---------- */
async function compareRows(point, { dateFrom, dateTo }) {
  const depCodes = (point.dep_codes || []).map(String);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // ผลจับคู่ HOSxP กับ REP ราย visit (รวมทุกรอบ REP แล้ว)
    await client.query(`CREATE TEMP TABLE ro ON COMMIT DROP AS ${baseCte('claim')} SELECT * FROM r WHERE vn IS NOT NULL`,
      baseParams({ dateFrom, dateTo, fund: null, onlyClaimable: false }));
    await client.query('CREATE INDEX ON ro (vn)');
    // ทะเบียน + visit ที่จับคู่ได้: เลือก visit วันนั้นที่มีค่าใช้จ่ายของห้องนี้มากที่สุด
    await client.query(`
      CREATE TEMP TABLE pr ON COMMIT DROP AS
      SELECT r.*, (
        SELECT v.vn FROM his_opd_visits v
        WHERE v.vstdate = r.service_date
          AND ((r.hn_key IS NOT NULL AND ltrim(v.hn, '0') = r.hn_key) OR (r.cid IS NOT NULL AND v.cid = r.cid))
        ORDER BY COALESCE((SELECT SUM(d.amount) FROM his_opd_dep d WHERE d.vn = v.vn AND d.dep_code = ANY($4::text[])), 0) DESC, v.vn
        LIMIT 1) AS vn
      FROM point_registry_rows r
      WHERE r.point_code = $1 AND r.service_date BETWEEN $2 AND $3`, [point.code, dateFrom, dateTo, depCodes]);

    const { rows } = await client.query(`
      WITH dep AS (
        SELECT vn,
               SUM(amount) FILTER (WHERE dep_code = ANY($3::text[])) AS point_amount,
               SUM(amount) AS vn_total,
               jsonb_agg(jsonb_build_object('dep', dep_code, 'amount', amount) ORDER BY amount DESC) AS breakdown
        FROM his_opd_dep WHERE vstdate BETWEEN $1 AND $2 GROUP BY vn
      ),
      -- แถวทะเบียนของคนไข้คนเดียวกันใน visit เดียวกันรวมยอดกัน (แถวที่ไม่พบ visit แยกกัน)
      prg AS (
        SELECT MIN(id) AS id, MIN(service_date) AS service_date, MAX(hn) AS hn, MAX(cid) AS cid,
               MAX(patient_name) AS patient_name, SUM(amount) AS reg_amount, COUNT(*)::int AS reg_rows, MAX(vn) AS vn
        FROM pr GROUP BY COALESCE(vn, 'row:' || id::text)
      )
      SELECT 'REG' AS src, prg.id AS reg_id, prg.service_date::text AS sdate, COALESCE(v.hn, prg.hn) AS hn,
             COALESCE(v.cid, prg.cid) AS cid, COALESCE(prg.patient_name, v.ptname) AS patient_name,
             prg.reg_amount, prg.reg_rows, prg.vn, dep.point_amount, dep.vn_total, dep.breakdown,
             ro.line_id, ro.claim_amount, ro.compensated, ro.status AS rep_status, ro.error_code, ro.tran_id
      FROM prg
      LEFT JOIN his_opd_visits v ON v.vn = prg.vn
      LEFT JOIN dep ON dep.vn = prg.vn
      LEFT JOIN ro ON ro.vn = prg.vn
      UNION ALL
      -- มีค่าใช้จ่ายของห้องนี้ใน HOSxP แต่ไม่อยู่ในทะเบียน
      SELECT 'HIS', NULL, v.vstdate::text, v.hn, v.cid, v.ptname, NULL, 0, v.vn, dep.point_amount, dep.vn_total, dep.breakdown,
             ro.line_id, ro.claim_amount, ro.compensated, ro.status, ro.error_code, ro.tran_id
      FROM dep
      JOIN his_opd_visits v ON v.vn = dep.vn
      LEFT JOIN ro ON ro.vn = v.vn
      WHERE COALESCE(dep.point_amount, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM pr WHERE pr.vn = v.vn)
      ORDER BY 3, 4`, [dateFrom, dateTo, depCodes]);
    await client.query('COMMIT');
    return annotateErrors(rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function evaluate(r, deptName, pointOfDep) {
  const issues = [];
  let status;
  // รหัสติด C ที่ทำความสะอาดแล้ว เช่น "C438, C301" (ค่าใน REP อาจเป็น 438 / C438 / "-")
  const err = formatCodes(r.error_code);
  const pointAmt = Number(r.point_amount || 0);
  const vnTotal = Number(r.vn_total || 0);
  if (r.src === 'HIS') {
    status = 'NOT_IN_REGISTRY';
    issues.push(`มีค่าใช้จ่ายของห้องนี้ใน HOSxP ${money(pointAmt)} บาท แต่ไม่อยู่ในทะเบียน`);
  } else if (!r.vn) {
    status = 'NO_VISIT';
    issues.push('ไม่พบ visit ใน HOSxP วันที่นี้ (ตรวจ HN และวันที่ในทะเบียน)');
  } else if (r.reg_amount === null || r.reg_amount === undefined) {
    // ทะเบียนไม่มียอดเงิน: เทียบเฉพาะว่าห้องนี้มีค่าใช้จ่ายใน HOSxP หรือไม่
    if (pointAmt <= 0) {
      status = 'NO_CHARGE';
      issues.push('ทะเบียนมีคนไข้รายนี้ แต่ HOSxP ไม่มีค่าใช้จ่ายของห้องนี้ใน visit นั้น (ยังไม่ได้ลงค่าใช้จ่าย หรือลงผิดห้อง)');
    }
  } else {
    const diff = pointAmt - Number(r.reg_amount);
    if (diff < -TOLERANCE) {
      status = 'HIS_LESS';
      issues.push(pointAmt ? `HOSxP น้อยกว่าทะเบียน ${money(-diff)} บาท (ลงค่าใช้จ่ายไม่ครบ?)` : 'ไม่มีค่าใช้จ่ายของห้องนี้ใน HOSxP (ยังไม่ได้ลงค่าใช้จ่าย หรือลงผิดห้อง)');
    } else if (diff > TOLERANCE) {
      status = 'HIS_MORE';
      issues.push(`HOSxP มากกว่าทะเบียน ${money(diff)} บาท`);
    }
  }
  // ระดับ visit: HOSxP ทั้ง visit เทียบ REP
  if (r.vn) {
    let repStatus = null;
    if (r.rep_status === 'DENIED' || err) {
      repStatus = 'DENIED';
      issues.push(`ติด ${err || 'C'}${r.error_detail ? `: ${r.error_detail.split('\n')[0].replace(/^\w+: /, '')}` : ''}`);
    } else if (!r.line_id) {
      repStatus = 'NOT_IN_REP';
      issues.push('ยังไม่พบใน REP');
    } else if (Math.abs(Number(r.claim_amount || 0) - vnTotal) > TOLERANCE) {
      repStatus = 'REP_DIFF';
      issues.push(`ทั้ง visit: HOSxP ${money(vnTotal)} แต่ REP เรียกเก็บ ${money(r.claim_amount || 0)}`);
    }
    if (!status) status = repStatus || 'MATCH';
  }
  if (r.reg_rows > 1) issues.push(`ทะเบียนมี ${r.reg_rows} แถวของ visit นี้${r.reg_amount === null || r.reg_amount === undefined ? '' : ' (รวมยอดแล้ว)'}`);
  return {
    ...r,
    error_code: err,
    status,
    issues: status === 'MATCH' ? ['ตรงกันครบ'] : issues,
    breakdown: (r.breakdown || []).map((b) => ({ ...b, name: deptName(b.dep), point: pointOfDep(b.dep) })),
  };
}

const COMPARE_SORT = {
  sdate: (r) => r.sdate, hn: (r) => r.hn, registry: (r) => (r.src === 'REG' ? Number(r.reg_amount) : null),
  his: (r) => Number(r.point_amount || 0), total: (r) => Number(r.vn_total || 0), rep: (r) => (r.line_id ? Number(r.claim_amount) : null),
  paid: (r) => (r.line_id ? Number(r.compensated) : null), status: (r) => ORDER.indexOf(r.status),
};

async function evaluated(point, range) {
  const [rows, depts, points] = await Promise.all([compareRows(point, range), departments(), listPoints()]);
  const names = new Map(depts.map((d) => [String(d.code), d.name]));
  const owner = new Map();
  points.forEach((p) => (p.dep_codes || []).forEach((d) => owner.set(String(d), p.name)));
  return rows.map((r) => evaluate(r, (d) => names.get(String(d)) || null, (d) => owner.get(String(d)) || null));
}

export async function comparePoint({ point, dateFrom, dateTo, status, search, page = 1, pageSize = 50, sort, dir }) {
  const all = await evaluated(point, { dateFrom, dateTo });
  const summary = Object.fromEntries(ORDER.map((k) => [k, 0]));
  all.forEach((r) => { summary[r.status] += 1; });
  const reg = all.filter((r) => r.src === 'REG');
  const visits = new Map(all.filter((r) => r.vn).map((r) => [r.vn, r]));
  const totals = {
    registry: reg.reduce((a, r) => a + Number(r.reg_amount || 0), 0),
    registryNoAmount: reg.filter((r) => r.reg_amount === null || r.reg_amount === undefined).length,
    registryCount: reg.length,
    hisPoint: all.reduce((a, r) => a + Number(r.point_amount || 0), 0),
    hisVisit: [...visits.values()].reduce((a, r) => a + Number(r.vn_total || 0), 0),
    repClaim: [...visits.values()].reduce((a, r) => a + Number(r.line_id ? r.claim_amount || 0 : 0), 0),
    repPaid: [...visits.values()].reduce((a, r) => a + Number(r.line_id ? r.compensated || 0 : 0), 0),
  };
  const q = search?.trim().toLowerCase();
  const filtered = sortRows(all.filter((r) => (!status || r.status === status)
    && (!q || [r.hn, r.cid, r.vn, r.patient_name].some((v) => v && String(v).toLowerCase().includes(q)))), COMPARE_SORT, { sort, dir });
  const size = Math.min(Math.max(Number(pageSize) || 50, 10), 500);
  const p = Math.max(Number(page) || 1, 1);
  const { rows: [st] } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM point_registry_rows WHERE point_code = $1 AND service_date BETWEEN $2 AND $3) AS reg_rows,
            (SELECT MAX(created_at) FROM point_registry_batches WHERE point_code = $1) AS uploaded_at,
            (SELECT MAX(created_at) FROM his_pull_logs WHERE claim_type = 'OPD') AS pulled_at`, [point.code, dateFrom, dateTo],
  );
  return {
    point, summary, statuses: POINT_STATUSES, totals, total: filtered.length, page: p, pageSize: size,
    rows: filtered.slice((p - 1) * size, p * size),
    registryRows: st.reg_rows,
    stale: !!(st.uploaded_at && st.pulled_at && st.uploaded_at > st.pulled_at),
    noDepCodes: !(point.dep_codes || []).length,
  };
}

export async function exportPoint(opts) {
  const all = sortRows((await evaluated(opts.point, opts)).filter((r) => !opts.status || r.status === opts.status), COMPARE_SORT, opts);
  const data = all.map((r) => ({
    'ผลการเทียบ': POINT_STATUSES[r.status].label,
    'จุดที่ต่าง': r.issues.join(' / '),
    'วันที่รับบริการ': r.sdate,
    'HN': r.hn,
    'เลขบัตรประชาชน': r.cid,
    'ชื่อ-สกุล': r.patient_name,
    'VN': r.vn,
    [`ทะเบียน ${opts.point.name}`]: r.src === 'REG' && r.reg_amount !== null && r.reg_amount !== undefined ? Number(r.reg_amount) : null,
    [`HOSxP ${opts.point.name}`]: r.vn ? Number(r.point_amount || 0) : null,
    'HOSxP ทั้ง visit': r.vn ? Number(r.vn_total || 0) : null,
    'แยกตามห้อง/แผนกที่บันทึก (HOSxP)': (r.breakdown || []).map((b) => `${b.name || `แผนก ${b.dep}`}: ${money(b.amount)}`).join(', '),
    'เรียกเก็บ (REP)': r.line_id ? Number(r.claim_amount || 0) : null,
    'ได้รับ (REP)': r.line_id ? Number(r.compensated || 0) : null,
    'REP: TRAN_ID': r.tran_id,
    'รหัสข้อผิดพลาด': r.error_code,
    'ผลการแก้ไข / หมายเหตุ': '',
  }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ 'ผลการเทียบ': 'ไม่มีข้อมูล' }]);
  ws['!cols'] = [22, 50, 12, 11, 15, 22, 14, 14, 14, 14, 45, 14, 14, 14, 12, 28].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `ห้อง-แผนก ${opts.point.code}`.slice(0, 31));
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: data.length };
}

export function pointTemplate(point = null) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['วันที่รับบริการ', 'HN', 'เลขบัตรประชาชน', 'ชื่อ-สกุล', 'ยอดรวม (บาท)'],
    ['15/09/2569', '0001234', '', 'ตัวอย่าง (ลบแถวนี้)', 500],
  ]);
  ws['!cols'] = [14, 10, 16, 26, 14].map((w) => ({ wch: w }));
  ['B', 'C'].forEach((col) => {
    for (let r = 2; r <= 2001; r += 1) {
      const a = `${col}${r}`;
      if (ws[a]) { ws[a].t = 's'; ws[a].v = String(ws[a].v); ws[a].z = '@'; } else ws[a] = { t: 's', v: '', z: '@' };
    }
  });
  ws['!ref'] = 'A1:E2001';
  XLSX.utils.book_append_sheet(wb, ws, 'ทะเบียน');
  const help = XLSX.utils.aoa_to_sheet([
    [`ทะเบียน${point ? ` ${point.name}` : 'ห้อง/แผนก'}: หนึ่งแถว = คนไข้ 1 คน ใน 1 วัน`],
    ['ตอนอัปโหลด เลือกห้อง/แผนก ในหน้าต่างอัปโหลด ไม่ต้องใส่ในไฟล์ ถ้าตั้งชื่อไฟล์หรือชื่อชีตเป็นชื่อแผนก เช่น "ทะเบียนทันตกรรม" ระบบเลือกให้เอง'],
    ['ยอดรวม: ค่าใช้จ่ายทั้งหมดของห้อง/แผนกนี้ที่คนไข้ได้รับในวันนั้น (บาท) ใส่หรือไม่ก็ได้ ถ้าไม่ใส่ ระบบเทียบเฉพาะว่าคนไข้มีค่าใช้จ่ายของห้องนี้ใน HOSxP หรือไม่ (ไม่เทียบยอดเงิน) ถ้าลงหลายแถวต่อคนต่อวัน ระบบรวมยอดให้'],
    ['วันที่รับบริการ: วัน/เดือน/ปี พ.ศ. เช่น 15/09/2569'],
    ['HN ไม่ครบ 9 หลัก ระบบเติม 0 ด้านหน้าให้เอง เลขบัตรประชาชนใส่หรือไม่ก็ได้ (ช่วยจับคู่เมื่อ HN ผิด)'],
    ['ถ้าคนไข้ไปหลายห้องใน visit เดียว แต่ละห้องลงทะเบียนของตัวเองตามปกติ ระบบเทียบกับ HOSxP แยกตามห้อง/แผนกที่บันทึก (dep_code) ให้'],
  ]);
  help['!cols'] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, help, 'วิธีกรอก');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* =====================================================================
 * ใช้ในหน้าเทียบ 3 แหล่งแบบรวม: ทะเบียนทุกห้อง/แผนกพร้อมกัน (ไม่ต้องเลือกห้อง)
 *  REG  แถวทะเบียน (รวมยอดของคนไข้คนเดียวกันใน visit เดียวกัน) + ยอดของห้องนั้นใน HOSxP
 *  HIS  มีค่าใช้จ่ายของห้องนั้นใน HOSxP แต่ไม่อยู่ในทะเบียน
 *       (นับเฉพาะวันที่ทะเบียนของห้องนั้นครอบคลุม ห้องที่ไม่ได้ส่งทะเบียนไม่ถือว่าขาด)
 * ผลเทียบเฉพาะทะเบียนกับ HOSxP ส่วน REP เทียบระดับ visit ที่ threeWayService
 * ===================================================================== */
export async function pointEntries({ dateFrom, dateTo }) {
  const { rows } = await db.query(`
    WITH pr AS (
      SELECT r.*, (
        SELECT v.vn FROM his_opd_visits v
        WHERE v.vstdate = r.service_date
          AND ((r.hn_key IS NOT NULL AND ltrim(v.hn, '0') = r.hn_key) OR (r.cid IS NOT NULL AND v.cid = r.cid))
        ORDER BY COALESCE((SELECT SUM(d.amount) FROM his_opd_dep d WHERE d.vn = v.vn AND p.dep_codes ? d.dep_code), 0) DESC, v.vn
        LIMIT 1) AS vn
      FROM point_registry_rows r JOIN service_points p ON p.code = r.point_code AND p.is_active
      WHERE r.service_date BETWEEN $1 AND $2
    ),
    pd AS (
      SELECT d.vn, p.code, SUM(d.amount) AS amount, SUM(d.optional_amount) AS optional_amount,
             SUM(d.optional_drug_amount) AS optional_drug_amount
      FROM his_opd_dep d JOIN service_points p ON p.is_active AND p.dep_codes ? d.dep_code
      WHERE d.vstdate BETWEEN $1 AND $2 GROUP BY d.vn, p.code
    ),
    prg AS (
      SELECT point_code, MIN(id) AS id, MIN(service_date) AS service_date, MAX(hn) AS hn, MAX(cid) AS cid,
             MAX(patient_name) AS patient_name, SUM(amount) AS reg_amount, COUNT(*)::int AS reg_rows, MAX(vn) AS vn
      FROM pr GROUP BY point_code, COALESCE(vn, 'row:' || id::text)
    ),
    cov AS (
      SELECT DISTINCT b.point_code, b.date_from, b.date_to FROM point_registry_batches b
      WHERE b.date_to >= $1 AND b.date_from <= $2
        AND EXISTS (SELECT 1 FROM point_registry_rows x WHERE x.batch_id = b.id)
    )
    SELECT 'REG' AS src, prg.point_code AS code, prg.id AS reg_id, prg.service_date::text AS sdate, prg.hn, prg.cid,
           prg.patient_name, prg.reg_amount, prg.reg_rows, prg.vn, COALESCE(pd.amount, 0) AS point_amount,
           COALESCE(pd.optional_amount, 0) AS optional_amount, COALESCE(pd.optional_drug_amount, 0) AS optional_drug_amount
    FROM prg LEFT JOIN pd ON pd.vn = prg.vn AND pd.code = prg.point_code
    UNION ALL
    SELECT 'HIS', pd.code, NULL, v.vstdate::text, v.hn, v.cid, v.ptname, NULL, 0, v.vn, pd.amount, pd.optional_amount, pd.optional_drug_amount
    FROM pd JOIN his_opd_visits v ON v.vn = pd.vn
    WHERE pd.amount - pd.optional_amount > 0
      AND NOT EXISTS (SELECT 1 FROM pr WHERE pr.vn = pd.vn AND pr.point_code = pd.code)
      AND EXISTS (SELECT 1 FROM cov WHERE cov.point_code = pd.code AND v.vstdate BETWEEN cov.date_from AND cov.date_to)`,
  [dateFrom, dateTo]);

  return rows.map((r) => {
    const amt = Number(r.point_amount || 0);
    const opt = Number(r.optional_amount || 0);     // ค่าบริการที่ติดอัตโนมัติ ทะเบียนจะรวมหรือไม่รวมก็ได้
    const core = amt - opt;
    // ข้อความแยก ค่าบริการอัตโนมัติ / ยา เช่น "ค่าบริการอัตโนมัติ 50.00 + ยา 70.00 บาท"
    const drug = Math.min(Number(r.optional_drug_amount || 0), opt);
    const optText = [opt - drug > 0 && `ค่าบริการอัตโนมัติ ${money(opt - drug)}`, drug > 0 && `ยา ${money(drug)}`].filter(Boolean).join(' + ');
    const noAmt = r.reg_amount === null || r.reg_amount === undefined;
    let status = 'MATCH';
    let issue = null;
    let note = null;
    if (r.src === 'HIS') {
      status = 'NOT_IN_REGISTRY'; issue = `มีค่าใช้จ่ายใน HOSxP ${money(amt)} บาท แต่ไม่อยู่ในทะเบียน`;
    } else if (!r.vn) {
      status = 'NO_VISIT'; issue = 'ไม่พบ visit ใน HOSxP วันที่นี้ (ตรวจ HN และวันที่ในทะเบียน)';
    } else if (noAmt) {
      if (core <= 0) { status = 'HIS_DIFF'; issue = 'อยู่ในทะเบียน แต่ HOSxP ไม่มีค่าใช้จ่ายของห้องนี้ (ยังไม่ลง หรือลงผิดห้อง)'; }
    } else {
      const reg = Number(r.reg_amount);
      if (Math.abs(amt - reg) <= TOLERANCE) {
        if (opt > 0) note = `ทะเบียนรวม${optText} บาทแล้ว`;
      } else if (opt > 0 && Math.abs(core - reg) <= TOLERANCE) {
        note = `ทะเบียนไม่รวม${optText} บาท (ถือว่าตรง)`;
      } else {
        status = 'HIS_DIFF';
        // เทียบกับแบบที่ใกล้ที่สุด (รวม / ไม่รวมค่าบริการอัตโนมัติ)
        const base = opt > 0 && Math.abs(core - reg) < Math.abs(amt - reg) ? core : amt;
        const diff = base - reg;
        const how = base === core ? ` (ไม่นับ${optText})` : '';
        if (!amt) issue = 'HOSxP ไม่มีค่าใช้จ่ายของห้องนี้ (ยังไม่ลง หรือลงผิดห้อง)';
        else if (diff < 0) issue = `HOSxP น้อยกว่าทะเบียน ${money(-diff)} บาท${how} (ลงค่าใช้จ่ายไม่ครบ?)`;
        else issue = `HOSxP มากกว่าทะเบียน ${money(diff)} บาท${how}`;
      }
    }
    const issues = issue ? [issue] : [];
    if (r.reg_rows > 1) issues.push(`ทะเบียนมี ${r.reg_rows} แถวของ visit นี้${noAmt ? '' : ' (รวมยอดแล้ว)'}`);
    return { ...r, kind: 'point', status, issues, note, his_amount: r.vn ? amt : null, optional_amount: r.vn ? opt : null, optional_drug_amount: r.vn ? drug : null };
  });
}
