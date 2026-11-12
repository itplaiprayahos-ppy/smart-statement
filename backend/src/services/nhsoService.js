import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { db } from '../config/db.js';
import { parseExcel } from './excelParser.js';
import { saveImport } from './importService.js';
import { zipSync } from 'fflate';

/**
 * อ่านรายการไฟล์ REP จากเว็บ e-Claim (สปสช.) ผ่านเบราว์เซอร์จริง — ระยะที่ 1: "อ่านรายการเท่านั้น ยังไม่ดาวน์โหลด"
 *
 * หลักการ
 *  - เปิดเบราว์เซอร์แบบมีหน้าต่าง (Edge/Chrome ที่ติดตั้งในเครื่อง) ให้ผู้ใช้สแกน ThaiD ล็อกอินเอง
 *    ระบบไม่รับ ไม่เก็บ ไม่กรอกรหัสผ่าน และไม่มีการเก็บเซสชัน/คุกกี้ลงดิสก์ (ใช้ context ชั่วคราว)
 *  - หลังล็อกอิน เปิดหน้า REP ครั้งเดียว เลือกเดือน/ปี อ่านตาราง ไม่วนหลายหน้า ไม่ดาวน์โหลดไฟล์
 *  - เปิดได้ครั้งละ 1 เซสชัน และปิดอัตโนมัติเมื่อเกินเวลา
 *  - ต้องรันบนเครื่องที่มีหน้าจอ (ไม่ใช่ Docker ที่ไม่มีจอ)
 */

const BASE_URL = (process.env.NHSO_BASE_URL || 'https://eclaim.nhso.go.th').replace(/\/$/, '');
const BROWSER_CHANNEL = process.env.NHSO_BROWSER_CHANNEL || 'msedge'; // msedge | chrome
const LOGIN_URL = `${BASE_URL}/webComponent/main/MainWebAction.do`;
/** สิทธิที่รองรับ: key = ค่า maininscl ในลิงก์ e-Claim, code = รหัสใช้ตั้งชื่อไฟล์ zip (สิทธิอื่นนอกจาก ucs ยังไม่ได้ทดสอบกับของจริง) */
export const INSCLS = {
  ucs: { code: 'UC', label: 'สิทธิหลักประกันสุขภาพถ้วนหน้า' },
  ofc: { code: 'OFC', label: 'สิทธิข้าราชการ' },
  sss: { code: 'SSS', label: 'สิทธิประกันสังคม' },
  lgo: { code: 'LGO', label: 'สิทธิกองทุนบุคลากรองค์การปกครองส่วนท้องถิ่น (อปท.)' }, // maininscl=lgo เดาตามรูปแบบลิงก์อื่น ยังไม่ยืนยัน
  bkk: { code: 'BKK', label: 'สิทธิเจ้าหน้าที่กรุงเทพมหานคร' },
  srt: { code: 'SRT', label: 'สิทธิเจ้าหน้าที่การรถไฟแห่งประเทศไทย' },
};
const repUrl = (inscl) => `${BASE_URL}/webComponent/validation/ValidationMainAction.do?maininscl=${inscl}`;

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // รอสแกน ThaiD
const minutesEnv = (name, def) => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n >= 1 ? n : def) * 60 * 1000;
};
const SESSION_MAX_MS = minutesEnv('NHSO_SESSION_MAX_MIN', 20); // อายุสูงสุดของเซสชัน (นาที)
const IDLE_MAX_MS = minutesEnv('NHSO_IDLE_MAX_MIN', 10);       // ไม่มีการใช้งานเกินนี้ ปิดเซสชันเอง
const AFTER_IMPORT_IDLE_MS = 5 * 60 * 1000;                    // หลังนำเข้าเสร็จ ปิดเร็วขึ้น (ยังดึงเดือน/สิทธิอื่นต่อได้โดยไม่สแกนใหม่)
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;                   // เท่ากับขีดจำกัดอัปโหลดของระบบ
const EXCEL_ORIGIN = new URL(BASE_URL).origin;                 // ดาวน์โหลดได้จากโดเมน e-Claim เท่านั้น
const POLL_MS = 2000;

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** เซสชันที่ใช้งานอยู่ (ครั้งละ 1) */
let current = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function publicView(s, verbose = false) {
  if (!s) return null;
  // ส่งเฉพาะที่หน้าจอใช้ ไม่ส่งลิงก์ดาวน์โหลด ชื่อผู้นำเข้า หมายเหตุ
  const files = (s.files || []).map((f) => ({
    repNo: f.repNo, sentAt: f.sentAt, fileName: f.fileName, type: f.type,
    total: f.total, passed: f.passed, failed: f.failed, imported: f.imported, hasExcel: Boolean(f.excelUrl),
  }));
  return {
    id: s.id,
    status: s.status,
    message: s.message,
    type: s.type,
    inscl: s.inscl,
    month: s.month,
    year: s.year,
    startedAt: s.startedAt,
    files,
    summary: s.summary || null,
    importResults: s.importResults || null,
    downloadedCount: s.downloads?.length || 0,
    // รายการหน้าที่เบราว์เซอร์เปิดอยู่ (มี URL ธุรกรรม ThaiD) แสดงเฉพาะสคริปต์ทดสอบในเครื่อง ไม่ส่งให้ผู้ใช้เว็บ
    debug: s.debug ? (verbose ? s.debug : { rows: s.debug.rows, skipped: s.debug.skipped, duplicatesDropped: s.debug.duplicatesDropped }) : null,
  };
}

