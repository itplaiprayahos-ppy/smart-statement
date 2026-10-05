import * as XLSX from 'xlsx';
import { db } from '../config/db.js';
import { baseCte, baseParams } from './reconService.js';

/**
 * สถานะการเบิกรายกองทุน
 *  PAID        เข้าเกณฑ์ ส่งเบิกแล้ว และได้รับเงินกองทุนนี้ (ยอดสุทธิทุกรอบ STM > 0)
 *  NOT_PAID    เข้าเกณฑ์ พบใน Statement แต่ยอดสุทธิของกองทุนนี้เป็น 0 หรือติดลบ
 *  DENIED      เข้าเกณฑ์ แต่ สปสช. ปฏิเสธ / ติด C (ตามรอบล่าสุด)
 *  NOT_SENT    เข้าเกณฑ์ แต่ไม่พบใน Statement
 *  EXTRA_PAID  (ตรวจย้อนกลับ) ได้รับเงินกองทุนนี้ แต่ไม่เข้าเกณฑ์ตามการตั้งค่า
 */
export const FUND_STATUSES = ['PAID', 'NOT_PAID', 'DENIED', 'NOT_SENT', 'EXTRA_PAID'];
const FAILED = "('NOT_SENT', 'DENIED', 'NOT_PAID')";

/** เกณฑ์รายการที่พบบ่อยในเคสสำเร็จ: ต้องมีเคสได้รับเงินอย่างน้อย MIN_PAID visit และพบใน >= COMMON_RATE ของเคสเหล่านั้น */
export const MIN_PAID = 5;
export const COMMON_RATE = 0.6;

/**
 * ต่อจาก CTE ของการกระทบยอด OPD (r = ผลจับคู่ visit กับรายการเบิกที่รวมทุกรอบ STM แล้ว)
 *  fv    = visit ที่เข้าเกณฑ์กองทุน: มีรายการที่ตั้งค่าอย่างน้อย 1 รายการ และสิทธิตรงเงื่อนไข (ถ้ากำหนด)
 *  elig  = visit ที่เข้าเกณฑ์ + สถานะเบิกของกองทุนนั้น
 *  extra = Statement จ่ายเงินกองทุน แต่ visit ไม่เข้าเกณฑ์ (ตรวจย้อนกลับ)
 * พารามิเตอร์ $1-$4 จาก baseParams, $5 = รหัสกองทุน (null = ทุกกองทุน)
 */
function fundCte() {
  return `${baseCte('claim')},
  fv AS MATERIALIZED (
    SELECT i.vn, fi.fund_code,
           SUM(i.sum_price) AS his_fund_amount,
           string_agg(DISTINCT COALESCE(fi.item_name, i.icode), ', ') AS items,
           array_agg(DISTINCT i.icode) AS icodes
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
    SELECT fv.fund_code, fv.items, array_to_string(fv.icodes, ', ') AS item_codes,
           (SELECT string_agg(COALESCE(rq.item_name, rq.icode), ', ' ORDER BY rq.item_name)
              FROM fund_items rq
             WHERE rq.fund_code = fv.fund_code AND rq.required AND NOT (rq.icode = ANY (fv.icodes))
           ) AS missing_required,
           fv.his_fund_amount,
           r.vn, r.hn, r.cid, r.patient_name, r.sdate, r.pttype, r.pttype_name, r.hipdata_code,
           r.pdx, r.uc_money,
           r.line_id, r.rep_no, r.tran_id, r.stm_docs, r.error_code,
           (r.fund_amounts ->> fv.fund_code)::numeric AS stm_fund_amount,
           CASE
             WHEN r.line_id IS NULL THEN 'NOT_SENT'
             WHEN r.status = 'DENIED' THEN 'DENIED'
             WHEN COALESCE((r.fund_amounts ->> fv.fund_code)::numeric, 0) > 0 THEN 'PAID'
             ELSE 'NOT_PAID'
           END AS fund_status
    FROM fv
    JOIN r ON r.vn = fv.vn
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
           NULL::text AS item_codes,
           NULL::text AS missing_required,
           NULL::numeric AS his_fund_amount,
           r.vn, COALESCE(r.hn, r.nhso_hn) AS hn, COALESCE(r.cid, r.pid) AS cid, r.patient_name, r.sdate,
           r.pttype, r.pttype_name, r.hipdata_code,
           r.pdx, r.uc_money,
           r.line_id, r.rep_no, r.tran_id, r.stm_docs, r.error_code,
           kv.value::numeric AS stm_fund_amount,
           'EXTRA_PAID' AS fund_status
    FROM r
    CROSS JOIN LATERAL jsonb_each_text(r.fund_amounts) AS kv
    JOIN funds f ON f.code = kv.key AND f.is_active
    LEFT JOIN fv ON fv.vn = r.vn AND fv.fund_code = kv.key
    WHERE r.line_id IS NOT NULL
      AND kv.value::numeric > 0
      AND ($5::text IS NULL OR kv.key = $5)
      AND fv.vn IS NULL
  ),
  x AS (SELECT * FROM elig UNION ALL SELECT * FROM extra)`;
}

