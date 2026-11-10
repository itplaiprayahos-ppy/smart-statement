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
    where: "fund_status NOT IN ('EXTRA_PAID', 'RECEIVED')",
  },
  not_sent: {
    title: 'ยังไม่พบใน REP',
    description: 'visit ที่เข้าเกณฑ์แต่ยังไม่มีใน REP ที่นำเข้า ใช้ตรวจว่าส่งเบิกแล้วหรือยัง',
    where: "fund_status = 'NOT_SENT'",
  },
  failed: {
    title: 'เคลมไม่สำเร็จ',
    description: 'พบใน REP แต่ไม่ได้รับเงินกองทุนนี้ หรือถูกปฏิเสธ / ติด C พร้อมรายการที่ขาด',
    where: "fund_status IN ('NOT_PAID', 'DENIED')",
  },
  incomplete: {
    title: 'ข้อมูลอาจไม่ครบถ้วน',
    description: 'visit ที่เข้าเกณฑ์และมีประเด็นที่ควรตรวจ เช่น ไม่มีเลขบัตร ไม่มี PDX ขาดรายการจำเป็น',
    where: "fund_status NOT IN ('EXTRA_PAID', 'RECEIVED') AND issues <> ''",
  },
  paid: {
    title: 'ได้รับเงินแล้ว',
    description: 'visit ที่ได้รับเงินกองทุนแล้ว รวมกองทุนติดตามยอดรับ (FS, DRUG) พร้อมเลขที่ REP ใช้กระทบยอดรับเงิน',
    where: "fund_status IN ('PAID', 'RECEIVED')",
  },
  extra_paid: {
    title: 'ได้รับเงินแต่ไม่เข้าเกณฑ์',
    description: 'สปสช. จ่ายเงินกองทุน แต่ visit ไม่มีรายการหรือสิทธิตามการตั้งค่า ใช้ทบทวนการตั้งค่ากองทุน',
    where: "fund_status = 'EXTRA_PAID'",
  },
};

/** ประเด็นที่ควรตรวจต่อ visit (คำนวณใน SQL) */
const ISSUES_SQL = `array_to_string(array_remove(ARRAY[
    CASE WHEN fund_status NOT IN ('EXTRA_PAID', 'RECEIVED') AND (cid IS NULL OR cid !~ '^[0-9]{13}$')
         THEN 'ไม่มีเลขบัตรประชาชนหรือไม่ครบ 13 หลัก' END,
    CASE WHEN fund_status NOT IN ('EXTRA_PAID', 'RECEIVED') AND COALESCE(TRIM(pdx), '') = ''
         THEN 'ไม่มีรหัสโรคหลัก (PDX)' END,
    CASE WHEN missing_required IS NOT NULL THEN 'ขาดรายการจำเป็น' END,
    CASE WHEN missing_common IS NOT NULL THEN 'ขาดรายการที่เคสได้รับเงินมักมี' END,
    CASE WHEN fund_status = 'DENIED' THEN 'ถูกปฏิเสธ: ' || COALESCE(error_code, '') END
  ], NULL), ', ')`;

