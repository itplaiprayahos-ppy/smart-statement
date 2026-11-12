import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client.js';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { int } from '../utils/format.js';

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** สถานะที่ยังทำงานอยู่ (ต้องโพลต่อ) */
const ACTIVE = ['starting', 'waiting_login', 'listing', 'importing'];

const STEP_TEXT = {
  starting: 'กำลังเปิดเบราว์เซอร์',
  waiting_login: 'รอสแกน ThaiD',
  listing: 'กำลังอ่านรายการไฟล์',
  ready: 'พร้อมนำเข้า',
  importing: 'กำลังนำเข้า',
  imported: 'นำเข้าเสร็จ',
  error: 'มีข้อผิดพลาด',
  closed: 'ปิดแล้ว',
};

const RESULT_BADGE = {
  pending: ['secondary', 'รอ'],
  downloading: ['info', 'กำลังดาวน์โหลด'],
  importing: ['info', 'กำลังนำเข้า'],
  done: ['success', 'นำเข้าแล้ว'],
  skipped: ['secondary', 'ข้าม'],
  error: ['danger', 'ผิดพลาด'],
};

const INSCLS = [
  ['ucs', 'สิทธิหลักประกันสุขภาพถ้วนหน้า (UCS)'],
  ['ofc', 'สิทธิข้าราชการ (OFC)'],
  ['sss', 'สิทธิประกันสังคม (SSS)'],
  ['lgo', 'สิทธิ อปท. (LGO)'],
  ['bkk', 'สิทธิเจ้าหน้าที่กรุงเทพมหานคร (BKK)'],
  ['srt', 'สิทธิเจ้าหน้าที่การรถไฟแห่งประเทศไทย (SRT)'],
];

function defaultPeriod() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1); // ค่าเริ่มต้น = เดือนที่แล้ว (เดือนที่ REP ออกครบแล้ว)
  return { month: d.getMonth() + 1, year: d.getFullYear() + 543 };
}

/**
 * ดึงไฟล์ REP จากเว็บ e-Claim ผ่านเบราว์เซอร์ที่เปิดบนเครื่องเซิร์ฟเวอร์ ผู้ใช้สแกน ThaiD เอง
 * แล้วเลือกไฟล์ OP ที่ยังไม่นำเข้า ระบบดาวน์โหลดและนำเข้าให้ทีละไฟล์
 */
