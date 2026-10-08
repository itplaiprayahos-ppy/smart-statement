import * as XLSX from 'xlsx';
import { db, hosxp, withTransaction } from '../config/db.js';
import { withFundTable } from './fundService.js';
import { annotateErrors, splitCodes } from './errorCodeService.js';
import { itemKey } from './registryParser.js';
import { sortRows } from '../utils/sort.js';

/* =====================================================================
 * จับคู่รายการในทะเบียนกับ icode ของ HOSxP
 *  1) คอลัมน์ icode ในไฟล์
 *  2) ชื่อที่เคยจับคู่ไว้ (item_aliases)
 *  3) ชื่อตรงกับรายการในการตั้งค่ากองทุน
 *  4) ชื่อตรงกับรายการที่เคยดึงจาก HOSxP / รายการหลักใน HOSxP (ต้องตรงเพียงรายการเดียว)
 * ===================================================================== */
async function resolveItems(fundCode, records) {
  const keys = [...new Set(records.filter((r) => !r.icode && r.item_key).map((r) => r.item_key))];
  const found = new Map();
  if (keys.length) {
    const { rows: aliases } = await db.query('SELECT alias_key, icode, item_name FROM item_aliases WHERE alias_key = ANY($1)', [keys]);
    aliases.forEach((a) => found.set(a.alias_key, { icode: a.icode, item_name: a.item_name }));

    const { rows: fi } = await db.query('SELECT icode, item_name FROM fund_items WHERE fund_code = $1', [fundCode]);
    fi.forEach((r) => { const k = itemKey(r.item_name); if (keys.includes(k) && !found.has(k)) found.set(k, r); });

    const rest = keys.filter((k) => !found.has(k));
    if (rest.length) {
      const { rows } = await db.query(
        `SELECT DISTINCT item_name, icode FROM his_opd_items WHERE item_name IS NOT NULL`,
      );
      const byKey = new Map();
      rows.forEach((r) => { const k = itemKey(r.item_name); if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(`${r.icode}|${r.item_name}`); });
      rest.forEach((k) => {
        const hits = byKey.get(k);
        if (hits?.size === 1) { const [icode, item_name] = [...hits][0].split('|'); found.set(k, { icode, item_name }); }
      });
    }

    const still = keys.filter((k) => !found.has(k));
    if (still.length) {
      try {
        const { rows } = await hosxp.query(
          `SELECT icode, name AS item_name FROM nondrugitems
            WHERE regexp_replace(lower(name), '[[:space:][:punct:]]', '', 'g') = ANY($1)
           UNION ALL
           SELECT icode, name FROM drugitems
            WHERE regexp_replace(lower(name), '[[:space:][:punct:]]', '', 'g') = ANY($1)`,
          [still],
        );
        const byKey = new Map();
        rows.forEach((r) => { const k = itemKey(r.item_name); (byKey.get(k) || byKey.set(k, []).get(k)).push(r); });
        byKey.forEach((list, k) => { if (list.length === 1) found.set(k, list[0]); });
      } catch {
        // เชื่อมต่อ HOSxP ไม่ได้: ข้ามขั้นนี้ ให้เจ้าหน้าที่จับคู่เอง
      }
    }
  }

  // ชื่อรายการของ icode ที่ใส่มาในไฟล์
  const codes = [...new Set(records.filter((r) => r.icode).map((r) => r.icode))];
  const names = new Map();
  if (codes.length) {
    const { rows } = await db.query(
      `SELECT icode, MAX(item_name) AS item_name FROM (
         SELECT icode, item_name FROM fund_items WHERE icode = ANY($1)
         UNION ALL SELECT icode, item_name FROM his_opd_items WHERE icode = ANY($1)) t GROUP BY icode`, [codes],
    );
    rows.forEach((r) => names.set(r.icode, r.item_name));
  }

  return records.map((r) => {
    if (r.icode) return { ...r, item_name: names.get(r.icode) || r.item_text };
    const hit = r.item_key ? found.get(r.item_key) : null;
    return { ...r, icode: hit?.icode || null, item_name: hit?.item_name || null };
  });
}