/**
 * วิเคราะห์จากตารางผลลัพธ์ (src)
 *  vstat    = สถานะต่อ (กองทุน, visit) เฉพาะที่เข้าเกณฑ์
 *  ftot     = จำนวนเคสได้รับเงิน / ไม่สำเร็จ ต่อกองทุน
 *  itemstat = แต่ละรายการ (ทุกรายการของ visit) พบในเคสได้รับเงินและไม่สำเร็จกี่ visit
 *  common   = รายการที่พบบ่อยในเคสได้รับเงิน
 */
function analysisCte(src) {
  return `
  vstat AS MATERIALIZED (SELECT DISTINCT fund_code, vn, fund_status FROM ${src} WHERE fund_status <> 'EXTRA_PAID'),
  ftot AS (
    SELECT fund_code,
           COUNT(*) FILTER (WHERE fund_status = 'PAID')::int AS paid_n,
           COUNT(*) FILTER (WHERE fund_status IN ${FAILED})::int AS fail_n
    FROM vstat GROUP BY fund_code
  ),
  itemstat AS (
    SELECT s.fund_code, i.icode, MAX(i.item_name) AS item_name, MAX(i.source) AS source,
           COUNT(*) FILTER (WHERE s.fund_status = 'PAID')::int AS paid_with,
           COUNT(*) FILTER (WHERE s.fund_status IN ${FAILED})::int AS fail_with
    FROM vstat s JOIN his_opd_items i ON i.vn = s.vn
    GROUP BY s.fund_code, i.icode
  ),
  common AS MATERIALIZED (
    SELECT st.*, t.paid_n, t.fail_n,
           st.paid_with::numeric / t.paid_n AS paid_rate,
           CASE WHEN t.fail_n > 0 THEN st.fail_with::numeric / t.fail_n END AS fail_rate
    FROM itemstat st JOIN ftot t ON t.fund_code = st.fund_code
    WHERE t.paid_n >= ${MIN_PAID} AND st.paid_with::numeric / t.paid_n >= ${COMMON_RATE}
  )`;
}

/**
 * คำนวณผลแยกกองทุนครั้งเดียวลงตารางชั่วคราว fy (มีคอลัมน์ missing_common เพิ่ม)
 * แล้วให้ทุกคำสั่งสรุปอ่านจากตารางนี้ แทนการคำนวณซ้ำทุกคำสั่ง
 */
