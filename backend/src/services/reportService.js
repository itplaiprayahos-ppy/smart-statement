import * as XLSX from 'xlsx';
import { withFundTable } from './fundService.js';

/**
 * รายงานสำหรับเจ้าหน้าที่ผู้รับผิดชอบกองทุน นำไปใช้แก้ไข/ติดตามต่อ
 * where = เงื่อนไขบนตารางผลแยกกองทุน (fy) ที่มีคอลัมน์ issues (ประเด็นที่ควรตรวจ) เพิ่มแล้ว
 */
export const REPORT_TYPES = {
  eligible: {
    title: 'คนไข้ที่เข้าเกณฑ์กองทุน',
    description: 'ทุก visit ที่มีรายการค่าบริการ/ยาและสิทธิตรงตามการตั้งค่ากองทุน พร้อมสถานะการเบิก',
    where: "fund_status <> 'EXTRA_PAID'",
  },
  not_sent: {
    title: 'ยังไม่ส่งเบิก / ไม่พบใน Statement',
    description: 'visit ที่เข้าเกณฑ์แต่ยังไม่มีใน Statement ที่นำเข้า ใช้ตรวจว่าส่งเบิกแล้วหรือยัง',
    where: "fund_status = 'NOT_SENT'",
  },
  failed: {
    title: 'เคลมไม่สำเร็จ',
    description: 'พบใน Statement แต่ไม่ได้รับเงินกองทุนนี้ หรือถูกปฏิเสธ / ติด C พร้อมรายการที่ขาด',
    where: "fund_status IN ('NOT_PAID', 'DENIED')",
  },
  incomplete: {
    title: 'ข้อมูลอาจไม่ครบถ้วน',
    description: 'visit ที่เข้าเกณฑ์และมีประเด็นที่ควรตรวจ เช่น ไม่มีเลขบัตร ไม่มี PDX ขาดรายการจำเป็น',
    where: "fund_status <> 'EXTRA_PAID' AND issues <> ''",
  },
  paid: {
    title: 'ได้รับเงินแล้ว',
    description: 'visit ที่เข้าเกณฑ์และได้รับเงินกองทุนแล้ว พร้อมรอบ STM ใช้กระทบยอดรับเงิน',
    where: "fund_status = 'PAID'",
  },
  extra_paid: {
    title: 'ได้รับเงินแต่ไม่เข้าเกณฑ์',
    description: 'สปสช. จ่ายเงินกองทุน แต่ visit ไม่มีรายการหรือสิทธิตามการตั้งค่า ใช้ทบทวนการตั้งค่ากองทุน',
    where: "fund_status = 'EXTRA_PAID'",
  },
};

/** ประเด็นที่ควรตรวจต่อ visit (คำนวณใน SQL) */
const ISSUES_SQL = `array_to_string(array_remove(ARRAY[
    CASE WHEN fund_status <> 'EXTRA_PAID' AND (cid IS NULL OR cid !~ '^[0-9]{13}$')
         THEN 'ไม่มีเลขบัตรประชาชนหรือไม่ครบ 13 หลัก' END,
    CASE WHEN fund_status <> 'EXTRA_PAID' AND COALESCE(TRIM(pdx), '') = ''
         THEN 'ไม่มีรหัสโรคหลัก (PDX)' END,
    CASE WHEN missing_required IS NOT NULL THEN 'ขาดรายการจำเป็น' END,
    CASE WHEN missing_common IS NOT NULL THEN 'ขาดรายการที่เคสได้รับเงินมักมี' END,
    CASE WHEN fund_status = 'DENIED' THEN 'ถูกปฏิเสธ: ' || COALESCE(error_code, '') END
  ], NULL), ', ')`;

const STATUS_TH = {
  PAID: 'ได้รับเงิน',
  NOT_PAID: 'ไม่ได้รับเงินกองทุนนี้',
  DENIED: 'ถูกปฏิเสธ/ติด C',
  NOT_SENT: 'ไม่พบใน Statement',
  EXTRA_PAID: 'ได้รับเงินแต่ไม่เข้าเกณฑ์',
};

const MAX_ROWS = 300_000;

async function queryReport(c, opts) {
  const type = REPORT_TYPES[opts.type];
  const { rows } = await c.query(`
    SELECT * FROM (
      SELECT fy.*, f.name AS fund_name, f.sort_order, ${ISSUES_SQL} AS issues
      FROM fy JOIN funds f ON f.code = fy.fund_code
      WHERE ($1::text[] IS NULL OR fy.fund_code = ANY($1::text[]))
    ) t
    WHERE ${type.where}
    ORDER BY sort_order, fund_code, sdate, hn
    LIMIT ${MAX_ROWS}`, [opts.fundCodes?.length ? opts.fundCodes : null]);
  return rows;
}

/** จำนวนรายการต่อกองทุนก่อนส่งออก (แสดงในหน้าเลือกรายงาน) */
export async function countReport(opts) {
  return withFundTable({ ...opts, fundCode: null }, async (c) => {
    const rows = await queryReport(c, opts);
    const byFund = {};
    rows.forEach((r) => { byFund[r.fund_code] = (byFund[r.fund_code] || 0) + 1; });
    return { total: rows.length, patients: new Set(rows.map((r) => r.cid || r.hn)).size, byFund };
  });
}