async function closeSession(s, status = 'closed', message) {
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.downloads = null; // ปล่อยไฟล์ในหน่วยความจำ
  s.status = status;
  if (message) s.message = message;
  const browser = s.browser;
  s.browser = null;
  s.page = null;
  if (browser) await browser.close().catch(() => {});
}

/**
 * เซสชันผูกกับผู้ใช้ที่เริ่ม (ownerId) เท่านั้น ผู้ใช้อื่นเห็นเป็น "ไม่พบ" แม้รู้ id
 * ownerId === undefined = เรียกจากสคริปต์ในเครื่อง (ไม่ผ่านเว็บ) ไม่ตรวจเจ้าของ
 */
const owns = (s, ownerId) => ownerId === undefined || s.ownerId === undefined || s.ownerId === ownerId;

/** ต่อเวลาเมื่อมีการใช้งาน ถ้าไม่มีการใช้งานนานเกินกำหนด ปิดเซสชัน/เบราว์เซอร์เอง */
function touch(s, ms = IDLE_MAX_MS) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => closeSession(s, 'closed', `ปิดเซสชันเพราะไม่มีการใช้งาน (${Math.round(ms / 60000)} นาที)`), ms);
}

export function getSession(id, ownerId) {
  if (!current || current.id !== id || !owns(current, ownerId)) return null;
  touch(current);
  return publicView(current, ownerId === undefined);
}

export async function stopSession(id, ownerId) {
  if (!current || current.id !== id || !owns(current, ownerId)) return false;
  await closeSession(current, 'closed', 'ปิดเซสชันแล้ว');
  return true;
}