export async function withFundTable(opts, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = [...baseParams({ ...opts, onlyClaimable: false }), opts.fundCode ?? null];
    await client.query(`CREATE TEMP TABLE fx ON COMMIT DROP AS ${fundCte()} SELECT * FROM x`, p);
    await client.query('CREATE INDEX ON fx (vn); ANALYZE fx');
    await client.query(`
      CREATE TEMP TABLE fy ON COMMIT DROP AS
      WITH ${analysisCte('fx')}
      SELECT fx.*,
             CASE WHEN fx.fund_status IN ${FAILED} THEN (
               SELECT string_agg(COALESCE(c.item_name, c.icode), ', ' ORDER BY c.paid_rate DESC)
               FROM common c
               WHERE c.fund_code = fx.fund_code
                 AND NOT EXISTS (SELECT 1 FROM his_opd_items i WHERE i.vn = fx.vn AND i.icode = c.icode)
             ) END AS missing_common
      FROM fx`);
    await client.query('CREATE INDEX ON fy (fund_code, fund_status); ANALYZE fy');
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

/** เงื่อนไขกรองรายละเอียด: $1 กองทุน, $2 สถานะ, $3 คำค้น, $4 ขาดรายการ */
const DETAIL_WHERE = `
  WHERE ($1::text IS NULL OR fund_code = $1)
    AND ($2::text IS NULL OR fund_status = $2)
    AND ($3::text IS NULL OR hn = $3 OR vn = $3 OR cid LIKE $3 || '%'
         OR tran_id LIKE '%' || $3 || '%' OR patient_name ILIKE '%' || $3 || '%')
    AND ($4::text IS NULL
         OR ($4 = 'required' AND missing_required IS NOT NULL)
         OR ($4 = 'common' AND missing_common IS NOT NULL))`;
const detailParams = (o) => [o.fundCode || null, o.fundStatus || null, o.search?.trim() || null, o.missing || null];

const ELIGIBLE = "fund_status <> 'EXTRA_PAID'";
const PERSON = 'COALESCE(cid, hn)';

/**
 * เดือนในช่วงที่ยังไม่เคยดึง HOSxP และเดือนที่ต้องดึงใหม่เพราะเพิ่มรายการในกองทุนหลังดึงครั้งล่าสุด
 * (ตรวจทีละเดือน ไม่ใช่เทียบกับการดึงครั้งล่าสุดของช่วงใดก็ได้)
 */
export async function pullCoverage(client, { dateFrom, dateTo }) {
  const { rows } = await client.query(`
    WITH m AS (
      SELECT d::date AS month_start,
             GREATEST(d::date, $1::date) AS s,
             LEAST((d + interval '1 month - 1 day')::date, $2::date) AS e
      FROM generate_series(date_trunc('month', $1::date), $2::date, interval '1 month') d
    )
    SELECT to_char(m.month_start, 'YYYY-MM') AS month,
           (SELECT MAX(l.created_at) FROM his_pull_logs l
             WHERE l.claim_type = 'OPD' AND l.date_from <= m.s AND l.date_to >= m.e) AS pulled_at
    FROM m ORDER BY m.month_start`, [dateFrom, dateTo]);
  const { rows: [chg] } = await client.query('SELECT MAX(created_at) AS at FROM fund_items');
  return {
    notPulledMonths: rows.filter((r) => !r.pulled_at).map((r) => r.month),
    stalePulledMonths: rows.filter((r) => r.pulled_at && chg.at && r.pulled_at < chg.at).map((r) => r.month),
  };
}

export async function reconcileFunds(opts) {
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 10), 500);
  const page = Math.max(Number(opts.page) || 1, 1);

  // ตารางสรุปต้องเห็นทุกกองทุน จึงคำนวณโดยไม่กรองกองทุน แล้วกรองทีหลัง
  return withFundTable({ ...opts, fundCode: null }, async (c) => {
    const dp = detailParams(opts);
    const funds = await c.query(`
      SELECT f.code, f.name, f.pttypes, COUNT(fi.icode)::int AS item_count
      FROM funds f LEFT JOIN fund_items fi ON fi.fund_code = f.code
      WHERE f.is_active GROUP BY f.code ORDER BY f.sort_order, f.code`);
    const byStatus = await c.query(`
      SELECT fund_code, fund_status, COUNT(*)::int AS count,
             COALESCE(SUM(his_fund_amount), 0) AS his_amount,
             COALESCE(SUM(stm_fund_amount), 0) AS stm_amount
      FROM fy GROUP BY fund_code, fund_status`);
    const people = await c.query(`
      SELECT fund_code, COUNT(DISTINCT ${PERSON})::int AS patients, COUNT(DISTINCT vn)::int AS visits
      FROM fy WHERE ${ELIGIBLE} GROUP BY ROLLUP (fund_code)`);
    // ยอดตั้งเบิกรวมทุกกองทุน: นับแต่ละรายการของ visit ครั้งเดียว แม้รายการอยู่หลายกองทุน
    const hisTotal = await c.query(`
      SELECT COALESCE(SUM(i.sum_price), 0) AS his_amount
      FROM his_opd_items i
      WHERE EXISTS (SELECT 1 FROM fy JOIN fund_items fi ON fi.fund_code = fy.fund_code
                    WHERE fy.vn = i.vn AND fi.icode = i.icode AND fy.${ELIGIBLE})`);
    const monthly = await c.query(`
      SELECT to_char(sdate, 'YYYY-MM') AS month,
             COUNT(DISTINCT ${PERSON}) FILTER (WHERE ${ELIGIBLE})::int AS patients,
             COUNT(DISTINCT vn) FILTER (WHERE ${ELIGIBLE})::int AS visits,
             COALESCE(SUM(his_fund_amount) FILTER (WHERE ${ELIGIBLE}), 0) AS his_amount,
             COALESCE(SUM(stm_fund_amount) FILTER (WHERE ${ELIGIBLE}), 0) AS stm_amount,
             COUNT(*) FILTER (WHERE fund_status = 'NOT_SENT')::int AS not_sent,
             COALESCE(SUM(his_fund_amount) FILTER (WHERE fund_status = 'NOT_SENT'), 0) AS not_sent_amount,
             COUNT(*) FILTER (WHERE fund_status = 'EXTRA_PAID')::int AS extra_paid,
             COALESCE(SUM(stm_fund_amount) FILTER (WHERE fund_status = 'EXTRA_PAID'), 0) AS extra_paid_amount
      FROM fy WHERE ($1::text IS NULL OR fund_code = $1)
      GROUP BY 1 ORDER BY 1`, [opts.fundCode || null]);
    const count = await c.query(`SELECT COUNT(*)::int AS total FROM fy ${DETAIL_WHERE}`, dp);
    const rows = await c.query(`SELECT * FROM fy ${DETAIL_WHERE}
      ORDER BY sdate, hn, fund_code LIMIT $5 OFFSET $6`, [...dp, pageSize, (page - 1) * pageSize]);
    const coverage = await pullCoverage(c, opts);

    const totals = people.rows.find((r) => r.fund_code === null) || { patients: 0, visits: 0 };
    return {
      funds: funds.rows,
      summary: byStatus.rows,
      people: people.rows.filter((r) => r.fund_code !== null),
      totals: { ...totals, his_amount: Number(hisTotal.rows[0].his_amount) },
      monthly: monthly.rows,
      total: count.rows[0].total,
      page,
      pageSize,
      rows: rows.rows,
      ...coverage,
      needsRepull: coverage.stalePulledMonths.length > 0,
    };
  });
}

