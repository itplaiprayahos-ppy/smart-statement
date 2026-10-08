import * as XLSX from 'xlsx';
import { db } from '../config/db.js';
import { annotateErrors } from './errorCodeService.js';
import { orderBy } from '../utils/sort.js';

/** คอลัมน์ที่กดเรียงได้ในหน้ากระทบยอด OPD */
const OPD_SORT = {
  status: 'status', sdate: 'sdate', hn: 'COALESCE(hn, nhso_hn)', patient: 'patient_name', pttype: 'pttype_name',
  his: 'uc_money', claim: 'claim_amount', diff: 'diff', comp: 'compensated', rep: 'rep_no', error: 'error_code',
};
const OPD_FALLBACK = 'sdate, COALESCE(hn, nhso_hn), vn NULLS LAST';

/**
 * สถานะผลการเปรียบเทียบ
 *  MATCHED      ตรงกัน
 *  AMOUNT_DIFF  พบทั้งสองฝั่ง แต่ยอดต่างกัน
 *  DENIED       สปสช. ปฏิเสธ / ติด C (มีรหัสข้อผิดพลาด)
 *  MULTIPLE     มาหลายครั้งในวันเดียว ระบบจับคู่ตามลำดับยอดเงินให้ แต่ควรตรวจด้วยคน
 *  NOT_IN_STM   มีใน HOSxP แต่ไม่พบใน REP
 *  NOT_IN_HIS   มีใน REP แต่ไม่พบใน HOSxP
 */
export const STATUSES = ['MATCHED', 'AMOUNT_DIFF', 'DENIED', 'MULTIPLE', 'NOT_IN_STM', 'NOT_IN_HIS'];

// whitelist คอลัมน์ฝั่ง สปสช. ที่ใช้เทียบกับ uc_money ของ HOSxP (ห้ามรับชื่อคอลัมน์จากผู้ใช้ตรง ๆ)
const COMPARE_COLUMNS = { claim: 'j.claim_amount', compensated: 'j.compensated' };

