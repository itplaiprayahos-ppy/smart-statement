import * as XLSX from 'xlsx';
import { db } from '../config/db.js';
import { baseCte, baseParams } from './reconService.js';

/**
 * สถานะการเบิกรายกองทุน
 *  PAID        เข้าเกณฑ์ ส่งเบิกแล้ว และได้รับเงินกองทุนนี้ (ยอดกองทุนใน Statement > 0)
 *  NOT_PAID    เข้าเกณฑ์ พบใน Statement แต่ไม่ได้รับเงินกองทุนนี้
 *  DENIED      เข้าเกณฑ์ แต่ สปสช. ปฏิเสธ / ติด C
 *  NOT_SENT    เข้าเกณฑ์ แต่ไม่พบใน Statement
 *  EXTRA_PAID  (ตรวจย้อนกลับ) ได้รับเงินกองทุนนี้ แต่ไม่เข้าเกณฑ์ตามการตั้งค่า
 *              เช่น ไม่มีรายการที่ตั้งค่าไว้, สิทธิไม่อยู่ในเงื่อนไข หรือไม่พบ visit ใน HOSxP
 */
export const FUND_STATUSES = ['PAID', 'NOT_PAID', 'DENIED', 'NOT_SENT', 'EXTRA_PAID'];
const ELIGIBLE = "fund_status <> 'EXTRA_PAID'";

/**
 * ต่อจาก CTE ของการกระทบยอด OPD (r)
 *  fv    = visit ที่เข้าเกณฑ์กองทุน: มีรายการที่ตั้งค่าอย่างน้อย 1 รายการ และสิทธิตรงเงื่อนไข (ถ้ากำหนด)
 *  elig  = visit ที่เข้าเกณฑ์ + ผลจับคู่กับ Statement
 *  extra = รายการใน Statement ที่ได้รับเงินกองทุน แต่ visit ไม่เข้าเกณฑ์ (ตรวจย้อนกลับ)
 *  x     = elig + extra
 * พารามิเตอร์ $1-$4 มาจาก baseParams, $5 = รหัสกองทุน (null = ทุกกองทุน)
 */
function fundCte() {
  return `${baseCte('claim')},
  fv AS (
    SELECT i.vn, fi.fund_code,
           SUM(i.sum_price) AS his_fund_amount,
           string_agg(DISTINCT COALESCE(fi.item_name, i.icode), ', ') AS items
    FROM his_opd_items i
    JOIN his_opd_visits v ON v.vn = i.vn
    JOIN fund_items fi ON fi.icode = i.icode
    JOIN funds f ON f.code = fi.fund_code AND f.is_active
    WHERE i.vstdate BETWEEN $1 AND $2
      AND (jsonb_array_length(f.pttypes) = 0 OR f.pttypes ? v.pttype)
      AND ($5::text IS NULL OR fi.fund_code = $5)
    GROUP BY i.vn, fi.fund_code
  ),
  elig AS (
    SELECT fv.fund_code, fv.items, fv.his_fund_amount,
           r.vn, r.hn, r.cid, r.patient_name, r.sdate, r.pttype, r.pttype_name, r.hipdata_code,
           r.line_id, r.rep_no, r.tran_id, r.error_code,
           (n.fund_amounts ->> fv.fund_code)::numeric AS stm_fund_amount,
           CASE
             WHEN r.line_id IS NULL THEN 'NOT_SENT'
             WHEN r.status = 'DENIED' THEN 'DENIED'
             WHEN COALESCE((n.fund_amounts ->> fv.fund_code)::numeric, 0) > 0 THEN 'PAID'
             ELSE 'NOT_PAID'
           END AS fund_status
    FROM fv
    JOIN r ON r.vn = fv.vn
    LEFT JOIN nhso_lines n ON n.id = r.line_id
  ),
  extra AS (
    SELECT kv.key AS fund_code,
           CASE
             WHEN r.vn IS NULL THEN 'ไม่พบ visit ใน HOSxP'
             WHEN EXISTS (SELECT 1 FROM his_opd_items i JOIN fund_items fi ON fi.icode = i.icode
                          WHERE i.vn = r.vn AND fi.fund_code = kv.key)
               THEN 'สิทธิไม่อยู่ในเงื่อนไขกองทุน'
             ELSE 'ไม่มีรายการที่ตั้งค่าไว้'
           END AS items,
           NULL::numeric AS his_fund_amount,
           r.vn, COALESCE(r.hn, r.nhso_hn) AS hn, COALESCE(r.cid, r.pid) AS cid, r.patient_name, r.sdate,
           r.pttype, r.pttype_name, r.hipdata_code,
           r.line_id, r.rep_no, r.tran_id, r.error_code,
           kv.value::numeric AS stm_fund_amount,
           'EXTRA_PAID' AS fund_status
    FROM r
    JOIN nhso_lines n ON n.id = r.line_id
    CROSS JOIN LATERAL jsonb_each_text(n.fund_amounts) AS kv
    JOIN funds f ON f.code = kv.key AND f.is_active
    WHERE kv.value::numeric > 0
      AND ($5::text IS NULL OR kv.key = $5)
      AND NOT EXISTS (SELECT 1 FROM fv WHERE fv.vn = r.vn AND fv.fund_code = kv.key)
  ),
  x AS (SELECT * FROM elig UNION ALL SELECT * FROM extra)`;
}