const STATUS_TH = {
  PAID: 'ได้รับเงิน',
  NOT_PAID: 'ไม่ได้รับเงินกองทุนนี้',
  DENIED: 'ถูกปฏิเสธ/ติด C',
  NOT_SENT: 'ยังไม่พบใน REP',
  EXTRA_PAID: 'ได้รับเงินแต่ไม่เข้าเกณฑ์',
  RECEIVED: 'ได้รับเงิน (ติดตามยอดรับ)',
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

/** ตัดเลข icode ที่ติดท้ายชื่อรายการ เช่น "ตรวจ ANC (30012)" -> "ตรวจ ANC" */
function stripIcode(name, icode) {
  let s = String(name ?? '').trim();
  if (!s || s === String(icode)) return '';
  const code = String(icode).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  s = s.replace(new RegExp(`\\s*[(\\[]\\s*${code}\\s*[)\\]]\\s*$`), '');
  s = s.replace(/\s*\(\d{3,}\)\s*$/, '');
  return s.trim();
}

/**
 * ขยายแถวเป็น "แถวละค่าบริการที่เข้าเกณฑ์" (ชื่อตามที่ตั้งค่ากองทุน ไม่มี icode)
 *  - เฉพาะ icode ที่ visit นั้นมีจริงและอยู่ในการตั้งค่า (กองทุนแบบกิจกรรม: เฉพาะกิจกรรมที่ visit ผ่าน)
 *  - ตั้งเบิก (กองทุน) = ยอดของค่าบริการนั้น; ได้รับ (กองทุน) เป็นระดับ visit จึงใส่ที่แถวแรกเท่านั้น (กันรวมซ้ำใน Excel)
 *  - กองทุนแบบสิทธิ/ICD และแถว EXTRA_PAID/RECEIVED คงข้อความเหตุผลเดิม
 */
async function expandRows(c, rows) {
  const codes = new Set();
  const actIds = new Set();
  rows.forEach((r) => {
    String(r.item_codes || '').split(', ').filter(Boolean).forEach((x) => codes.add(x));
    (r.act_ids || []).forEach((id) => actIds.add(id));
  });
  const [{ rows: fis }, { rows: acts }, { rows: his }] = await Promise.all([
    c.query('SELECT fund_code, icode, item_name FROM fund_items WHERE icode = ANY($1)', [[...codes]]),
    c.query('SELECT activity_id, icode, item_name FROM fund_activity_items WHERE activity_id = ANY($1)', [[...actIds]]),
    c.query(`SELECT vn, icode, MAX(item_name) AS item_name, SUM(sum_price) AS price FROM his_opd_items
             WHERE vn = ANY($1) AND icode = ANY($2) GROUP BY vn, icode`,
    [[...new Set(rows.map((r) => r.vn).filter(Boolean))], [...codes]]),
  ]);
  const fundName = new Map(fis.map((x) => [`${x.fund_code}|${x.icode}`, stripIcode(x.item_name, x.icode)]));
  const actName = new Map(acts.map((x) => [`${x.activity_id}|${x.icode}`, stripIcode(x.item_name, x.icode)]));
  const hisInfo = new Map(his.map((x) => [`${x.vn}|${x.icode}`, { name: stripIcode(x.item_name, x.icode), price: Number(x.price) }]));

  const out = [];
  rows.forEach((r) => {
    const mine = String(r.item_codes || '').split(', ').filter(Boolean);
    if (['EXTRA_PAID', 'RECEIVED'].includes(r.fund_status) || !mine.length) { out.push(r); return; }
    const lines = mine.map((code) => {
      const h = hisInfo.get(`${r.vn}|${code}`);
      const name = (r.act_ids || []).map((id) => actName.get(`${id}|${code}`)).find(Boolean)
        || fundName.get(`${r.fund_code}|${code}`) || h?.name || '';
      return { code, name, price: h?.price ?? null };
    }).sort((a, b) => a.name.localeCompare(b.name, 'th') || a.code.localeCompare(b.code));
    lines.forEach((l, idx) => out.push({
      ...r,
      items: l.name,
      item_codes: l.code,
      his_fund_amount: l.price,
      stm_fund_amount: idx === 0 ? r.stm_fund_amount : null,
    }));
  });
  return out;
}

function toSheetRows(rows) {
  return rows.map((r) => ({
    'กองทุน': r.fund_code,
    'สถานะ': STATUS_TH[r.fund_status],
    'ประเด็นที่ควรตรวจ': r.issues || '',
    'วันที่รับบริการ': r.sdate,
    'VN': r.vn,
    'HN': r.hn,
    'ชื่อ-สกุล': r.patient_name,
    'สิทธิ': r.pttype_name,
    'PDX': r.pdx,
    'รายการที่เข้าเกณฑ์ / เหตุผล': r.items,
    'icode ที่เข้าเกณฑ์': r.item_codes,
    'ขาดรายการจำเป็น': r.missing_required,
    'ตั้งเบิก (กองทุน)': r.his_fund_amount,
    'ได้รับ (กองทุน)': r.stm_fund_amount,
    'REP No.': r.rep_no,
    'TRAN_ID': r.tran_id,
    'เลขที่ REP': r.stm_docs,
    'รหัสข้อผิดพลาด': r.error_code,
    'ผลการแก้ไข / หมายเหตุ': '',
  }));
}

const COL_WIDTHS = {
  'ประเด็นที่ควรตรวจ': 36, 'ชื่อ-สกุล': 24, 'สิทธิ': 22, 'รายการที่เข้าเกณฑ์ / เหตุผล': 36,
  'ขาดรายการจำเป็น': 28, 'ผลการแก้ไข / หมายเหตุ': 30,
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
    const sheetRows = await expandRows(c, rows);
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
      ['กองทุน', 'ชื่อกองทุน', 'จำนวนรายการ', 'จำนวนคนไข้', 'ตั้งเบิก (กองทุน)', 'ได้รับ (กองทุน)'],
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
        const fr = sheetRows.filter((r) => r.fund_code === f.code);
        if (fr.length) XLSX.utils.book_append_sheet(wb, dataSheet(fr), f.code.slice(0, 31));
      });
      if (!rows.length) XLSX.utils.book_append_sheet(wb, dataSheet([]), 'ข้อมูล');
    } else {
      XLSX.utils.book_append_sheet(wb, dataSheet(sheetRows), 'ข้อมูล');
    }
    return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length, title: type.title };
  });
}
