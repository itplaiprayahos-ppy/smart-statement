import * as XLSX from 'xlsx';
import { db } from '../config/db.js';

/**
 * สถานะผลการเปรียบเทียบ
 *  MATCHED      ตรงกัน
 *  AMOUNT_DIFF  พบทั้งสองฝั่ง แต่ยอดต่างกัน
 *  DENIED       สปสช. ปฏิเสธ / ติด C (มีรหัสข้อผิดพลาด)
 *  MULTIPLE     มาหลายครั้งในวันเดียว ระบบจับคู่ตามลำดับยอดเงินให้ แต่ควรตรวจด้วยคน
 *  NOT_IN_STM   มีใน HOSxP แต่ไม่พบใน Statement
 *  NOT_IN_HIS   มีใน Statement แต่ไม่พบใน HOSxP
 */
export const STATUSES = ['MATCHED', 'AMOUNT_DIFF', 'DENIED', 'MULTIPLE', 'NOT_IN_STM', 'NOT_IN_HIS'];

// whitelist คอลัมน์ฝั่ง สปสช. ที่ใช้เทียบกับ uc_money ของ HOSxP (ห้ามรับชื่อคอลัมน์จากผู้ใช้ตรง ๆ)
const COMPARE_COLUMNS = { claim: 'j.claim_amount', compensated: 'j.compensated' };

export function baseCte(compare) {
  const cmp = COMPARE_COLUMNS[compare] || COMPARE_COLUMNS.claim;
  return `
  -- ผู้ป่วยมาหลายครั้งในวันเดียว: จับคู่แบบ 1:1 ตามลำดับยอดเงิน (rk) แล้วแจ้งให้ตรวจสอบ
  WITH h AS (
    SELECT v.*,
           ROW_NUMBER() OVER (PARTITION BY cid, vstdate ORDER BY uc_money, vn) AS rk,
           COUNT(*)     OVER (PARTITION BY cid, vstdate) AS grp_n
    FROM his_opd_visits v WHERE vstdate BETWEEN $1 AND $2
  ),
  n AS (
    SELECT l.*,
           ROW_NUMBER() OVER (PARTITION BY pid, service_date ORDER BY claim_amount, id) AS rk,
           COUNT(*)     OVER (PARTITION BY pid, service_date) AS grp_n
    FROM nhso_lines l WHERE claim_type = 'OPD' AND service_date BETWEEN $1 AND $2
  ),
  j AS (
    SELECT h.vn, h.hn, h.cid, h.vstdate, h.pttype, h.pttype_name, h.hipdata_code, h.pdx,
           h.income, h.uc_money,
           n.id AS line_id, n.rep_no, n.tran_id, n.hn AS nhso_hn, n.pid,
           COALESCE(n.patient_name, h.ptname) AS patient_name,
           n.service_date, n.fund, n.claim_amount, n.compensated, n.error_code,
           GREATEST(COALESCE(h.grp_n, 0), COALESCE(n.grp_n, 0)) AS grp_n
    FROM h
    FULL OUTER JOIN n ON n.pid = h.cid AND n.service_date = h.vstdate AND n.rk = h.rk
  ),
  r AS (
    SELECT j.*,
           COALESCE(j.vstdate, j.service_date) AS sdate,
           CASE WHEN j.vn IS NOT NULL AND j.line_id IS NOT NULL
                THEN ROUND(COALESCE(${cmp}, 0) - COALESCE(j.uc_money, 0), 2) END AS diff,
           CASE
             WHEN j.line_id IS NULL THEN 'NOT_IN_STM'
             WHEN j.vn IS NULL THEN 'NOT_IN_HIS'
             WHEN NULLIF(TRIM(j.error_code), '') IS NOT NULL AND TRIM(j.error_code) NOT IN ('-', '0')
               THEN 'DENIED'
             WHEN j.grp_n > 1 THEN 'MULTIPLE'
             WHEN ABS(COALESCE(${cmp}, 0) - COALESCE(j.uc_money, 0)) >= 0.01 THEN 'AMOUNT_DIFF'
             ELSE 'MATCHED'
           END AS status
    FROM j
    WHERE ($3::text IS NULL OR j.vn IS NULL OR j.hipdata_code = $3)
      AND (NOT $4::boolean OR j.vn IS NULL OR j.line_id IS NOT NULL OR COALESCE(j.uc_money, 0) > 0)
  )`;
}