/** เริ่มเซสชัน: เปิดเบราว์เซอร์ที่หน้าล็อกอิน แล้วทำงานต่อเบื้องหลัง (ผู้เรียกโพลสถานะเอง) */
export async function startSession({ type, month, year, ownerId, inscl = 'ucs' }) {
  if (!INSCLS[inscl]) throw Object.assign(new Error('สิทธิไม่ถูกต้อง'), { status: 400 });
  if (current && ['starting', 'waiting_login', 'listing', 'importing'].includes(current.status)) {
    const err = new Error('มีเซสชันดึงไฟล์ที่กำลังทำงานอยู่ ปิดอันเดิมก่อน');
    err.status = 409;
    throw err;
  }
  if (current) await closeSession(current);

  const s = {
    id: randomUUID(), status: 'starting', message: 'กำลังเปิดเบราว์เซอร์', type, month, year, inscl,
    startedAt: new Date().toISOString(), files: [], browser: null, page: null, ownerId,
  };
  current = s;
  touch(s);
  s.timer = setTimeout(() => closeSession(s, 'closed', `เซสชันหมดเวลา (${Math.round(SESSION_MAX_MS / 60000)} นาที)`), SESSION_MAX_MS);

  try {
    s.browser = await chromium.launch({ channel: BROWSER_CHANNEL, headless: false, args: ['--disable-extensions', '--no-first-run'] });
  } catch (err) {
    await closeSession(s, 'error', `เปิดเบราว์เซอร์ไม่ได้ (${BROWSER_CHANNEL}) ต้องรันบนเครื่องที่มีหน้าจอและติดตั้ง Edge/Chrome: ${err.message.split('\n')[0]}`);
    return publicView(s);
  }
  s.browser.on('disconnected', () => {
    if (s.status !== 'ready' && s.status !== 'error') s.status = 'closed';
    s.message = s.message || 'ปิดหน้าต่างเบราว์เซอร์แล้ว';
    s.browser = null;
    s.page = null;
  });

  // ทำงานเบื้องหลัง ไม่รอใน request
  run(s).catch((err) => closeSession(s, 'error', `เกิดข้อผิดพลาด: ${err.message.split('\n')[0]}`));
  return publicView(s);
}

/**
 * ดึงรายการไฟล์ใหม่ (เปลี่ยนสิทธิ/เดือน/ปี) ในเซสชันเดิมที่ล็อกอินอยู่แล้ว ไม่ต้องสแกน ThaiD ใหม่
 * ใช้ได้เมื่อเบราว์เซอร์ยังเปิดอยู่ และสถานะ ready / imported เท่านั้น ทำงานเบื้องหลัง ผู้เรียกโพลสถานะเอง
 */
export async function relistSession(id, ownerId, { type = 'REP', inscl = 'ucs', month, year }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (!INSCLS[inscl]) throw fail(400, 'สิทธิไม่ถูกต้อง');
  const s = current && current.id === id && owns(current, ownerId) ? current : null;
  if (!s || !s.browser || !s.context) throw fail(404, 'ไม่พบเซสชันที่ล็อกอินอยู่ (ต้องเริ่มใหม่และสแกน ThaiD)');
  if (!['ready', 'imported', 'error'].includes(s.status) || !s.page) throw fail(409, 'เซสชันยังไม่พร้อมดึงรายการใหม่');

  touch(s);
  Object.assign(s, { type, inscl, month, year, status: 'listing', message: 'กำลังอ่านรายการไฟล์ REP', files: [], summary: null, importResults: null, downloads: null });
  (async () => {
    const page = s.page;
    await page.goto(repUrl(inscl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // เซสชันหมดอายุที่ฝั่ง e-Claim: หน้าจะเด้งกลับไปหน้าล็อกอิน (หาช่องเลือกเดือน/ปีไม่เจอ)
    await selectMonthYear(page, month, year);
    const parsed = await readTable(page);
    s.debug = parsed.debug;
    s.files = parsed.files;
    await markImported(s);
    s.status = s.files.length ? 'ready' : 'error';
    s.message = s.files.length
      ? `พบ ${s.files.length} ไฟล์ (OP ใหม่ ${s.summary.newOp})`
      : 'อ่านตารางไม่พบรายการ (เดือนนี้อาจไม่มีไฟล์ หรือเซสชัน e-Claim หมดอายุ ให้เริ่มใหม่และสแกน ThaiD)';
  })().catch((err) => {
    s.status = 'error';
    s.message = `ดึงรายการไม่สำเร็จ: ${String(err.message || err).split('\n')[0]} (ถ้าเซสชัน e-Claim หมดอายุ ให้เริ่มใหม่และสแกน ThaiD)`;
  });
  return publicView(s);
}

/**
 * ตรวจว่าล็อกอินแล้วหรือยัง: หาข้อความ "Log out" / "ออกจากระบบ" ในทุกแท็บและทุกเฟรมของเบราว์เซอร์
 * (หลังสแกน ThaiD เว็บอาจเปิดแท็บใหม่ หรือหน้า e-Claim อาจอยู่ในเฟรม)
 * คืน { page, seen } — page = แท็บที่ล็อกอินแล้ว, seen = ข้อมูลช่วยดีบัก (url + ข้อความต้นหน้า)
 */
async function findLoggedIn(context) {
  const seen = [];
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      let text = '';
      try {
        text = await frame.evaluate(() => document.body?.innerText || '');
      } catch {
        continue; // กำลังเปลี่ยนหน้า
      }
      seen.push({ url: frame.url().slice(0, 120), text: text.replace(/\s+/g, ' ').slice(0, 80) });
      if (/log\s*out|ออกจากระบบ/i.test(text)) return { page, seen };
    }
  }
  return { page: null, seen };
}

