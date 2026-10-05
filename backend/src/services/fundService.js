import * as XLSX from 'xlsx';
import { db } from '../config/db.js';
import { baseCte, baseParams } from './reconService.js';

/**
 * สถานะการเบิกรายกองทุน
 *  PAID      ส่งเบิกแล้ว และได้รับเงินกองทุนนี้ (ยอดกองทุนใน Statement > 0)
 *  NOT_PAID  พบใน Statement แต่ไม่ได้รับเงินกองทุนนี้ (ยอด 0 หรือไม่มีคอลัมน์)
 *  DENIED    สปสช. ปฏิเสธ / ติด C
 *  NOT_SENT  ไม่พบใน Statement
 */
export const FUND_STATUSES = ['PAID', 'NOT_PAID', 'DENIED', 'NOT_SENT'];

/**
 * ต่อจาก CTE ของการกระทบยอด OPD:
 *  fv = visit ที่มีรายการค่าบริการ/ยาตรงกับกองทุน (อย่างน้อย 1 รายการ) พร้อมยอดเงินของรายการนั้น
 *  x  = ผลจับคู่กับ Statement และยอดที่ได้รับของกองทุนนั้น
 * พารามิเตอร์ $1-$4 มาจาก baseParams, $5 = รหัสกองทุน (หรือ null = ทุกกองทุน)
 */
function fundCte() {
  return `${baseCte('claim')},
  fv AS (
    SELECT i.vn, fi.fund_code,
           SUM(i.sum_price) AS his_fund_amount,
           string_agg(DISTINCT COALESCE(fi.item_name, i.icode), ', ') AS items
    FROM his_opd_items i
    JOIN fund_items fi ON fi.icode = i.icode
    JOIN funds f ON f.code = fi.fund_code AND f.is_active
    WHERE i.vstdate BETWEEN $1 AND $2
      AND ($5::text IS NULL OR fi.fund_code = $5)
    GROUP BY i.vn, fi.fund_code
  ),
  x AS (
    SELECT fv.fund_code, fv.items, fv.his_fund_amount,
           r.vn, r.hn, r.cid, r.patient_name, r.sdate, r.pttype_name, r.hipdata_code, r.pdx,
           r.line_id, r.rep_no, r.tran_id, r.error_code, r.status AS recon_status,
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
  )`;
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
  const cte = fundCte();
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 10), 500);
  const page = Math.max(Number(opts.page) || 1, 1);

  const [funds, summary, count, rows, lastPull, lastItemChange] = await Promise.all([
    db.query(`SELECT f.code, f.name, f.stm_columns, COUNT(fi.icode)::int AS item_count
              FROM funds f LEFT JOIN fund_items fi ON fi.fund_code = f.code
              WHERE f.is_active GROUP BY f.code ORDER BY f.sort_order, f.code`),
    db.query(`${cte}
              SELECT fund_code, fund_status, COUNT(*)::int AS count,
                     COALESCE(SUM(his_fund_amount), 0) AS his_amount,
                     COALESCE(SUM(stm_fund_amount), 0) AS stm_amount
              FROM x GROUP BY fund_code, fund_status`, [...p.slice(0, 4), null]), // สรุปทุกกองทุนเสมอ
    db.query(`${cte} SELECT COUNT(*)::int AS total FROM x ${filterSql()}`, p),
    db.query(`${cte} SELECT * FROM x ${filterSql()}
              ORDER BY sdate, hn, fund_code LIMIT $8 OFFSET $9`, [...p, pageSize, (page - 1) * pageSize]),
    db.query(`SELECT MAX(created_at) AS at FROM his_pull_logs WHERE claim_type = 'OPD'`),
    db.query(`SELECT MAX(created_at) AS at FROM fund_items`),
  ]);

  return {
    funds: funds.rows,
    summary: summary.rows,
    total: count.rows[0].total,
    page,
    pageSize,
    rows: rows.rows,
    // เพิ่มรายการในกองทุนหลังดึง HOSxP ครั้งล่าสุด -> ต้องดึงใหม่จึงจะเห็น visit ของรายการนั้น
    needsRepull: !!(lastItemChange.rows[0].at && (!lastPull.rows[0].at || lastItemChange.rows[0].at > lastPull.rows[0].at)),
  };
}

const STATUS_TH = {
  PAID: 'ได้รับเงิน',
  NOT_PAID: 'ไม่ได้รับเงินกองทุนนี้',
  DENIED: 'ถูกปฏิเสธ/ติด C',
  NOT_SENT: 'ไม่พบใน Statement',
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
    'รายการที่เข้าเงื่อนไข': r.items,
    'ยอด HOSxP (รายการกองทุนนี้)': r.his_fund_amount,
    'ยอดที่ได้รับ (กองทุนนี้)': r.stm_fund_amount,
    'ผลต่าง': r.stm_fund_amount === null ? null : Math.round((r.stm_fund_amount - r.his_fund_amount) * 100) / 100,
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