export function baseCte(compare) {
  const cmp = COMPARE_COLUMNS[compare] || COMPARE_COLUMNS.claim;
  return `
  -- คีย์จับคู่ของ visit: เลขบัตรประชาชน ถ้าไม่มี/ไม่ครบ 13 หลัก ใช้ HN (ตัด 0 หน้า) แทน
  WITH hv AS MATERIALIZED (
    SELECT v.*,
           CASE WHEN v.cid ~ '^[0-9]{13}$' THEN v.cid ELSE 'HN:' || ltrim(v.hn, '0') END AS mkey
    FROM his_opd_visits v WHERE v.vstdate BETWEEN $1 AND $2
  ),
  hcount AS (SELECT mkey, vstdate, COUNT(*)::int AS c FROM hv GROUP BY mkey, vstdate),
  -- ผู้ป่วยมาหลายครั้งในวันเดียว: จับคู่แบบ 1:1 ตามลำดับยอดเงิน (rk) แล้วแจ้งให้ตรวจสอบ
  h AS (
    SELECT hv.*,
           ROW_NUMBER() OVER (PARTITION BY mkey, vstdate ORDER BY uc_money, vn) AS rk,
           COUNT(*)     OVER (PARTITION BY mkey, vstdate) AS grp_n
    FROM hv
  ),
  -- รายการจาก REP: หาคีย์ที่ตรงกับ HOSxP (เลขบัตรก่อน แล้วค่อย HN)
  nl AS (
    SELECT l.*,
           CASE WHEN c1.c IS NOT NULL THEN l.pid WHEN c2.c IS NOT NULL THEN c2.mkey ELSE l.pid END AS mkey,
           COALESCE(c1.c, c2.c, 0) AS his_n
    FROM nhso_lines l
    LEFT JOIN hcount c1 ON c1.mkey = l.pid AND c1.vstdate = l.service_date
    LEFT JOIN hcount c2 ON c2.mkey = 'HN:' || ltrim(l.hn, '0') AND c2.vstdate = l.service_date
    WHERE l.claim_type = 'OPD' AND l.service_date BETWEEN $1 AND $2
  ),
  -- รวมรายการหลายเลขที่ REP เป็นรายการเบิกเดียว
  --   คนไข้มี visit เดียวในวันนั้น -> รวมทุกรายการของวันนั้น (รวมกรณีส่งใหม่ได้ TRAN_ID ใหม่)
  --   มีหลาย visit หรือไม่พบใน HOSxP -> รวมเฉพาะ TRAN_ID เดียวกันข้ามรอบ
  nk AS (
    SELECT nl.*,
           CASE WHEN his_n = 1 THEN 'V:' || mkey || ':' || service_date
                ELSE 'T:' || COALESCE(tran_id, id::text) END AS gk
    FROM nl
  ),
  fa AS (
    SELECT s.gk, jsonb_object_agg(s.key, s.total) AS fund_amounts
    FROM (SELECT nk.gk, e.key, SUM(e.value::numeric) AS total
          FROM nk CROSS JOIN LATERAL jsonb_each_text(nk.fund_amounts) AS e
          GROUP BY nk.gk, e.key) s
    GROUP BY s.gk
  ),
  ng AS (
    SELECT nk.gk, MIN(nk.id) AS id, MAX(nk.mkey) AS mkey, MAX(nk.pid) AS pid,
           MAX(nk.service_date) AS service_date, MAX(nk.hn) AS hn,
           MAX(nk.patient_name) AS patient_name, MAX(nk.fund) AS fund,
           string_agg(DISTINCT nk.rep_no, ', ') AS rep_no,
           string_agg(DISTINCT nk.tran_id, ', ') AS tran_id,
           string_agg(DISTINCT nk.stm_doc, ', ') AS stm_docs,
           COUNT(*)::int AS line_count,
           MAX(nk.claim_amount) AS claim_amount,          -- ส่งซ้ำไม่นับยอดเรียกเก็บซ้ำ
           SUM(nk.compensated) AS compensated,             -- ยอดชดเชยและยอดปรับปรุงทุกรอบรวมกัน
           -- รหัสข้อผิดพลาดใช้ของรอบล่าสุด (ถ้ารอบหลังผ่านแล้ว ไม่ถือว่าถูกปฏิเสธ)
           (array_agg(nk.error_code ORDER BY nk.stm_period DESC NULLS LAST, nk.id DESC))[1] AS error_code
    FROM nk GROUP BY nk.gk
  ),
  n AS (
    SELECT ng.*, COALESCE(fa.fund_amounts, '{}'::jsonb) AS fund_amounts,
           ROW_NUMBER() OVER (PARTITION BY ng.mkey, ng.service_date ORDER BY ng.claim_amount, ng.id) AS rk,
           COUNT(*)     OVER (PARTITION BY ng.mkey, ng.service_date) AS grp_n
    FROM ng LEFT JOIN fa ON fa.gk = ng.gk
  ),
  j AS (
    SELECT h.vn, h.hn, h.cid, h.vstdate, h.pttype, h.pttype_name, h.hipdata_code, h.pdx,
           h.income, h.uc_money,
           n.id AS line_id, n.rep_no, n.tran_id, n.hn AS nhso_hn, n.pid,
           COALESCE(n.patient_name, h.ptname) AS patient_name,
           n.service_date, n.fund, n.claim_amount, n.compensated, n.error_code,
           n.fund_amounts, n.stm_docs, n.line_count,
           GREATEST(COALESCE(h.grp_n, 0), COALESCE(n.grp_n, 0)) AS grp_n
    FROM h
    FULL OUTER JOIN n ON n.mkey = h.mkey AND n.service_date = h.vstdate AND n.rk = h.rk
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
           OR r.tran_id LIKE '%' || ${q} || '%' OR r.rep_no LIKE '%' || ${q} || '%'
           OR r.patient_name ILIKE '%' || ${q} || '%')`;
}