async function run(s) {
  const context = await s.browser.newContext({ locale: 'th-TH', viewport: { width: 1280, height: 860 } });
  s.context = context;
  const page = await context.newPage();
  s.page = page;
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // 1) รอผู้ใช้สแกน ThaiD
  s.status = 'waiting_login';
  s.message = 'กรุณาสแกน QR ด้วยแอป ThaiD ในหน้าต่างเบราว์เซอร์ที่เปิดขึ้น';
  const loginDeadline = Date.now() + LOGIN_TIMEOUT_MS;
  let workPage = null;
  for (;;) {
    if (!s.browser) return; // ผู้ใช้ปิดหน้าต่าง
    const found = await findLoggedIn(context);
    s.debug = { waitingFor: 'ข้อความ "Log out" / "ออกจากระบบ" ในหน้าใดหน้าหนึ่ง', pages: found.seen };
    if (found.page) { workPage = found.page; break; }
    if (Date.now() > loginDeadline) { await closeSession(s, 'error', 'หมดเวลารอล็อกอิน (5 นาที)'); return; }
    await sleep(POLL_MS);
  }

  // 2) เปิดหน้า REP เลือกเดือน/ปี แล้วอ่านตาราง
  s.status = 'listing';
  s.message = 'ล็อกอินแล้ว กำลังอ่านรายการไฟล์ REP';
  s.page = workPage;
  await workPage.goto(repUrl(s.inscl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await selectMonthYear(workPage, s.month, s.year);
  const parsed = await readTable(workPage);
  s.debug = parsed.debug;
  s.files = parsed.files;

  await markImported(s);
  s.status = s.files.length ? 'ready' : 'error';
  s.message = s.files.length
    ? `พบ ${s.files.length} ไฟล์ (OP ใหม่ ${s.summary.newOp})`
    : 'อ่านตารางไม่พบรายการ ดูรายละเอียดในช่อง debug (อาจเลือกเดือนไม่ได้หรือโครงสร้างหน้าเปลี่ยน)';
}

/** เลือกเดือน/ปีในฟอร์ม แล้วกด "แสดงข้อมูล" */
async function selectMonthYear(page, month, year) {
  const monthName = TH_MONTHS[month - 1];
  const picked = await page.evaluate(({ monthName, year }) => {
    const out = { month: false, year: false };
    for (const sel of document.querySelectorAll('select')) {
      const opts = [...sel.options];
      const m = opts.findIndex((o) => o.text.trim() === monthName);
      if (m >= 0) { sel.selectedIndex = m; sel.dispatchEvent(new Event('change', { bubbles: true })); out.month = true; continue; }
      const y = opts.findIndex((o) => o.text.trim() === String(year) || o.value === String(year));
      if (y >= 0) { sel.selectedIndex = y; sel.dispatchEvent(new Event('change', { bubbles: true })); out.year = true; }
    }
    return out;
  }, { monthName, year });
  if (!picked.month || !picked.year) throw new Error(`ไม่พบช่องเลือกเดือน/ปีในหน้า REP (month=${picked.month}, year=${picked.year})`);

  const btn = page.getByRole('button', { name: /แสดงข้อมูล/ }).first();
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {}),
    btn.click({ timeout: 15_000 }),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
}

/**
 * อ่านตารางรายการไฟล์ (ไม่ดาวน์โหลด)
 * หัวตารางของ e-Claim มีหลายชั้น/รวมเซลล์ ทำให้ตำแหน่งคอลัมน์จากหัวตารางไม่ตรงกับแถวข้อมูล
 * จึงหาแถวข้อมูลจากเซลล์ "ชื่อไฟล์ .ecd" แล้วอ่านคอลัมน์อื่นตามตำแหน่งสัมพัทธ์ (ลำดับคอลัมน์ในหน้า e-Claim คงที่)
 *   วันที่ส่ง · ลำดับที่(เลข REP) · รหัส รพ. · ชื่อ รพ. · File · จำนวน · ผ่าน · ไม่ผ่าน · ประเภทการนำเข้า
 *   · ตรวจสอบแล้ววันที่ · ชื่อผู้นำเข้า · หมายเหตุ · Rep File · Excel File
 */
async function readTable(page) {
  return page.evaluate(() => {
    const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const tables = [...document.querySelectorAll('table')];
    const debug = { tables: tables.length, rows: 0, sampleCells: null, skipped: 0 };
    const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const isFileCell = (t) => /\.ecd$/i.test(t) && /eclaim/i.test(t);

    const files = [];
    for (const table of tables) {
      for (const r of table.querySelectorAll('tr')) {
        const cells = [...r.children];
        const texts = cells.map((c) => clean(c.innerText));
        // ชื่อไฟล์อยู่ในเซลล์ของตัวเอง (ไม่ใช่ลิงก์ Rep File ที่ขึ้นต้นด้วย rep_)
        const f = texts.findIndex((t) => isFileCell(t) && !/^rep_/i.test(t));
        if (f < 4) { if (texts.some(isFileCell)) debug.skipped += 1; continue; }
        const at = (k) => texts[f + k] ?? '';
        const links = [...r.querySelectorAll('a')].map((a) => ({ text: clean(a.innerText), href: a.href }));
        const excel = links.find((l) => /excel/i.test(l.text));
        const repFile = links.find((l) => /^rep_/i.test(l.text) || /\.ecd$/i.test(l.text));
        const fileName = texts[f];
        const m = fileName.match(/_(OP|IP)[A-Z]*_/i); // eclaim_11344_OP_... (UCS) หรือ eclaim_11344_OPCS_... (สิทธิอื่น: ตัวอักษรต่อท้ายบอกสิทธิ)
        if (!debug.sampleCells) debug.sampleCells = texts.map((t) => t.slice(0, 40));
        files.push({
          repNo: texts[f - 3] || '',
          sentAt: texts[f - 4] || '',
          hcode: texts[f - 2] || '',
          fileName,
          type: m ? m[1].toUpperCase() : null,
          total: num(at(1)),
          passed: num(at(2)),
          failed: num(at(3)),
          importType: at(4),
          checkedAt: at(5),
          importer: at(6),
          note: at(7),
          excelUrl: excel?.href || null,
          repFileUrl: repFile?.href || null,
        });
      }
    }
    const seen = new Set();
    const unique = files.filter((f) => (seen.has(f.fileName) ? false : seen.add(f.fileName)));
    debug.rows = unique.length;
    debug.duplicatesDropped = files.length - unique.length;
    return { files: unique, debug };
  });
}


/**
 * ติดป้ายว่าไฟล์ไหนนำเข้าแล้ว: เทียบเลขที่ REP กับ nhso_lines และเทียบชื่อไฟล์กับประวัติการนำเข้า (import_batches)
 * (ค่า rep_no ในไฟล์อาจมีคำนำหน้า/ต่อท้าย จึงเทียบแบบ "มีเลขนั้นอยู่ในค่า")
 */
async function markImported(s) {
  const { rows: repRows } = await db.query('SELECT DISTINCT rep_no FROM nhso_lines WHERE rep_no IS NOT NULL');
  const repList = repRows.map((r) => String(r.rep_no));
  const { rows: batchRows } = await db.query("SELECT file_name FROM import_batches WHERE file_type = 'REP'");
  const batchNames = batchRows.map((r) => String(r.file_name).toLowerCase());
  const baseOf = (f) => String(f.fileName).replace(/\.ecd$/i, '').toLowerCase();
  s.files.forEach((f) => {
    const byRep = Boolean(f.repNo) && repList.some((h) => h === f.repNo || h.includes(f.repNo) || (h.length >= 6 && f.repNo.includes(h)));
    const byName = batchNames.some((n) => n.includes(baseOf(f)));
    f.imported = byRep || byName;
  });
  const op = s.files.filter((f) => f.type === 'OP');
  s.summary = {
    total: s.files.length,
    op: op.length,
    ip: s.files.filter((f) => f.type === 'IP').length,
    newOp: op.filter((f) => !f.imported).length,
    imported: s.files.filter((f) => f.imported).length,
  };
}

/** รูปแบบไฟล์ REP ที่ใช้อ่านไฟล์จาก e-Claim (ค่าเริ่มต้น "e-Claim REP OPD") */
async function loadRepProfile() {
  const { rows } = await db.query(
    `SELECT * FROM column_mappings WHERE file_type = 'REP' AND is_active
     ORDER BY (name ILIKE '%REP OPD%') DESC, id LIMIT 1`,
  );
  if (!rows[0]) throw new Error('ไม่พบรูปแบบไฟล์ REP ที่ใช้งานอยู่ (ตั้งค่าที่เมนู "รูปแบบไฟล์ Excel")');
  return rows[0];
}

const DOWNLOAD_GAP_MS = 2000; // หน่วงระหว่างไฟล์ ไม่ยิงถี่
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_KEEP_BYTES = 150 * 1024 * 1024; // เก็บไฟล์ที่โหลดไว้ในหน่วยความจำเพื่อให้บันทึกเป็น zip ได้ ไม่เกินเท่านี้

/** รวมไฟล์ที่ดาวน์โหลดในเซสชันเป็น zip (null ถ้าไม่มีไฟล์) ใช้โหมดเก็บเฉยๆ เพราะ xlsx บีบอัดอยู่แล้ว */
export function zipDownloads(id, ownerId) {
  if (!current || current.id !== id || !owns(current, ownerId) || !current.downloads?.length) return null;
  touch(current, AFTER_IMPORT_IDLE_MS);
  // ชื่อไฟล์ zip: ประเภท_สิทธิ_ปีเดือน (พ.ศ. ตามที่เลือกในหน้าเว็บ) เช่น REP_UC_256903 (ตอนนี้ดึงเฉพาะสิทธิ UCS)
  const zipName = `${current.type || 'REP'}_${INSCLS[current.inscl]?.code || 'UC'}_${current.year}${String(current.month).padStart(2, '0')}.zip`;
  const used = new Map();
  const entries = {};
  for (const { fileName, buffer } of current.downloads) {
    const safe = String(fileName).replace(/[\\/:*?"<>|]/g, '_');
    const n = (used.get(safe) || 0) + 1;
    used.set(safe, n);
    entries[n > 1 ? safe.replace(/(\.[^.]+)?$/, `_${n}$1`) : safe] = [new Uint8Array(buffer), { level: 0 }];
  }
  return { name: zipName, data: Buffer.from(zipSync(entries)) };
}

/** ดาวน์โหลดไฟล์ Excel ผ่านเซสชันที่ล็อกอินอยู่ (อยู่ในหน่วยความจำ ไม่เขียนลงดิสก์) */
async function downloadExcel(s, f) {
  if (new URL(f.excelUrl).origin !== EXCEL_ORIGIN) throw new Error('ลิงก์ดาวน์โหลดไม่ได้อยู่ในโดเมน e-Claim จึงไม่ดาวน์โหลด');
  const resp = await s.context.request.get(f.excelUrl, { timeout: 90_000, maxRedirects: 3 });
  if (!resp.ok()) throw new Error(`ดาวน์โหลดไม่ได้ (HTTP ${resp.status()})`);
  if (new URL(resp.url()).origin !== EXCEL_ORIGIN) throw new Error('ถูกส่งต่อไปโดเมนอื่น จึงยกเลิกการดาวน์โหลด');
  const buffer = await resp.body();
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('ไฟล์ใหญ่เกิน 30 MB');
  const head = buffer.subarray(0, 4);
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // .xlsx
  const isOle = head[0] === 0xd0 && head[1] === 0xcf; // .xls
  if (!isZip && !isOle) {
    throw new Error('ได้ไฟล์ที่ไม่ใช่ Excel (เซสชันอาจหมดอายุ ให้เริ่มดึงใหม่และสแกน ThaiD อีกครั้ง)');
  }
  const cd = resp.headers()['content-disposition'] || '';
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
  const base = String(f.fileName).replace(/\.ecd$/i, '');
  let fileName = `rep_${base}${isZip ? '.xlsx' : '.xls'}`;
  if (named) {
    try { fileName = decodeURIComponent(named); } catch { fileName = named; }
  }
  return { buffer, fileName };
}

/**
 * ดาวน์โหลดและนำเข้าไฟล์ที่เลือก (เฉพาะ OP ที่ยังไม่นำเข้า) ทีละไฟล์ แล้วรายงานผลรายไฟล์
 * ทำงานเบื้องหลัง ผู้เรียกโพลสถานะจาก getSession (status: importing -> imported)
 */
export async function startImport(id, { repNos, userId, onFinish }) {
  const s = current && current.id === id && owns(current, userId ?? undefined) ? current : null;
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  if (!s) throw fail(404, 'ไม่พบเซสชัน (อาจถูกปิดแล้ว)');
  if (!['ready', 'imported'].includes(s.status)) throw fail(409, 'เซสชันยังไม่พร้อมนำเข้า (ต้องอ่านรายการไฟล์เสร็จก่อน)');
  const want = new Set(repNos.map(String));
  const targets = s.files.filter((f) => want.has(f.repNo));
  const notFound = [...want].filter((no) => !targets.some((f) => f.repNo === no));
  if (notFound.length) throw fail(400, `ไม่พบเลขที่ REP ในรายการ: ${notFound.join(', ')}`);
  const bad = targets.filter((f) => f.type !== 'OP' || !f.excelUrl);
  if (bad.length) throw fail(400, `นำเข้าได้เฉพาะไฟล์ OP ที่มีลิงก์ Excel: ${bad.map((f) => f.repNo).join(', ')}`);

  touch(s);
  s.status = 'importing';
  s.importResults = targets.map((f) => ({ repNo: f.repNo, fileName: f.fileName, state: 'pending', message: '' }));
  s.message = `กำลังนำเข้า 0/${targets.length} ไฟล์`;

  (async () => {
    const profile = await loadRepProfile();
    const { rows: funds } = await db.query('SELECT code, stm_columns, rep_subfunds FROM funds WHERE is_active ORDER BY sort_order, code');
    let failStreak = 0;
    s.downloads = [];
    let savedBytes = 0;
    // ดาวน์โหลดไฟล์ถัดไปล่วงหน้าระหว่างที่นำเข้าไฟล์ปัจจุบัน (ยังโหลดทีละไฟล์ ไม่ยิงพร้อมกัน)
    const startDownload = (idx) => {
      const p = (async () => {
        if (idx > 0) await sleep(DOWNLOAD_GAP_MS);
        if (!s.browser) throw new Error('เบราว์เซอร์ถูกปิด');
        return downloadExcel(s, targets[idx]);
      })();
      p.catch(() => {}); // กัน unhandled rejection ถ้าไม่ได้ใช้ผลลัพธ์
      return p;
    };
    let pending = null; // งานดาวน์โหลดของไฟล์ที่ i
    for (let i = 0; i < targets.length; i += 1) {
      const f = targets[i];
      const r = s.importResults[i];
      if (!s.browser) { r.state = 'skipped'; r.message = 'เบราว์เซอร์ถูกปิด'; continue; }
      if (failStreak >= MAX_CONSECUTIVE_FAILURES) { r.state = 'skipped'; r.message = 'หยุดเพราะผิดพลาดติดกันหลายไฟล์'; continue; }
      try {
        // ตรวจซ้ำก่อนนำเข้า กันนำเข้าซ้ำถ้ามีคนนำเข้าไฟล์เดียวกันไปแล้ว
        if (i === 0 || !pending) await markImported(s);
        if (f.imported) { r.state = 'skipped'; r.message = 'นำเข้าแล้ว'; pending = null; continue; }
        r.state = 'downloading';
        const current_ = pending || startDownload(i);
        pending = null;
        const { buffer, fileName } = await current_;
        if (i + 1 < targets.length && !targets[i + 1].imported) pending = startDownload(i + 1);
        if (savedBytes + buffer.length <= MAX_KEEP_BYTES) {
          s.downloads.push({ fileName, buffer });
          savedBytes += buffer.length;
        }
        r.state = 'importing';
        const parsed = parseExcel(buffer, profile, funds, fileName);
        if (parsed.missingRequired.length) throw new Error(`ไฟล์ขาดคอลัมน์ที่จำเป็น: ${parsed.missingRequired.join(', ')}`);
        if (!parsed.records.length) throw new Error('ไม่พบรายการที่นำเข้าได้ในไฟล์');
        const saved = await saveImport({ fileName, profile, parsed, userId });
        r.state = 'done';
        r.message = `เพิ่ม ${saved.inserted} · อัปเดต ${saved.updated}${saved.errorCount ? ` · ผิดพลาด ${saved.errorCount} แถว` : ''}`;
        r.batchId = saved.batchId;
        failStreak = 0;
      } catch (err) {
        r.state = 'error';
        r.message = String(err.message || err).split('\n')[0];
        failStreak += 1;
      }
      s.message = `กำลังนำเข้า ${i + 1}/${targets.length} ไฟล์`;
    }
    await markImported(s).catch(() => {});
    const count = (st) => s.importResults.filter((x) => x.state === st).length;
    s.summary = { ...s.summary, result: { done: count('done'), skipped: count('skipped'), error: count('error') } };
    s.status = 'imported';
    touch(s, AFTER_IMPORT_IDLE_MS);
    s.message = `นำเข้าเสร็จ: สำเร็จ ${count('done')} · ข้าม ${count('skipped')} · ผิดพลาด ${count('error')}`;
    await onFinish?.({ files: targets.length, ...s.summary.result });
  })().catch((err) => {
    s.status = 'error';
    s.message = `นำเข้าไม่สำเร็จ: ${String(err.message || err).split('\n')[0]}`;
  });
  return publicView(s);
}

/** ปิดเบราว์เซอร์เมื่อ process จบ */
process.once('exit', () => { if (current?.browser) current.browser.close().catch(() => {}); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.once(sig, async () => {
    if (current) await closeSession(current, 'closed', 'เซิร์ฟเวอร์ปิดตัว').catch(() => {});
    process.kill(process.pid, sig); // ส่งสัญญาณเดิมซ้ำ ให้ process จบตามปกติ
  });
}

/** เปิดใช้ฟีเจอร์นี้หรือไม่: ตั้ง NHSO_SYNC_ENABLED=true/false ถ้าไม่ตั้ง = เปิดเฉพาะนอก production */
export const nhsoSyncEnabled = () => {
  const v = String(process.env.NHSO_SYNC_ENABLED ?? '').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return process.env.NODE_ENV !== 'production';
};