/**
 * วิเคราะห์รายการของกองทุน
 *  items  = รายการที่ตั้งค่าไว้ แต่ละรายการพบในกี่ visit และได้รับเงิน / ไม่สำเร็จกี่ visit
 *  common = รายการที่พบบ่อยในเคสได้รับเงิน เทียบกับสัดส่วนที่พบในเคสไม่สำเร็จ
 */
export async function analyzeFundItems(opts) {
  return withFundTable(opts, async (c) => {
    const items = await c.query(`
      WITH ${analysisCte('fy')}
      SELECT fi.fund_code, fi.icode, fi.item_name, fi.source, fi.required,
             COALESCE(v.visits, 0)::int AS visits,
             COALESCE(v.paid, 0)::int AS paid,
             COALESCE(v.not_paid, 0)::int AS not_paid,
             COALESCE(v.denied, 0)::int AS denied,
             COALESCE(v.not_sent, 0)::int AS not_sent,
             COALESCE(v.amount, 0) AS amount
      FROM fund_items fi
      JOIN funds f ON f.code = fi.fund_code AND f.is_active
      LEFT JOIN (
        SELECT s.fund_code, i.icode, COUNT(*) AS visits,
               COUNT(*) FILTER (WHERE s.fund_status = 'PAID') AS paid,
               COUNT(*) FILTER (WHERE s.fund_status = 'NOT_PAID') AS not_paid,
               COUNT(*) FILTER (WHERE s.fund_status = 'DENIED') AS denied,
               COUNT(*) FILTER (WHERE s.fund_status = 'NOT_SENT') AS not_sent,
               SUM(i.sum_price) AS amount
        FROM vstat s JOIN his_opd_items i ON i.vn = s.vn
        GROUP BY s.fund_code, i.icode
      ) v ON v.fund_code = fi.fund_code AND v.icode = fi.icode
      WHERE ($1::text IS NULL OR fi.fund_code = $1)
      ORDER BY fi.fund_code, visits DESC, fi.item_name`, [opts.fundCode || null]);
    const common = await c.query(`
      WITH ${analysisCte('fy')}
      SELECT c.*, (fi.icode IS NOT NULL) AS configured
      FROM common c
      LEFT JOIN fund_items fi ON fi.fund_code = c.fund_code AND fi.icode = c.icode
      ORDER BY c.fund_code, (c.paid_rate - COALESCE(c.fail_rate, 0)) DESC, c.paid_rate DESC
      LIMIT 500`);
    const totals = await c.query(`WITH ${analysisCte('fy')} SELECT * FROM ftot ORDER BY fund_code`);
    return {
      items: items.rows,
      common: common.rows,
      totals: totals.rows,
      thresholds: { minPaid: MIN_PAID, commonRate: COMMON_RATE },
    };
  });
}