function filterSql() {
  return `
    WHERE ($6::text IS NULL OR x.fund_status = $6)
      AND ($7::text IS NULL OR x.hn = $7 OR x.vn = $7 OR x.cid LIKE $7 || '%'
           OR x.tran_id = $7 OR x.patient_name ILIKE '%' || $7 || '%')`;
}

function params(o) {
  // ไม่กรอง "เฉพาะ visit ที่มียอดเรียกเก็บ" เพราะ visit ถูกคัดด้วยรายการค่าบริการอยู่แล้ว
  return [...baseParams({ ...o, onlyClaimable: false }), o.fundCode || null, o.fundStatus || null, o.search?.trim() || null];
}

export async function reconcileFunds(opts) {
  const p = params(opts);
  const allFunds = [...p.slice(0, 4), null]; // ตารางสรุปแสดงทุกกองทุนเสมอ
  const cte = fundCte();
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 10), 500);
  const page = Math.max(Number(opts.page) || 1, 1);
  const person = 'COALESCE(cid, hn)';

  const [funds, byStatus, people, monthly, count, rows, lastPull, lastChange] = await Promise.all([
    db.query(`SELECT f.code, f.name, f.pttypes, COUNT(fi.icode)::int AS item_count
              FROM funds f LEFT JOIN fund_items fi ON fi.fund_code = f.code
              WHERE f.is_active GROUP BY f.code ORDER BY f.sort_order, f.code`),
    // จำนวน visit และยอดเงิน แยกกองทุน x สถานะ
    db.query(`${cte}
              SELECT fund_code, fund_status, COUNT(*)::int AS count,
                     COALESCE(SUM(his_fund_amount), 0) AS his_amount,
                     COALESCE(SUM(stm_fund_amount), 0) AS stm_amount
              FROM x GROUP BY fund_code, fund_status`, allFunds),
    // จำนวนคนไข้ (ไม่ซ้ำ) และ visit (ไม่ซ้ำ) ที่เข้าเกณฑ์ ต่อกองทุน และรวมทุกกองทุน (แถว fund_code = null)
    db.query(`${cte}
              SELECT fund_code,
                     COUNT(DISTINCT ${person})::int AS patients,
                     COUNT(DISTINCT vn)::int AS visits
              FROM x WHERE ${ELIGIBLE}
              GROUP BY ROLLUP (fund_code)`, allFunds),
    // สรุปรายเดือน ตามกองทุนที่เลือก (หรือทุกกองทุน)
    db.query(`${cte}
              SELECT to_char(sdate, 'YYYY-MM') AS month,
                     COUNT(DISTINCT ${person}) FILTER (WHERE ${ELIGIBLE})::int AS patients,
                     COUNT(DISTINCT vn) FILTER (WHERE ${ELIGIBLE})::int AS visits,
                     COALESCE(SUM(his_fund_amount) FILTER (WHERE ${ELIGIBLE}), 0) AS his_amount,
                     COALESCE(SUM(stm_fund_amount) FILTER (WHERE ${ELIGIBLE}), 0) AS stm_amount,
                     COUNT(*) FILTER (WHERE fund_status = 'NOT_SENT')::int AS not_sent,
                     COALESCE(SUM(his_fund_amount) FILTER (WHERE fund_status = 'NOT_SENT'), 0) AS not_sent_amount,
                     COUNT(*) FILTER (WHERE fund_status = 'EXTRA_PAID')::int AS extra_paid,
                     COALESCE(SUM(stm_fund_amount) FILTER (WHERE fund_status = 'EXTRA_PAID'), 0) AS extra_paid_amount
              FROM x GROUP BY 1 ORDER BY 1`, p.slice(0, 5)),
    db.query(`${cte} SELECT COUNT(*)::int AS total FROM x ${filterSql()}`, p),
    db.query(`${cte} SELECT * FROM x ${filterSql()}
              ORDER BY sdate, hn, fund_code LIMIT $8 OFFSET $9`, [...p, pageSize, (page - 1) * pageSize]),
    db.query(`SELECT MAX(created_at) AS at FROM his_pull_logs WHERE claim_type = 'OPD'`),
    db.query(`SELECT MAX(created_at) AS at FROM fund_items`),
  ]);

  const totals = people.rows.find((r) => r.fund_code === null) || { patients: 0, visits: 0 };
  return {
    funds: funds.rows,
    summary: byStatus.rows,
    people: people.rows.filter((r) => r.fund_code !== null),
    totals,
    monthly: monthly.rows,
    total: count.rows[0].total,
    page,
    pageSize,
    rows: rows.rows,
    // เพิ่มรายการในกองทุนหลังดึง HOSxP ครั้งล่าสุด -> ต้องดึงใหม่จึงจะเห็น visit ของรายการนั้น
    needsRepull: !!(lastChange.rows[0].at && (!lastPull.rows[0].at || lastChange.rows[0].at > lastPull.rows[0].at)),
  };
}

