import { db, hosxp, withTransaction } from '../config/db.js';

/**
 * ดึงข้อมูล OPD จาก HOSxP v4 (PostgreSQL)
 * หมายเหตุ: ชื่อตาราง/ฟิลด์อ้างอิงโครงสร้างมาตรฐานของ HOSxP
 * หากรพ.ปรับแต่งโครงสร้าง ให้ตรวจด้วย \d vn_stat แล้วแก้ query ที่นี่ที่เดียว
 */
const OPD_SQL = `
  SELECT v.vn,
         v.hn,
         p.cid,
         CONCAT(p.pname, p.fname, ' ', p.lname) AS ptname,
         v.vstdate::text      AS vstdate,
         v.pttype,
         t.name               AS pttype_name,
         t.hipdata_code,
         v.pdx,
         COALESCE(v.income, 0)   AS income,
         COALESCE(v.uc_money, 0) AS uc_money
  FROM vn_stat v
  LEFT JOIN patient p ON p.hn = v.hn
  LEFT JOIN pttype  t ON t.pttype = v.pttype
  WHERE v.vstdate BETWEEN $1 AND $2
`;

/**
 * รายการค่าใช้จ่ายของ visit (opitemrece) เฉพาะ icode ที่ตั้งค่าในกองทุน
 * opitemrece เก็บทั้งค่าบริการ (nondrugitems) และยา (drugitems) ด้วย icode
 */
const ITEMS_SQL = `
  SELECT o.vn, o.icode, MIN(o.vstdate)::text AS vstdate,
         SUM(COALESCE(o.qty, 0))       AS qty,
         SUM(COALESCE(o.sum_price, 0)) AS sum_price
  FROM opitemrece o
  WHERE o.vstdate BETWEEN $1 AND $2
    AND o.vn IS NOT NULL AND o.vn <> ''
    AND o.icode = ANY($3::text[])
  GROUP BY o.vn, o.icode
`;

/**
 * เงื่อนไข "ใช้งานอยู่" ของตารางหลักใน HOSxP
 * ใช้กับรายการให้เลือกตอนตั้งค่าเท่านั้น (ค่าบริการ / ยา / สิทธิ) ไม่ใช้กับค่าใช้จ่ายย้อนหลังใน opitemrece
 * เพราะรายการที่เลิกใช้วันนี้ อาจเคยถูกคิดเงินจริงในช่วงเวลาที่ตรวจ
 * ถ้า HOSxP ของรพ.ใช้ชื่อคอลัมน์อื่น (เช่น istatus, isuse) แก้ที่นี่ที่เดียว
 */
const ACTIVE = {
  nondrug: "n.istatus = 'Y'",
  drug: "d.istatus = 'Y'",
  pttype: "p.isuse = 'Y'",
};

/** ค้นหารายการหลักจาก HOSxP เพื่อเลือกตอนตั้งค่ากองทุน */
const SEARCH_SQL = {
  nondrug: `
    SELECT n.icode, n.name, n.price
    FROM nondrugitems n
    WHERE ${ACTIVE.nondrug}
      AND (n.icode ILIKE $1 || '%' OR n.name ILIKE '%' || $1 || '%')
    ORDER BY n.name LIMIT 50`,
  drug: `
    SELECT d.icode, CONCAT_WS(' ', d.name, d.strength) AS name, NULL::numeric AS price
    FROM drugitems d
    WHERE ${ACTIVE.drug}
      AND (d.icode ILIKE $1 || '%' OR d.name ILIKE '%' || $1 || '%')
    ORDER BY d.name LIMIT 50`,
};

export async function searchItems(source, q) {
  const { rows } = await hosxp.query(SEARCH_SQL[source], [q]);
  return rows.map((r) => ({ ...r, source }));
}

/** รายการสิทธิการรักษาที่ใช้งานอยู่ สำหรับตั้งค่าเงื่อนไขกองทุน */
export async function listPttypes() {
  const { rows } = await hosxp.query(`
    SELECT p.pttype, p.name, p.hipdata_code
    FROM pttype p
    WHERE ${ACTIVE.pttype}
    ORDER BY p.hipdata_code NULLS LAST, p.pttype`);
  return rows;
}

const ITEM_COLS = ['vn', 'icode', 'vstdate', 'qty', 'sum_price'];