const STATUS_TH = {
  PAID: 'ได้รับเงิน',
  NOT_PAID: 'ไม่ได้รับเงินกองทุนนี้',
  DENIED: 'ถูกปฏิเสธ/ติด C',
  NOT_SENT: 'ไม่พบใน Statement',
  EXTRA_PAID: 'ได้รับเงินแต่ไม่เข้าเกณฑ์',
};

export async function exportFunds(opts) {
  const rows = await withFundTable({ ...opts, fundCode: null }, async (c) => (await c.query(
    `SELECT fy.*, f.name AS fund_name FROM fy JOIN funds f ON f.code = fy.fund_code
     ${DETAIL_WHERE.replace(/\bfund_code\b/, 'fy.fund_code')} ORDER BY fy.fund_code, fy.sdate, fy.hn LIMIT 300000`,
    detailParams(opts),
  )).rows);

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
    'ขาดรายการจำเป็น': r.missing_required,
    'ขาดเมื่อเทียบเคสที่ได้รับเงิน': r.missing_common,
    'ยอดตั้งเบิก (HOSxP)': r.his_fund_amount,
    'ยอดเบิกได้ (กองทุนนี้)': r.stm_fund_amount,
    'ผลต่าง': r.stm_fund_amount === null || r.his_fund_amount === null
      ? null : Math.round((r.stm_fund_amount - r.his_fund_amount) * 100) / 100,
    'REP No.': r.rep_no,
    'TRAN_ID': r.tran_id,
    'รอบ STM': r.stm_docs,
    'รหัสข้อผิดพลาด': r.error_code,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = Object.keys(data[0] || { a: 1 }).map((k) => ({ wch: Math.max(12, k.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'แยกกองทุน');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length };
}