export default function EclaimSync({ onImported }) {
  const [period, setPeriod] = useState(defaultPeriod);
  const [inscl, setInscl] = useState('ucs');
  const [session, setSession] = useState(null);
  const [chosen, setChosen] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [starting, setStarting] = useState(false);
  const timer = useRef(null);
  const sessionId = useRef(null);
  const lastStatus = useRef(null);

  const years = useMemo(() => {
    const now = new Date().getFullYear() + 543;
    return [now, now - 1, now - 2];
  }, []);

  const stopPolling = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  /** ถามว่าจะบันทึกไฟล์ REP ที่โหลดมาลงเครื่องเป็น zip หรือไม่ */
  const offerZip = async (id, count) => {
    const ok = await confirmAction({
      title: 'บันทึกไฟล์ REP ลงเครื่อง?',
      text: `ดาวน์โหลดเสร็จ ${int(count)} ไฟล์ ต้องการบันทึกไฟล์ทั้งหมดเป็น zip ลงเครื่องของคุณหรือไม่`,
      confirmText: 'บันทึกเป็น zip',
    });
    if (!ok) return;
    try {
      const res = await api.get(`/nhso/sync/${id}/files.zip`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = /filename="?([^";]+)"?/.exec(res.headers['content-disposition'] || '')?.[1] || 'REP.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      showError(err);
    }
  };

  const poll = useCallback(async () => {
    const id = sessionId.current;
    if (!id) return;
    try {
      const { data } = await api.get(`/nhso/sync/${id}`);
      setSession(data);
      if (data.status === 'ready' && lastStatus.current !== 'ready' && lastStatus.current !== 'imported') {
        // เลือกไฟล์ OP ใหม่ให้อัตโนมัติ (เฉพาะที่ยังไม่นำเข้า)
        setChosen(new Set(data.files.filter((f) => f.type === 'OP' && !f.imported && f.hasExcel).map((f) => f.repNo)));
      }
      if (data.status === 'imported' && lastStatus.current === 'importing') {
        onImported?.();
        const r = data.summary?.result;
        if (r) notifySuccess(`นำเข้า ${int(r.done)} ไฟล์ · ข้าม ${int(r.skipped)} · ผิดพลาด ${int(r.error)}`);
        if (data.downloadedCount > 0) offerZip(id, data.downloadedCount);
      }
      lastStatus.current = data.status;
      if (ACTIVE.includes(data.status)) timer.current = setTimeout(poll, 2000);
    } catch (err) {
      if (err.response?.status === 404) {
        sessionId.current = null;
        setSession(null);
      } else {
        showError(err);
      }
    }
  }, [onImported]);

  // ปิดเซสชัน/เบราว์เซอร์เมื่อออกจากหน้า (ไม่ปล่อยค้าง) ยกเว้นกำลังนำเข้าอยู่
  useEffect(() => () => {
    stopPolling();
    if (sessionId.current && lastStatus.current !== 'importing') {
      api.delete(`/nhso/sync/${sessionId.current}`).catch(() => {});
    }
  }, []);

  const start = async () => {
    setStarting(true);
    try {
      stopPolling();
      setChosen(new Set());
      // ล็อกอินอยู่แล้ว: เปลี่ยนสิทธิ/เดือนในเซสชันเดิม ไม่ต้องสแกน ThaiD ใหม่
      if (sessionId.current && session && ['ready', 'imported', 'error'].includes(session.status)) {
        try {
          const { data } = await api.post(`/nhso/sync/${sessionId.current}/list`, { inscl, month: period.month, year: period.year });
          setSession(data);
          lastStatus.current = data.status;
          timer.current = setTimeout(poll, 1500);
          return;
        } catch (err) {
          if (![404, 409].includes(err.response?.status)) throw err;
          // เซสชันเดิมใช้ต่อไม่ได้ (ปิดไปแล้ว) เริ่มใหม่และสแกน ThaiD
        }
      }
      lastStatus.current = null;
      const { data } = await api.post('/nhso/sync', { type: 'REP', inscl, month: period.month, year: period.year });
      sessionId.current = data.id;
      setSession(data);
      lastStatus.current = data.status;
      timer.current = setTimeout(poll, 1500);
    } catch (err) {
      showError(err);
    } finally {
      setStarting(false);
    }
  };

  const close = async () => {
    const id = sessionId.current;
    stopPolling();
    sessionId.current = null;
    lastStatus.current = null;
    setSession(null);
    setChosen(new Set());
    if (id) await api.delete(`/nhso/sync/${id}`).catch(() => {});
  };

  const toggle = (repNo) => setChosen((set) => {
    const next = new Set(set);
    if (next.has(repNo)) next.delete(repNo); else next.add(repNo);
    return next;
  });

  const files = session?.files || [];
  const selectable = (f) => f.type === 'OP' && f.hasExcel && !f.imported;
  const visible = showAll ? files : files.filter((f) => f.type === 'OP');
  const results = useMemo(() => new Map((session?.importResults || []).map((r) => [r.repNo, r])), [session]);
  const chosenFiles = files.filter((f) => chosen.has(f.repNo) && selectable(f));
  const totalRows = chosenFiles.reduce((a, f) => a + (f.total || 0), 0);
  const running = session && ACTIVE.includes(session.status);
  const canImport = session && ['ready', 'imported'].includes(session.status) && chosenFiles.length > 0;

  const runImport = async () => {
    const ok = await confirmAction({
      title: `นำเข้า ${chosenFiles.length} ไฟล์?`,
      text: `รวม ${int(totalRows)} รายการ ระบบจะดาวน์โหลดจาก e-Claim ทีละไฟล์แล้วนำเข้า รายการเดิมจะถูกอัปเดตไม่เพิ่มซ้ำ`,
      confirmText: 'นำเข้า',
    });
    if (!ok) return;
    try {
      const { data } = await api.post(`/nhso/sync/${sessionId.current}/import`, { repNos: chosenFiles.map((f) => f.repNo) });
      setSession(data);
      lastStatus.current = 'importing';
      stopPolling();
      timer.current = setTimeout(poll, 1500);
    } catch (err) {
      showError(err);
    }
  };

  const allSelectable = visible.filter(selectable);
  const allChecked = allSelectable.length > 0 && allSelectable.every((f) => chosen.has(f.repNo));
  const toggleAll = () => setChosen(allChecked ? new Set() : new Set(allSelectable.map((f) => f.repNo)));

  return (
    <div className="panel mb-3">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
        <div>
          <div className="panel-title mb-1"><i className="bi bi-cloud-download me-2" />ดึงไฟล์ REP จาก e-Claim</div>
          <div className="small muted">
            เปิดหน้าต่างเบราว์เซอร์บนเครื่องเซิร์ฟเวอร์ให้สแกน ThaiD เอง แล้วดาวน์โหลดเฉพาะไฟล์ OP ที่ยังไม่นำเข้า ต้องสแกนใหม่ทุกครั้งที่เซสชันหมดอายุ
          </div>
        </div>
        {session && (
          <span className="small muted"><span className="badge text-bg-secondary me-1">{STEP_TEXT[session.status] || session.status}</span>{session.message}</span>
        )}
      </div>

      <div className="d-flex flex-wrap gap-2 align-items-end">
        <div>
          <label className="form-label small mb-1" htmlFor="nhso-inscl">สิทธิ</label>
          <select id="nhso-inscl" className="form-select form-select-sm" value={inscl} disabled={running}
            onChange={(e) => setInscl(e.target.value)}>
            {INSCLS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label small mb-1" htmlFor="nhso-month">เดือน</label>
          <select id="nhso-month" className="form-select form-select-sm" value={period.month} disabled={running}
            onChange={(e) => setPeriod({ ...period, month: Number(e.target.value) })}>
            {TH_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label small mb-1" htmlFor="nhso-year">ปี (พ.ศ.)</label>
          <select id="nhso-year" className="form-select form-select-sm" value={period.year} disabled={running}
            onChange={(e) => setPeriod({ ...period, year: Number(e.target.value) })}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button type="button" className="btn btn-sm btn-primary" disabled={starting || running} onClick={start}>
          <i className="bi bi-search me-1" />{session ? 'ดึงรายการใหม่' : 'ดึงรายการไฟล์'}
        </button>
        {session && (
          <button type="button" className="btn btn-sm btn-outline-secondary" disabled={session.status === 'importing'} onClick={close}>
            <i className="bi bi-x-lg me-1" />ปิดเซสชัน
          </button>
        )}
      </div>

      {session?.status === 'waiting_login' && (
        <div className="alert alert-info py-2 mt-3 mb-0" role="status">
          <i className="bi bi-qr-code-scan me-2" />กรุณาสแกน QR ด้วยแอป ThaiD ในหน้าต่างเบราว์เซอร์ที่เปิดขึ้น (รอได้สูงสุด 5 นาที)
        </div>
      )}
      {session?.status === 'error' && (
        <div className="alert alert-danger py-2 mt-3 mb-0" role="alert">{session.message}</div>
      )}

      {files.length > 0 && (
        <div className="mt-3">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
            <div className="small">
              พบ {int(session.summary?.total)} ไฟล์ · OP {int(session.summary?.op)} (ใหม่ {int(session.summary?.newOp)}) · IP {int(session.summary?.ip)} (ข้าม)
            </div>
            <div className="form-check form-switch m-0">
              <input id="nhso-all" className="form-check-input" type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              <label className="form-check-label small" htmlFor="nhso-all">แสดงไฟล์ IP ด้วย</label>
            </div>
          </div>

          <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
            <table className="table data-table table-hover align-middle">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" className="form-check-input" checked={allChecked} disabled={running || !allSelectable.length}
                      onChange={toggleAll} aria-label="เลือกไฟล์ใหม่ทั้งหมด" />
                  </th>
                  <th>เลขที่ REP</th>
                  <th>วันที่ส่ง</th>
                  <th>ประเภท</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ผ่าน</th>
                  <th className="num">ไม่ผ่าน</th>
                  <th>สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((f) => {
                  const res = results.get(f.repNo);
                  let badge;
                  if (res) badge = RESULT_BADGE[res.state] || ['secondary', res.state];
                  else if (f.type !== 'OP') badge = ['secondary', 'IP ข้าม'];
                  else if (f.imported) badge = ['success', 'นำเข้าแล้ว'];
                  else badge = ['warning', 'ใหม่'];
                  return (
                    <tr key={f.fileName}>
                      <td>
                        <input type="checkbox" className="form-check-input" checked={chosen.has(f.repNo) && selectable(f)}
                          disabled={running || !selectable(f)} onChange={() => toggle(f.repNo)} aria-label={`เลือก ${f.repNo}`} />
                      </td>
                      <td>{f.repNo}</td>
                      <td>{f.sentAt}</td>
                      <td>{f.type || '–'}</td>
                      <td className="num">{int(f.total)}</td>
                      <td className="num">{int(f.passed)}</td>
                      <td className="num">{int(f.failed)}</td>
                      <td>
                        <span className={`badge text-bg-${badge[0]}`}>{badge[1]}</span>
                        {res?.message && <span className="small muted ms-2">{res.message}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
            <span className="small muted">ไฟล์ถูกประมวลผลในหน่วยความจำ ไม่บันทึกลงดิสก์ · ดาวน์โหลดทีละไฟล์ ไม่ยิงพร้อมกัน</span>
            <button type="button" className="btn btn-primary" disabled={!canImport || running} onClick={runImport}>
              <i className="bi bi-cloud-arrow-down me-1" />นำเข้า {int(chosenFiles.length)} ไฟล์{totalRows ? ` (${int(totalRows)} รายการ)` : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