const COLS = ['vn', 'hn', 'cid', 'ptname', 'vstdate', 'pttype', 'pttype_name', 'hipdata_code', 'pdx', 'income', 'uc_money'];
const CHUNK = 1000;

export async function testHosxpConnection() {
  const { rows } = await hosxp.query('SELECT current_database() AS db, version() AS version');
  return rows[0];
}

/** แบ่งช่วงวันที่เป็นรายเดือน เช่น 2025-10-15..2026-01-10 -> [10/15-10/31, 11/01-11/30, ...] */
export function splitByMonth(dateFrom, dateTo) {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const parts = [];
  let [y, m, d] = dateFrom.split('-').map(Number);
  while (iso(y, m, d) <= dateTo) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = iso(y, m, lastDay) < dateTo ? iso(y, m, lastDay) : dateTo;
    parts.push([iso(y, m, d), end]);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    d = 1;
  }
  return parts;
}

async function replaceSnapshot(client, dateFrom, dateTo, visits) {
  await client.query('DELETE FROM his_opd_visits WHERE vstdate BETWEEN $1 AND $2', [dateFrom, dateTo]);
  for (let i = 0; i < visits.length; i += CHUNK) {
    const chunk = visits.slice(i, i + CHUNK);
    const params = [];
    const values = chunk.map((v) => {
      const ph = COLS.map((c) => {
        params.push(c === 'cid' && v.cid ? String(v.cid).trim() : v[c]);
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    await client.query(
      `INSERT INTO his_opd_visits (${COLS.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (vn) DO UPDATE SET ${COLS.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
         pulled_at = now()`,
      params,
    );
  }
}

/**
 * ดึงข้อมูลช่วงวันที่ แล้วแทนที่ snapshot เดิมของช่วงนั้น (รายการที่ถูกยกเลิกใน HOSxP จะหายไปด้วย)
 * ช่วงยาว เช่น 1 ปีงบประมาณ จะดึงทีละเดือน เพื่อไม่ให้ query บน HOSxP หนักและไม่ใช้หน่วยความจำมาก
 * แต่ละเดือนบันทึกแยก transaction ถ้าล้มกลางทาง เดือนที่สำเร็จแล้วยังอยู่ กดดึงซ้ำได้
 */
async function replaceItems(client, dateFrom, dateTo, items) {
  await client.query('DELETE FROM his_opd_items WHERE vstdate BETWEEN $1 AND $2', [dateFrom, dateTo]);
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const params = [];
    const values = chunk.map((it) => `(${ITEM_COLS.map((c) => { params.push(it[c]); return `$${params.length}`; }).join(',')})`);
    await client.query(
      `INSERT INTO his_opd_items (${ITEM_COLS.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (vn, icode) DO UPDATE SET vstdate = EXCLUDED.vstdate, qty = EXCLUDED.qty,
         sum_price = EXCLUDED.sum_price, pulled_at = now()`,
      params,
    );
  }
}

export async function pullOpd({ dateFrom, dateTo, userId }) {
  const months = splitByMonth(dateFrom, dateTo);
  let rowCount = 0;
  let itemCount = 0;

  // icode ทั้งหมดที่ตั้งค่าไว้ในกองทุนที่เปิดใช้งาน
  const { rows: icodeRows } = await db.query(
    `SELECT DISTINCT fi.icode FROM fund_items fi JOIN funds f ON f.code = fi.fund_code WHERE f.is_active`,
  );
  const icodes = icodeRows.map((r) => r.icode);

  for (const [from, to] of months) {
    const { rows: visits } = await hosxp.query(OPD_SQL, [from, to]);
    const items = icodes.length ? (await hosxp.query(ITEMS_SQL, [from, to, icodes])).rows : [];
    await withTransaction(async (client) => {
      await replaceSnapshot(client, from, to, visits);
      await replaceItems(client, from, to, items);
    });
    rowCount += visits.length;
    itemCount += items.length;
  }

  await withTransaction((client) => client.query(
    `INSERT INTO his_pull_logs (claim_type, date_from, date_to, row_count, pulled_by)
     VALUES ('OPD', $1, $2, $3, $4)`,
    [dateFrom, dateTo, rowCount, userId],
  ));
  return { rowCount, itemCount, months: months.length };
}
