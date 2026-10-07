import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import Modal from '../components/Modal.jsx';
import { confirmAction, notifySuccess, showError, showSuccess } from '../utils/alert.js';
import { int, thaiDateTime } from '../utils/format.js';

const blank = { code: '', description: '', guidance: '', isNew: true };

export default function ErrorCodesPage() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState(null);

  const load = useCallback((query = '') => {
    api.get('/error-codes', { params: { q: query } }).then((r) => setRows(r.data)).catch(showError);
  }, []);
  useEffect(() => { load(); }, [load]);

  const check = async () => {
    try {
      const { data } = await api.post('/error-codes/parse', { text: paste });
      setPreview(data);
    } catch (err) { showError(err); }
  };

  const doImport = async () => {
    try {
      const { data } = await api.post('/error-codes/import', { text: paste });
      await showSuccess('นำเข้าแล้ว', `บันทึก ${int(data.imported)} รหัส (รหัสที่มีอยู่แล้วถูกอัปเดต)`);
      setPaste('');
      setPreview(null);
      load(q);
    } catch (err) { showError(err, 'นำเข้าไม่สำเร็จ'); }
  };

  const save = async () => {
    try {
      await api.put(`/error-codes/${encodeURIComponent(form.code.trim())}`, form);
      notifySuccess('บันทึกแล้ว');
      setForm(null);
      load(q);
    } catch (err) { showError(err); }
  };

  const remove = async (r) => {
    if (!(await confirmAction({ title: `ลบรหัส ${r.code}?`, confirmText: 'ลบ', danger: true }))) return;
    try {
      await api.delete(`/error-codes/${r.code}`);
      notifySuccess('ลบแล้ว');
      load(q);
    } catch (err) { showError(err); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>รหัสข้อผิดพลาด e-Claim</h1>
          <p>
            ใช้แสดงรายละเอียดและแนวทางแก้ไขของรหัสติด C ในหน้ากระทบยอด OPD และไฟล์ส่งออก ระบบมีตารางรหัสตั้งต้นให้แล้ว
            รองรับค่าใน REP ทั้งแบบ 438, C438, AP1 และหลายรหัสในช่องเดียว
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setForm({ ...blank })}>
          <i className="bi bi-plus-lg me-1" />เพิ่มรหัส
        </button>
      </div>

      <div className="panel">
        <div className="panel-title mb-1">ปรับปรุงจากตารางอ้างอิง (ถ้า สปสช. ประกาศรหัสใหม่)</div>
        <p className="small muted">
          เปิดหน้าตารางรหัสข้อผิดพลาด (เช่น จากเว็บไซต์ e-Claim ของ สปสช. หรือแหล่งอ้างอิงที่ รพ.ใช้) ลากคลุมทั้งตาราง กด Ctrl+C แล้ววางในช่องด้านล่าง
          แต่ละแถวต้องเป็น รหัส, รายละเอียด, แนวทางแก้ไข คั่นด้วยแท็บ (คัดลอกจากตารางบนหน้าเว็บหรือ Excel จะได้รูปแบบนี้อยู่แล้ว)
          รหัสที่มีอยู่แล้วจะถูกอัปเดต
        </p>
        <textarea className="form-control mb-2" rows={6} value={paste} placeholder="วางตารางที่คัดลอกมาที่นี่"
          onChange={(e) => { setPaste(e.target.value); setPreview(null); }} aria-label="ข้อความตารางรหัสข้อผิดพลาด" />
        <div className="d-flex gap-2 align-items-center">
          <button type="button" className="btn btn-outline-primary" onClick={check} disabled={!paste.trim()}>ตรวจข้อความ</button>
          {preview?.count > 0 && (
            <button type="button" className="btn btn-primary" onClick={doImport}>นำเข้า {int(preview.count)} รหัส</button>
          )}
          {preview && preview.count === 0 && <span className="text-danger small">ไม่พบรหัสในข้อความ ตรวจว่าแต่ละแถวขึ้นต้นด้วยรหัสตัวเลข</span>}
        </div>
        {preview?.sample?.length > 0 && (
          <div className="table-wrap mt-3">
            <table className="table table-sm data-table">
              <thead><tr><th>รหัส</th><th>รายละเอียด</th><th>แนวทางแก้ไข</th></tr></thead>
              <tbody>
                {preview.sample.map((r) => (
                  <tr key={r.code}><td>{r.code}</td><td className="wrap">{r.description}</td><td className="wrap">{r.guidance || '–'}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="small muted">ตัวอย่าง 10 แถวแรก จากทั้งหมด {int(preview.count)} รหัส</div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <div className="panel-title mb-0">รหัสในระบบ ({int(rows.length)})</div>
          <form className="d-flex gap-2" onSubmit={(e) => { e.preventDefault(); load(q.trim()); }}>
            <input className="form-control form-control-sm" placeholder="ค้นหารหัสหรือข้อความ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหา" />
            <button type="submit" className="btn btn-sm btn-outline-primary">ค้นหา</button>
          </form>
        </div>
        <div className="scroll-box" style={{ height: 480 }}>
          {rows.length === 0 ? <div className="empty">ยังไม่มีรหัสข้อผิดพลาด นำเข้าจากตารางอ้างอิงด้านบน</div> : (
            <table className="table table-sm table-hover data-table">
              <thead><tr><th>รหัส</th><th>รายละเอียด</th><th>แนวทางแก้ไข</th><th>แก้ไขล่าสุด</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td>{r.code}</td>
                    <td className="wrap">{r.description}</td>
                    <td className="wrap small" style={{ whiteSpace: 'pre-line' }}>{r.guidance || '–'}</td>
                    <td className="small-id">{thaiDateTime(r.updated_at)}</td>
                    <td className="text-end">
                      <button type="button" className="btn btn-sm btn-outline-primary me-1" onClick={() => setForm({ ...r, guidance: r.guidance || '', isNew: false })}>แก้ไข</button>
                      <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => remove(r)} title="ลบ">
                        <i className="bi bi-trash" /><span className="visually-hidden">ลบ</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal show={!!form} title={form?.isNew ? 'เพิ่มรหัสข้อผิดพลาด' : `แก้ไขรหัส ${form?.code}`} onClose={() => setForm(null)}
        footer={(<>
          <button type="button" className="btn btn-light" onClick={() => setForm(null)}>ยกเลิก</button>
          <button type="button" className="btn btn-primary" onClick={save}>บันทึก</button>
        </>)}>
        {form && (
          <>
            {form.isNew && (
              <div className="mb-3">
                <label className="form-label" htmlFor="ec-code">รหัส (เช่น 438 หรือ AP1)</label>
                <input id="ec-code" className="form-control" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </div>
            )}
            <div className="mb-3">
              <label className="form-label" htmlFor="ec-desc">รายละเอียด</label>
              <textarea id="ec-desc" className="form-control" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <label className="form-label" htmlFor="ec-guide">แนวทางแก้ไข</label>
              <textarea id="ec-guide" className="form-control" rows={5} value={form.guidance} onChange={(e) => setForm({ ...form, guidance: e.target.value })} />
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