const STATUS_TH = {
  PAID: 'ได้รับเงิน',
  NOT_PAID: 'ไม่ได้รับเงินกองทุนนี้',
  DENIED: 'ถูกปฏิเสธ/ติด C',
  NOT_SENT: 'ไม่พบใน Statement',
  EXTRA_PAID: 'ได้รับเงินแต่ไม่เข้าเกณฑ์',
};

export async function exportFunds(opts) {
  const { rows } = await db.query(
    `${fundCte()} SELECT x.*, f.name AS fund_name FROM x JOIN funds f ON f.code = x.fund_code
     ${filterSql()} ORDER BY x.fund_code, x.sdate, x.hn LIMIT 300000`,
    params(opts),
  );
  const data = rows.map((r) => ({
    'กองทุน': `${r.fund_code} ${r.fund_name}`,
    'สถานะ': STATUS_TH[r.fund_status],
    'วันที่รับบริการ': r.sdate,
    'VN': r.vn,
    'HN': r.hn,
    'เลขบัตรประชาชน': r.cid,
    'ชื่อ-สกุล': r.patient_name,
    'สิทธิ': r.pttype_name,
    'รายการที่เข้าเงื่อนไข / เหตุผล': r.items,
    'ยอดตั้งเบิก (HOSxP)': r.his_fund_amount,
    'ยอดเบิกได้ (กองทุนนี้)': r.stm_fund_amount,
    'ผลต่าง': r.stm_fund_amount === null || r.his_fund_amount === null
      ? null : Math.round((r.stm_fund_amount - r.his_fund_amount) * 100) / 100,
    'REP No.': r.rep_no,
    'TRAN_ID': r.tran_id,
    'รหัสข้อผิดพลาด': r.error_code,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = Object.keys(data[0] || { a: 1 }).map((k) => ({ wch: Math.max(12, k.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'แยกกองทุน');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length };
}