export async function previewRegistry(fundCode, parsed) {
  const records = await resolveItems(fundCode, parsed.records);
  const unknown = {};
  records.filter((r) => !r.icode).forEach((r) => { unknown[r.item_text] = (unknown[r.item_text] || 0) + 1; });
  return {
    records,
    unknownItems: Object.entries(unknown).map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count),
  };
}

/** นำเข้าทะเบียน: แทนที่รายการของกองทุนนี้ในช่วงวันที่ที่ไฟล์ครอบคลุม */
export async function importRegistry({ fundCode, fileName, parsed, userId }) {
  const { records } = await previewRegistry(fundCode, parsed);
  return withTransaction(async (c) => {
    const { rows: [b] } = await c.query(
      `INSERT INTO registry_batches (fund_code, file_name, date_from, date_to, total_rows, valid_rows, error_rows, errors, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [fundCode, fileName, parsed.dateFrom, parsed.dateTo, parsed.totalRows, records.length, parsed.errorCount,
        JSON.stringify(parsed.errors), userId],
    );
    const { rowCount: replaced } = await c.query(
      'DELETE FROM registry_rows WHERE fund_code = $1 AND service_date BETWEEN $2 AND $3',
      [fundCode, parsed.dateFrom, parsed.dateTo],
    );
    const cols = ['batch_id', 'fund_code', 'row_number', 'service_date', 'hn', 'hn_key', 'cid', 'patient_name',
      'item_text', 'item_key', 'icode', 'item_name', 'qty', 'price'];
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500);
      const params = [];
      const values = chunk.map((r) => `(${cols.map((col) => {
        params.push(col === 'batch_id' ? b.id : col === 'fund_code' ? fundCode : r[col] ?? null);
        return `$${params.length}`;
      }).join(',')})`);
      await c.query(`INSERT INTO registry_rows (${cols.join(',')}) VALUES ${values.join(',')}`, params);
    }
    return { batchId: b.id, inserted: records.length, replaced, unknown: records.filter((r) => !r.icode).length };
  });
}

/** ชื่อรายการที่ยังจับคู่ไม่ได้ ของกองทุนนี้ */
export async function unknownItems(fundCode) {
  const { rows } = await db.query(
    `SELECT MIN(item_text) AS text, item_key, COUNT(*)::int AS count
     FROM registry_rows WHERE fund_code = $1 AND icode IS NULL AND item_key IS NOT NULL
     GROUP BY item_key ORDER BY count DESC`, [fundCode],
  );
  return rows;
}

/** จับคู่ชื่อรายการกับ icode แล้วใช้กับทุกแถวที่ชื่อเดียวกัน (ทุกกองทุน) */
export async function saveAlias({ text: aliasText, icode, itemName, userId }) {
  const key = itemKey(aliasText);
  await db.query(
    `INSERT INTO item_aliases (alias_key, alias_text, icode, item_name, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (alias_key) DO UPDATE SET icode = EXCLUDED.icode, item_name = EXCLUDED.item_name, alias_text = EXCLUDED.alias_text`,
    [key, aliasText, icode, itemName || null, userId],
  );
  const { rowCount } = await db.query(
    'UPDATE registry_rows SET icode = $2, item_name = $3 WHERE item_key = $1 AND icode IS NULL',
    [key, icode, itemName || null],
  );
  return { updated: rowCount };
}

/* =====================================================================
 * เทียบ 3 แหล่ง
 * ===================================================================== */
export const COMPARE_STATUSES = {
  MATCH:           { label: 'ตรงกันครบ 3 แหล่ง' },
  UNKNOWN_ITEM:    { label: 'ยังไม่รู้จักรายการ' },
  NO_VISIT:        { label: 'ไม่พบ visit ใน HOSxP' },
  NOT_CHARGED:     { label: 'ยังไม่ลงค่าบริการใน HOSxP' },
  PRICE_DIFF:      { label: 'ราคาไม่ตรงกัน' },
  DENIED:          { label: 'ส่งเบิกแล้วติด C' },
  NOT_CLAIMED:     { label: 'ยังไม่ส่งเบิก' },
  NOT_PAID:        { label: 'ไม่ได้รับเงินกองทุนนี้' },
  NOT_IN_REGISTRY: { label: 'ไม่อยู่ในทะเบียน' },
};
const ORDER = Object.keys(COMPARE_STATUSES);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
const money = (v) => Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function compareRows(fundCode, range) {
  return withFundTable({ ...range, fund: null, fundCode, onlyClaimable: false }, async (c) => {
    const { rows: [fund] } = await c.query('SELECT code, name, match_mode, track_only FROM funds WHERE code = $1', [fundCode]);
    // ทะเบียน + visit ที่จับคู่ได้ (HN หรือเลขบัตร + วันที่) เลือก visit ที่มีรายการนั้นก่อน
    await c.query(`
      CREATE TEMP TABLE rg ON COMMIT DROP AS
      SELECT r.*, (
        SELECT v.vn FROM his_opd_visits v
        WHERE v.vstdate = r.service_date
          AND ((r.hn_key IS NOT NULL AND ltrim(v.hn, '0') = r.hn_key) OR (r.cid IS NOT NULL AND v.cid = r.cid))
        ORDER BY (r.icode IS NOT NULL AND EXISTS (SELECT 1 FROM his_opd_items i WHERE i.vn = v.vn AND i.icode = r.icode)) DESC, v.vn
        LIMIT 1) AS vn
      FROM registry_rows r
      WHERE r.fund_code = $1 AND r.service_date BETWEEN $2 AND $3`, [fundCode, range.dateFrom, range.dateTo]);
    await c.query('CREATE INDEX ON rg (vn); ANALYZE rg');

    const { rows } = await c.query(`
      SELECT 'REG' AS src, rg.id AS reg_id, rg.service_date::text AS sdate, rg.hn, rg.cid, rg.patient_name,
             rg.icode, COALESCE(rg.item_name, rg.item_text) AS item, rg.item_text, rg.qty AS reg_qty, rg.price AS reg_price,
             rg.vn, v.hn AS his_hn, (hi.vn IS NOT NULL) AS charged, hi.qty AS his_qty, hi.sum_price AS his_price,
             f.fund_status, f.stm_fund_amount, f.error_code, f.tran_id, f.stm_docs,
             COUNT(*) OVER (PARTITION BY rg.vn, rg.icode) AS dup_n
      FROM rg
      LEFT JOIN his_opd_visits v ON v.vn = rg.vn
      LEFT JOIN his_opd_items hi ON hi.vn = rg.vn AND hi.icode = rg.icode
      LEFT JOIN LATERAL (SELECT * FROM fy WHERE fy.vn = rg.vn AND fy.fund_status <> 'RECEIVED' LIMIT 1) f ON TRUE

      UNION ALL
      -- มีใน HOSxP (รายการของกองทุน) แต่ไม่อยู่ในทะเบียน
      SELECT 'HIS', NULL, fy.sdate::text, fy.hn, fy.cid, fy.patient_name, i.icode, COALESCE(i.item_name, fi.item_name), NULL,
             NULL, NULL, fy.vn, fy.hn, TRUE, i.qty, i.sum_price,
             fy.fund_status, fy.stm_fund_amount, fy.error_code, fy.tran_id, fy.stm_docs, 1
      FROM fy
      JOIN his_opd_items i ON i.vn = fy.vn
      JOIN fund_items fi ON fi.fund_code = $1 AND fi.icode = i.icode
      WHERE $2::text = 'items' AND fy.fund_status NOT IN ('RECEIVED')
        AND NOT EXISTS (SELECT 1 FROM rg WHERE rg.vn = fy.vn AND rg.icode = i.icode)

      UNION ALL
      -- ระดับ visit: กองทุนแบบสิทธิ/ICD-10 และรายการที่ REP จ่ายเงินแต่ไม่อยู่ในทะเบียน
      SELECT 'HIS', NULL, fy.sdate::text, fy.hn, fy.cid, fy.patient_name, NULL, fy.items, NULL,
             NULL, NULL, fy.vn, fy.hn, fy.vn IS NOT NULL, NULL, fy.his_fund_amount,
             fy.fund_status, fy.stm_fund_amount, fy.error_code, fy.tran_id, fy.stm_docs, 1
      FROM fy
      WHERE fy.fund_status <> 'RECEIVED'
        AND ($2::text <> 'items' OR fy.fund_status = 'EXTRA_PAID')
        AND NOT EXISTS (SELECT 1 FROM rg WHERE (fy.vn IS NOT NULL AND rg.vn = fy.vn)
                          OR (rg.hn_key = ltrim(fy.hn, '0') AND rg.service_date = fy.sdate))
      ORDER BY 3, 4`, [fundCode, fund?.match_mode || 'items']);

    // ทะเบียนอัปโหลดหลังดึงข้อมูล HOSxP ล่าสุด (รายการใหม่ในทะเบียนอาจยังไม่ถูกดึง)
    const { rows: [st] } = await c.query(`
      SELECT (SELECT MAX(created_at) FROM registry_batches WHERE fund_code = $1) AS uploaded_at,
             (SELECT MIN(pulled) FROM (
                SELECT (SELECT MAX(l.created_at) FROM his_pull_logs l
                         WHERE l.claim_type = 'OPD' AND l.date_from <= d AND l.date_to >= d) AS pulled
                FROM generate_series($2::date, LEAST($3::date, CURRENT_DATE), interval '1 month') d) m) AS pulled_at`,
    [fundCode, range.dateFrom, range.dateTo]);
    return { fund, rows: await annotateErrors(rows), stale: !!(st.uploaded_at && st.pulled_at && st.uploaded_at > st.pulled_at) };
  });
}

/** สรุปสถานะและ "จุดที่ต่าง" ของแต่ละแถว */
function evaluate(r) {
  const issues = [];
  const paid = Number(r.stm_fund_amount || 0) > 0;
  // REP ใช้ "-" แทน "ไม่มีข้อผิดพลาด"
  const err = splitCodes(r.error_code).length ? r.error_code : null;
  let status;
  if (r.src === 'HIS') {
    status = 'NOT_IN_REGISTRY';
    issues.push(r.charged ? 'มีใน HOSxP แต่ไม่อยู่ในทะเบียน' : 'มียอดใน REP แต่ไม่อยู่ในทะเบียนและไม่พบ visit');
    if (paid) issues.push(`REP จ่าย ${money(r.stm_fund_amount)}`);
  } else if (!r.icode) {
    status = 'UNKNOWN_ITEM';
    issues.push(`ยังไม่รู้จักรายการ "${r.item_text}" กรุณาจับคู่กับรายการใน HOSxP`);
  } else if (!r.vn) {
    status = 'NO_VISIT';
    issues.push('ไม่พบ visit ใน HOSxP วันที่นี้ (ตรวจ HN และวันที่ในทะเบียน)');
  } else if (!r.charged) {
    status = 'NOT_CHARGED';
    issues.push('มี visit แต่ยังไม่ลงค่าบริการรายการนี้ใน HOSxP');
  } else {
    const priceOk = r.reg_price == null || near(r.reg_price, r.his_price)
      || (r.reg_qty && near(Number(r.reg_price) * Number(r.reg_qty), r.his_price))
      || (r.his_qty && near(Number(r.reg_price) * Number(r.his_qty), r.his_price));
    if (!priceOk) issues.push(`ราคาไม่ตรง: ทะเบียน ${money(r.reg_price)}, HOSxP ${money(r.his_price)}`);
    if (r.fund_status === 'DENIED' || (err && !paid)) {
      status = 'DENIED';
      issues.push(`ติด C ${err || ''}${r.error_detail ? `: ${r.error_detail.split('\n')[0].replace(/^\w+: /, '')}` : ''}`.trim());
    } else if (!r.fund_status || r.fund_status === 'NOT_SENT') {
      status = 'NOT_CLAIMED';
      issues.push('ยังไม่พบใน REP (ยังไม่ส่งเบิก หรือ REP ยังไม่ออก)');
    } else if (!paid) {
      status = 'NOT_PAID';
      issues.push('พบใน REP แต่ไม่ได้รับเงินกองทุนนี้');
    }
    if (!status) status = priceOk ? 'MATCH' : 'PRICE_DIFF';
    else if (!priceOk && ORDER.indexOf('PRICE_DIFF') < ORDER.indexOf(status)) status = 'PRICE_DIFF';
  }
  if (r.src === 'REG' && Number(r.dup_n) > 1 && r.vn && r.icode) issues.push(`บันทึกซ้ำในทะเบียน ${r.dup_n} แถว`);

  return {
    ...r,
    hn: r.his_hn || r.hn,           // แสดง HN ตาม HOSxP เมื่อจับคู่ได้
    error_code: err,
    status,
    issues: status === 'MATCH' && !issues.length ? ['ตรงกันครบ'] : issues,
    registry: r.src === 'REG' ? { ok: true, amount: r.reg_price } : { ok: false },
    his: !r.vn ? { ok: false, note: 'ไม่พบ visit' }
      : r.charged ? { ok: true, amount: r.his_price }
        : { ok: false, note: status === 'UNKNOWN_ITEM' ? 'ไม่ทราบรายการ' : 'ไม่ได้ลงรายการ' },
    rep: paid ? { ok: true, amount: r.stm_fund_amount }
      : err && r.fund_status !== 'NOT_SENT' ? { ok: false, note: err }
        : { ok: false, note: r.fund_status && r.fund_status !== 'NOT_SENT' ? 'ไม่ได้รับเงิน' : 'ไม่พบ' },
  };
}

/** คอลัมน์ที่กดเรียงได้ในหน้าเทียบ 3 แหล่ง */
const COMPARE_SORT = {
  sdate: (r) => r.sdate, hn: (r) => r.hn, item: (r) => r.item,
  registry: (r) => (r.registry.ok ? Number(r.reg_price ?? 0) : null),
  his: (r) => (r.his.ok ? Number(r.his_price) : null),
  rep: (r) => (r.rep.ok ? Number(r.stm_fund_amount) : null),
  status: (r) => ORDER.indexOf(r.status),
};

export async function compareRegistry({ fundCode, dateFrom, dateTo, status, search, page = 1, pageSize = 50, sort, dir }) {
  const { fund, rows, stale } = await compareRows(fundCode, { dateFrom, dateTo });
  const all = rows.map(evaluate);
  const summary = Object.fromEntries(ORDER.map((k) => [k, 0]));
  all.forEach((r) => { summary[r.status] += 1; });

  const q = search?.trim().toLowerCase();
  const filtered = sortRows(all.filter((r) => (!status || r.status === status)
    && (!q || [r.hn, r.cid, r.vn, r.patient_name, r.item, r.item_text].some((v) => v && String(v).toLowerCase().includes(q)))),
  COMPARE_SORT, { sort, dir });
  const size = Math.min(Math.max(Number(pageSize) || 50, 10), 500);
  const p = Math.max(Number(page) || 1, 1);
  const { rows: [reg] } = await db.query(
    `SELECT COUNT(*)::int AS n, MAX(created_at) AS uploaded_at FROM registry_rows r JOIN registry_batches b ON b.id = r.batch_id
     WHERE r.fund_code = $1 AND r.service_date BETWEEN $2 AND $3`, [fundCode, dateFrom, dateTo],
  );
  return {
    fund,
    summary,
    statuses: COMPARE_STATUSES,
    total: filtered.length,
    page: p,
    pageSize: size,
    rows: filtered.slice((p - 1) * size, p * size),
    registryRows: reg.n,
    registryUploadedAt: reg.uploaded_at,
    unknownItems: (await unknownItems(fundCode)).length,
    stale,
  };
}

export async function exportCompare(opts) {
  const { fund, rows } = await compareRows(opts.fundCode, opts);
  const q = opts.search?.trim().toLowerCase();
  const data = sortRows(rows.map(evaluate)
    .filter((r) => (!opts.status || r.status === opts.status)
      && (!q || [r.hn, r.cid, r.patient_name, r.item].some((v) => v && String(v).toLowerCase().includes(q)))),
  COMPARE_SORT, opts)
    .map((r) => ({
      'ผลการเทียบ': COMPARE_STATUSES[r.status].label,
      'จุดที่ต่าง': r.issues.join(' / '),
      'วันที่ให้บริการ': r.sdate,
      'HN': r.hn,
      'เลขบัตรประชาชน': r.cid,
      'ชื่อ-สกุล': r.patient_name,
      'รายการ': r.item,
      'icode': r.icode,
      'ทะเบียน: ราคา': r.registry.ok ? r.reg_price : null,
      'HOSxP: VN': r.vn,
      'HOSxP: ราคา': r.his.ok ? Number(r.his_price) : null,
      'REP: ยอดกองทุน': r.rep.ok ? Number(r.stm_fund_amount) : null,
      'REP: TRAN_ID': r.tran_id,
      'REP: รหัสข้อผิดพลาด': r.error_code,
      'ผลการแก้ไข / หมายเหตุ': '',
    }));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ 'ผลการเทียบ': 'ไม่มีข้อมูล' }]);
  ws['!cols'] = [22, 50, 12, 11, 15, 22, 30, 10, 12, 14, 12, 14, 14, 12, 28].map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `เทียบ 3 แหล่ง ${fund.code}`.slice(0, 31));
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: data.length };
}

/** ไฟล์แม่แบบทะเบียน: ชีตทะเบียน + ชีตชื่อรายการค่าบริการของกองทุน (คัดลอกชื่อไปใช้) */
export async function registryTemplate(fundCode) {
  const { rows: items } = await db.query(
    'SELECT item_name FROM fund_items WHERE fund_code = $1 AND item_name IS NOT NULL ORDER BY item_name', [fundCode],
  );
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['วันที่ให้บริการ', 'HN', 'เลขบัตรประชาชน', 'ชื่อ-สกุล', 'รายการค่าบริการ', 'ราคา'],
    ['15/09/2569', '0001234', '1234567890123', 'ตัวอย่าง (ลบแถวนี้)', items[0]?.item_name || 'ชื่อรายการ', 350],
  ]);
  ws['!cols'] = [14, 10, 16, 24, 36, 10].map((w) => ({ wch: w }));
  // HN และเลขบัตรเป็นข้อความ เลข 0 ด้านหน้าไม่หาย และเลขบัตรไม่กลายเป็น 1.23E+12
  ['B', 'C'].forEach((col) => {
    for (let r = 1; r <= 2000; r += 1) {
      const addr = `${col}${r + 1}`;
      if (ws[addr]) { ws[addr].t = 's'; ws[addr].v = String(ws[addr].v); ws[addr].z = '@'; } else ws[addr] = { t: 's', v: '', z: '@' };
    }
  });
  ws['!ref'] = 'A1:F2001';
  XLSX.utils.book_append_sheet(wb, ws, 'ทะเบียน');
  const list = XLSX.utils.aoa_to_sheet([['ชื่อรายการค่าบริการของกองทุน'], ...items.map((i) => [i.item_name])]);
  list['!cols'] = [{ wch: 50 }];
  XLSX.utils.book_append_sheet(wb, list, 'รายการค่าบริการ');
  const help = XLSX.utils.aoa_to_sheet([
    ['วิธีกรอก'],
    ['หนึ่งแถว = หนึ่งบริการ ถ้า visit เดียวให้ 2 รายการ ให้ลง 2 แถว'],
    ['วันที่ให้บริการ: วัน/เดือน/ปี พ.ศ. เช่น 15/09/2569 (วันที่ให้บริการจริง ไม่ใช่วันที่ลงบันทึก)'],
    ['HN และเลขบัตรประชาชน: ตั้งรูปแบบเซลล์เป็นข้อความไว้แล้ว เลข 0 ด้านหน้าจะไม่หาย และเลขบัตรไม่กลายเป็น 1.23E+12'],
    ['ระบบจับคู่คนไข้ด้วย HN + วันที่ ถ้ามีเลขบัตรประชาชน จะใช้จับคู่ด้วย (กรณี HN พิมพ์ผิดหรือคนไข้มีหลาย HN)'],
    ['รายการค่าบริการ: แนะนำให้คัดลอกชื่อจากชีต "รายการค่าบริการ" ชื่ออื่นที่ระบบไม่รู้จักจะให้ผู้รับผิดชอบจับคู่ครั้งเดียว'],
    ['ราคา: ราคารวมของรายการนั้นใน visit นั้น'],
  ]);
  help['!cols'] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(wb, help, 'วิธีกรอก');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
