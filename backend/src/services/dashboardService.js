import { db } from '../config/db.js';
import { pullCoverage, withFundTable } from './fundService.js';

export const DEFAULT_TARGETS = { send: 95, success: 90, complete: 95 };

/**
 * ตัวชี้วัดการเบิกรายกองทุน
 *  เดือนที่ "ปิดยอดแล้ว" = เดือนที่มีรายการใน REP ที่นำเข้าแล้ว (REP มาช้ากว่าวันรับบริการ)
 *  ตัวชี้วัดคิดเฉพาะเดือนที่ปิดยอดแล้ว เดือนที่ยังไม่มี REP แสดงแยกเป็น "รอผล"
 *
 *  อัตราการส่งเบิก     = visit ที่เข้าเกณฑ์และพบใน REP ÷ visit ที่เข้าเกณฑ์
 *  อัตราเคลมสำเร็จ     = ได้รับเงิน ÷ ที่พบใน REP
 *  ความครบถ้วนของข้อมูล = visit ที่มีเลขบัตร 13 หลัก มี PDX และไม่ขาดรายการจำเป็น ÷ visit ที่เข้าเกณฑ์
 *  ยอดเบิกได้          = ยอดกองทุนจาก REP ทุกเดือน (รวมที่ได้รับแต่ไม่เข้าเกณฑ์)
 */
const KPI_CTE = `
  WITH closed_m AS (
    SELECT DISTINCT to_char(service_date, 'YYYY-MM') AS month
    FROM nhso_lines WHERE claim_type = 'OPD' AND service_date BETWEEN $1 AND $2
  ),
  e AS (
    SELECT fy.*,
           to_char(fy.sdate, 'YYYY-MM') AS month,
           fy.fund_status NOT IN ('EXTRA_PAID', 'RECEIVED') AS elig,
           (fy.cid IS NULL OR fy.cid !~ '^[0-9]{13}$' OR COALESCE(TRIM(fy.pdx), '') = ''
             OR fy.missing_required IS NOT NULL) AS has_issue,
           to_char(fy.sdate, 'YYYY-MM') IN (SELECT month FROM closed_m) AS closed
    FROM fy
  )`;

const KPI_COLUMNS = `
  COUNT(*) FILTER (WHERE elig AND closed)::int AS eligible,
  COUNT(*) FILTER (WHERE elig AND closed AND fund_status <> 'NOT_SENT')::int AS sent,
  COUNT(*) FILTER (WHERE elig AND closed AND fund_status = 'PAID')::int AS paid,
  COUNT(*) FILTER (WHERE elig AND closed AND NOT has_issue)::int AS complete,
  COALESCE(SUM(his_fund_amount) FILTER (WHERE elig AND closed AND fund_status = 'NOT_SENT'), 0) AS not_sent_amount,
  COUNT(*) FILTER (WHERE elig AND NOT closed)::int AS pending,
  COALESCE(SUM(his_fund_amount) FILTER (WHERE elig AND NOT closed), 0) AS pending_amount,
  COALESCE(SUM(his_fund_amount) FILTER (WHERE elig), 0) AS his_amount,
  COALESCE(SUM(stm_fund_amount), 0) AS stm_amount,
  COUNT(DISTINCT COALESCE(cid, hn)) FILTER (WHERE elig)::int AS patients,
  COUNT(*) FILTER (WHERE fund_status = 'RECEIVED')::int AS received`;

// ---------- cache: ผลเดิมใช้ซ้ำได้จนกว่าจะมีการนำเข้า ดึงข้อมูล หรือแก้การตั้งค่ากองทุน ----------
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function dataVersion() {
  const { rows } = await db.query(`
    SELECT concat_ws('|',
      (SELECT MAX(id) FROM import_batches), (SELECT COUNT(*) FROM import_batches),
      (SELECT MAX(id) FROM his_pull_logs),
      (SELECT MAX(updated_at) FROM funds), (SELECT MAX(created_at) FROM fund_items), (SELECT COUNT(*) FROM fund_items),
      (SELECT MAX(updated_at) FROM users)
    ) AS v`);
  return rows[0].v;
}

export async function fundKpis({ dateFrom, dateTo }) {
  const key = `${dateFrom}|${dateTo}|${await dataVersion()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.data, cached: true };

  const data = await withFundTable({ dateFrom, dateTo, fund: null, fundCode: null, onlyClaimable: false }, async (c) => {
    const p = [dateFrom, dateTo];
    const funds = await c.query(`
      SELECT f.code, f.name, f.sort_order, f.target_send, f.target_success, f.target_complete, f.track_only, f.match_mode,
             COUNT(fi.icode)::int AS item_count,
             (SELECT string_agg(COALESCE(u.full_name, u.username), ', ' ORDER BY u.username)
                FROM users u WHERE u.is_active AND u.fund_codes ? f.code) AS responsible
      FROM funds f LEFT JOIN fund_items fi ON fi.fund_code = f.code
      WHERE f.is_active GROUP BY f.code ORDER BY f.sort_order, f.code`);
    const byFund = await c.query(`${KPI_CTE} SELECT fund_code, ${KPI_COLUMNS} FROM e GROUP BY ROLLUP (fund_code)`, p);
    const monthly = await c.query(`${KPI_CTE}
      SELECT month, fund_code, bool_or(closed) AS closed, ${KPI_COLUMNS}
      FROM e GROUP BY GROUPING SETS ((month), (month, fund_code)) ORDER BY month`, p);
    const rounds = await c.query(`
      SELECT stm_doc, stm_period, COUNT(*)::int AS lines,
             MIN(service_date) AS date_min, MAX(service_date) AS date_max
      FROM nhso_lines WHERE claim_type = 'OPD' AND service_date BETWEEN $1 AND $2
      GROUP BY stm_doc, stm_period ORDER BY stm_period NULLS LAST, stm_doc`, p);
    const coverage = await pullCoverage(c, { dateFrom, dateTo });

    const overall = byFund.rows.find((r) => r.fund_code === null);
    return {
      dateFrom,
      dateTo,
      defaults: DEFAULT_TARGETS,
      funds: funds.rows.map((f) => ({ ...f, kpi: byFund.rows.find((r) => r.fund_code === f.code) || null })),
      overall,
      monthly: monthly.rows,
      rounds: rounds.rows,
      ...coverage,
      generatedAt: new Date().toISOString(),
    };
  });

  cache.set(key, { at: Date.now(), data });
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return data;
}