export function baseParams(o) {
  return [o.dateFrom, o.dateTo, o.fund || null, o.onlyClaimable !== false];
}

/** คำนวณผลจับคู่ครั้งเดียวลงตารางชั่วคราว ro แล้วให้ทุกคำสั่งอ่านจากตารางนี้ */
async function withReconTable(opts, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE ro ON COMMIT DROP AS ${baseCte(opts.compare)} SELECT * FROM r`, baseParams(opts));
    await client.query('ANALYZE ro');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function reconcileOpd(opts) {
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 10), 500);
  const page = Math.max(Number(opts.page) || 1, 1);
  const fp = [opts.status || null, opts.search?.trim() || null];

  return withReconTable(opts, async (c) => {
    const summary = await c.query(`
      SELECT status, COUNT(*)::int AS count,
             COALESCE(SUM(uc_money), 0)     AS his_amount,
             COALESCE(SUM(claim_amount), 0) AS claim_amount,
             COALESCE(SUM(compensated), 0)  AS compensated
      FROM ro GROUP BY status`);
    const count = await c.query(`SELECT COUNT(*)::int AS total FROM ro r ${filterSql(1)}`, fp);
    const rows = await c.query(`
      SELECT vn, hn, cid, vstdate, pttype, pttype_name, hipdata_code, pdx, income, uc_money,
             line_id, rep_no, tran_id, nhso_hn, pid, patient_name, service_date, fund,
             claim_amount, compensated, error_code, stm_docs, line_count, sdate, diff, status
      FROM ro r ${filterSql(1)}
      ${orderBy(OPD_SORT, opts, OPD_FALLBACK)}
      LIMIT $3 OFFSET $4`, [...fp, pageSize, (page - 1) * pageSize]);

    const byStatus = Object.fromEntries(STATUSES.map((st) => [st, {
      count: 0, his_amount: 0, claim_amount: 0, compensated: 0,
    }]));
    summary.rows.forEach((r) => { byStatus[r.status] = r; });
    return { summary: byStatus, total: count.rows[0].total, page, pageSize, rows: await annotateErrors(rows.rows) };
  });
}

const STATUS_TH = {
  MATCHED: 'ตรงกัน',
  AMOUNT_DIFF: 'ยอดต่าง',
  DENIED: 'ถูกปฏิเสธ/ติด C',
  MULTIPLE: 'หลายครั้งในวันเดียว (ควรตรวจสอบ)',
  NOT_IN_STM: 'ไม่พบใน REP',
  NOT_IN_HIS: 'ไม่พบใน HOSxP',
};

// 1 ปีงบประมาณของรพ.ขนาดกลางอาจมีหลายแสน visit ถ้าเกินนี้ให้กรองตามสถานะก่อนส่งออก
const EXPORT_LIMIT = 300_000;

/** ส่งออกผลการเปรียบเทียบเป็นไฟล์ Excel */
export async function exportOpd(opts) {
  const rows = await withReconTable(opts, async (c) => (await c.query(
    `SELECT * FROM ro r ${filterSql(1)}
     ${orderBy(OPD_SORT, opts, OPD_FALLBACK)} LIMIT ${EXPORT_LIMIT}`,
    [opts.status || null, opts.search?.trim() || null],
  )).rows).then(annotateErrors);

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
    'เลขที่ REP': r.stm_docs,
    'ยอดเรียกเก็บ (สปสช.)': r.claim_amount,
    'ผลต่าง': r.diff,
    'ยอดชดเชย': r.compensated,
    'รหัสข้อผิดพลาด': r.error_code,
    'รายละเอียดข้อผิดพลาด': r.error_detail,
    'แนวทางแก้ไข': r.error_guidance,
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = Object.keys(data[0] || { a: 1 }).map((k) => ({ wch: Math.max(12, k.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'OPD');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length };
}