function filterSql(firstParam) {
  const s = `$${firstParam}`;
  const q = `$${firstParam + 1}`;
  return `
    WHERE (${s}::text IS NULL OR r.status = ${s})
      AND (${q}::text IS NULL
           OR r.hn = ${q} OR r.nhso_hn = ${q} OR r.vn = ${q}
           OR r.cid LIKE ${q} || '%' OR r.pid LIKE ${q} || '%'
           OR r.tran_id = ${q} OR r.rep_no = ${q}
           OR r.patient_name ILIKE '%' || ${q} || '%')`;
}

export function baseParams(o) {
  return [o.dateFrom, o.dateTo, o.fund || null, o.onlyClaimable !== false];
}

export async function reconcileOpd(opts) {
  const cte = baseCte(opts.compare);
  const params = baseParams(opts);

  const summarySql = `${cte}
    SELECT status, COUNT(*)::int AS count,
           COALESCE(SUM(uc_money), 0)     AS his_amount,
           COALESCE(SUM(claim_amount), 0) AS claim_amount,
           COALESCE(SUM(compensated), 0)  AS compensated
    FROM r GROUP BY status`;

  const listParams = [...params, opts.status || null, opts.search?.trim() || null];
  const where = filterSql(5);
  const countSql = `${cte} SELECT COUNT(*)::int AS total FROM r ${where}`;
  const rowsSql = `${cte}
    SELECT vn, hn, cid, vstdate, pttype, pttype_name, hipdata_code, pdx, income, uc_money,
           line_id, rep_no, tran_id, nhso_hn, pid, patient_name, service_date, fund,
           claim_amount, compensated, error_code, sdate, diff, status
    FROM r ${where}
    ORDER BY sdate, COALESCE(hn, nhso_hn), vn NULLS LAST
    LIMIT $7 OFFSET $8`;

  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 10), 500);
  const page = Math.max(Number(opts.page) || 1, 1);

  const [summary, count, rows] = await Promise.all([
    db.query(summarySql, params),
    db.query(countSql, listParams),
    db.query(rowsSql, [...listParams, pageSize, (page - 1) * pageSize]),
  ]);

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, {
    count: 0, his_amount: 0, claim_amount: 0, compensated: 0,
  }]));
  summary.rows.forEach((r) => { byStatus[r.status] = r; });

  return {
    summary: byStatus,
    total: count.rows[0].total,
    page,
    pageSize,
    rows: rows.rows,
  };
}

const STATUS_TH = {
  MATCHED: 'ตรงกัน',
  AMOUNT_DIFF: 'ยอดต่าง',
  DENIED: 'ถูกปฏิเสธ/ติด C',
  MULTIPLE: 'หลายครั้งในวันเดียว (ควรตรวจสอบ)',
  NOT_IN_STM: 'ไม่พบใน Statement',
  NOT_IN_HIS: 'ไม่พบใน HOSxP',
};

// 1 ปีงบประมาณของรพ.ขนาดกลางอาจมีหลายแสน visit ถ้าเกินนี้ให้กรองตามสถานะก่อนส่งออก
const EXPORT_LIMIT = 300_000;

/** ส่งออกผลการเปรียบเทียบเป็นไฟล์ Excel */
export async function exportOpd(opts) {
  const cte = baseCte(opts.compare);
  const { rows } = await db.query(
    `${cte} SELECT * FROM r ${filterSql(5)}
     ORDER BY sdate, COALESCE(hn, nhso_hn), vn NULLS LAST LIMIT ${EXPORT_LIMIT}`,
    [...baseParams(opts), opts.status || null, opts.search?.trim() || null],
  );

  const data = rows.map((r) => ({
    'สถานะ': STATUS_TH[r.status],
    'วันที่รับบริการ': r.sdate,
    'VN': r.vn,
    'HN (HOSxP)': r.hn,
    'HN (สปสช.)': r.nhso_hn,
    'เลขบัตรประชาชน': r.cid || r.pid,
    'ชื่อ-สกุล': r.patient_name,
    'สิทธิ (HOSxP)': r.pttype_name,
    'กองทุน': r.hipdata_code,
    'PDX': r.pdx,
    'ยอดเรียกเก็บ (HOSxP)': r.uc_money,
    'REP No.': r.rep_no,
    'TRAN_ID': r.tran_id,
    'ยอดเรียกเก็บ (สปสช.)': r.claim_amount,
    'ยอดชดเชย': r.compensated,
    'ผลต่าง': r.diff,
    'รหัสข้อผิดพลาด': r.error_code,
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = Object.keys(data[0] || { a: 1 }).map((k) => ({ wch: Math.max(12, k.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'OPD');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length };
}
