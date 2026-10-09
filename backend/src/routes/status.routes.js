import { Router } from 'express';
import { db } from '../config/db.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

/** ความสดของข้อมูลแต่ละแหล่ง (แสดงในแถบสถานะด้านบนทุกหน้า) ไม่มีข้อมูลรายคนไข้ */
router.get('/', asyncHandler(async (_req, res) => {
  const { rows: [r] } = await db.query(`
    SELECT
      (SELECT MAX(created_at) FROM import_batches WHERE file_type = 'REP') AS rep_at,
      (SELECT MAX(service_date) FROM nhso_lines WHERE claim_type = 'OPD') AS rep_max_date,
      (SELECT MAX(created_at) FROM his_pull_logs WHERE claim_type = 'OPD') AS his_at,
      (SELECT MAX(date_to) FROM his_pull_logs WHERE claim_type = 'OPD') AS his_max_date,
      (SELECT MAX(created_at) FROM registry_batches) AS reg_at,
      (SELECT COUNT(DISTINCT fund_code)::int FROM registry_rows) AS reg_funds,
      -- ช่วงวันที่ของทะเบียนที่อัปโหลดหลังดึง HOSxP ล่าสุด
      (SELECT MIN(date_from)::text FROM registry_batches
        WHERE created_at > COALESCE((SELECT MAX(created_at) FROM his_pull_logs WHERE claim_type = 'OPD'), '-infinity')) AS reg_from,
      (SELECT MAX(date_to)::text FROM registry_batches
        WHERE created_at > COALESCE((SELECT MAX(created_at) FROM his_pull_logs WHERE claim_type = 'OPD'), '-infinity')) AS reg_to`);
  // ช่วงไม่เกิน 366 วัน (ข้อจำกัดการดึง HOSxP ต่อครั้ง) โดยเก็บช่วงล่าสุดไว้
  const cap = (from, to) => {
    if (!from || !to) return null;
    const min = new Date(new Date(to).getTime() - 365 * 86400000).toISOString().slice(0, 10);
    return { dateFrom: from < min ? min : from, dateTo: to };
  };
  const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const repMax = iso(r.rep_max_date); const hisMax = iso(r.his_max_date);
  const nextDay = (d) => new Date(new Date(d).getTime() + 86400000).toISOString().slice(0, 10);
  res.json({
    rep: { at: r.rep_at, maxDate: r.rep_max_date },
    his: { at: r.his_at, maxDate: r.his_max_date },
    registry: { at: r.reg_at, funds: r.reg_funds },
    // ทะเบียนใหม่กว่าการดึง HOSxP ล่าสุด: รายการใหม่ในทะเบียนอาจยังไม่ถูกดึง
    hisOlderThanRegistry: !!(r.reg_at && r.his_at && r.reg_at > r.his_at),
    // ช่วงที่ควรดึง HOSxP เพิ่ม: REP มีข้อมูลวันที่ที่ยังไม่ได้ดึง / ทะเบียนใหม่กว่าการดึงล่าสุด
    pullForRep: repMax && (!hisMax || repMax > hisMax) ? cap(hisMax ? nextDay(hisMax) : repMax.slice(0, 8) + '01', repMax) : null,
    pullForRegistry: r.reg_from ? cap(r.reg_from, r.reg_to) : null,
  });
}));

export default router;