function toSheetRows(rows) {
  return rows.map((r) => ({
    'กองทุน': r.fund_code,
    'สถานะ': STATUS_TH[r.fund_status],
    'ประเด็นที่ควรตรวจ': r.issues || '',
    'วันที่รับบริการ': r.sdate,
    'VN': r.vn,
    'HN': r.hn,
    'เลขบัตรประชาชน': r.cid,
    'ชื่อ-สกุล': r.patient_name,
    'รหัสสิทธิ': r.pttype,
    'สิทธิ': r.pttype_name,
    'PDX': r.pdx,
    'รายการที่เข้าเกณฑ์ / เหตุผล': r.items,
    'icode ที่เข้าเกณฑ์': r.item_codes,
    'ขาดรายการจำเป็น': r.missing_required,
    'ขาดเมื่อเทียบเคสที่ได้รับเงิน': r.missing_common,
    'ยอดตั้งเบิก (HOSxP)': r.his_fund_amount,
    'ยอดเบิกได้ (กองทุนนี้)': r.stm_fund_amount,
    'REP No.': r.rep_no,
    'TRAN_ID': r.tran_id,
    'รอบ STM': r.stm_docs,
    'รหัสข้อผิดพลาด': r.error_code,
    'ผลการแก้ไข / หมายเหตุ': '',
  }));
}

const COL_WIDTHS = {
  'ประเด็นที่ควรตรวจ': 36, 'ชื่อ-สกุล': 24, 'สิทธิ': 22, 'รายการที่เข้าเกณฑ์ / เหตุผล': 36,
  'ขาดรายการจำเป็น': 28, 'ขาดเมื่อเทียบเคสที่ได้รับเงิน': 30, 'ผลการแก้ไข / หมายเหตุ': 30, 'เลขบัตรประชาชน': 16,
};

function dataSheet(rows) {
  const data = toSheetRows(rows);
  const headers = Object.keys(toSheetRows([{}])[0]);
  const ws = XLSX.utils.json_to_sheet(data, { header: headers });
  ws['!cols'] = headers.map((h) => ({ wch: COL_WIDTHS[h] || Math.max(10, h.length + 2) }));
  // ตัวกรองที่หัวตาราง ให้เจ้าหน้าที่กรอง/เรียงต่อใน Excel ได้ทันที
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(data.length, 1), c: headers.length - 1 } }) };
  return ws;
}

const thaiDate = (iso) => {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${Number(y) + 543}`;
};

/** ไฟล์ Excel: ชีตสรุป + ข้อมูล (แยกชีตตามกองทุนได้) */
export async function buildReport(opts, user) {
  const type = REPORT_TYPES[opts.type];
  return withFundTable({ ...opts, fundCode: null }, async (c) => {
    const rows = await queryReport(c, opts);
    const { rows: funds } = await c.query(
      `SELECT code, name FROM funds WHERE is_active AND ($1::text[] IS NULL OR code = ANY($1::text[]))
       ORDER BY sort_order, code`, [opts.fundCodes?.length ? opts.fundCodes : null],
    );

    const wb = XLSX.utils.book_new();
    const summary = [
      ['รายงาน', type.title],
      ['คำอธิบาย', type.description],
      ['ช่วงวันที่รับบริการ', `${thaiDate(opts.dateFrom)} – ${thaiDate(opts.dateTo)}`],
      ['กลุ่มสิทธิ', opts.fund || 'ทุกสิทธิ'],
      ['ส่งออกโดย', user.full_name || user.username],
      ['เวลาที่ส่งออก', new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })],
      [],
      ['กองทุน', 'ชื่อกองทุน', 'จำนวนรายการ', 'จำนวนคนไข้', 'ยอดตั้งเบิก (HOSxP)', 'ยอดเบิกได้'],
    ];
    funds.forEach((f) => {
      const fr = rows.filter((r) => r.fund_code === f.code);
      summary.push([
        f.code, f.name, fr.length, new Set(fr.map((r) => r.cid || r.hn)).size,
        fr.reduce((a, r) => a + Number(r.his_fund_amount || 0), 0),
        fr.reduce((a, r) => a + Number(r.stm_fund_amount || 0), 0),
      ]);
    });
    summary.push(['รวม', '', rows.length, new Set(rows.map((r) => r.cid || r.hn)).size]);
    if (rows.length >= MAX_ROWS) summary.push([], [`หมายเหตุ: แสดงไม่เกิน ${MAX_ROWS.toLocaleString()} รายการ กรุณาเลือกช่วงวันที่ให้แคบลง`]);
    const ws = XLSX.utils.aoa_to_sheet(summary);
    ws['!cols'] = [{ wch: 20 }, { wch: 36 }, { wch: 14 }, { wch: 12 }, { wch: 20 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'สรุป');

    if (opts.split) {
      funds.forEach((f) => {
        const fr = rows.filter((r) => r.fund_code === f.code);
        if (fr.length) XLSX.utils.book_append_sheet(wb, dataSheet(fr), f.code.slice(0, 31));
      });
      if (!rows.length) XLSX.utils.book_append_sheet(wb, dataSheet([]), 'ข้อมูล');
    } else {
      XLSX.utils.book_append_sheet(wb, dataSheet(rows), 'ข้อมูล');
    }
    return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length, title: type.title };
  });
}
