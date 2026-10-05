import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import Modal from '../components/Modal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Swal, notifySuccess, showError } from '../utils/alert.js';
import { thaiDateTime } from '../utils/format.js';

const blank = { id: null, username: '', full_name: '', role: 'user', password: '', is_active: true };

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/users').then((r) => setUsers(r.data)).catch(showError);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      if (form.id) {
        await api.put(`/users/${form.id}`, { full_name: form.full_name, role: form.role, is_active: form.is_active });
      } else {
        await api.post('/users', form);
      }
      notifySuccess(form.id ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มผู้ใช้แล้ว');
      setForm(null);
      load();
    } catch (err) {
      showError(err, 'บันทึกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (u) => {
    const { value } = await Swal.fire({
      title: `ตั้งรหัสผ่านใหม่ให้ ${u.username}`,
      input: 'password',
      inputLabel: 'รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)',
      inputAttributes: { autocomplete: 'new-password' },
      showCancelButton: true,
      confirmButtonText: 'ตั้งรหัสผ่าน',
      cancelButtonText: 'ยกเลิก',
      reverseButtons: true,
      inputValidator: (v) => (!v || v.length < 8 ? 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' : undefined),
    });
    if (!value) return;
    try {
      await api.post(`/users/${u.id}/reset-password`, { password: value });
      notifySuccess('ตั้งรหัสผ่านใหม่แล้ว');
    } catch (err) {
      showError(err);
    }
  };

  const setF = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ผู้ใช้งาน</h1>
          <p>ผู้ดูแลระบบจัดการผู้ใช้ รูปแบบไฟล์ และลบประวัติการนำเข้าได้ ผู้ใช้งานทั่วไปนำเข้าไฟล์ ดึงข้อมูล และดูผลกระทบยอดได้</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setForm({ ...blank })}>
          <i className="bi bi-person-plus me-1" />เพิ่มผู้ใช้
        </button>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table className="table table-hover data-table">
            <thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อ-สกุล</th><th>สิทธิ์</th><th>สถานะ</th><th>เข้าใช้ล่าสุด</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}{u.id === me.id && <span className="small-id"> (คุณ)</span>}</td>
                  <td>{u.full_name || '–'}</td>
                  <td>{u.role === 'admin' ? 'ผู้ดูแลระบบ' : 'ผู้ใช้งาน'}</td>
                  <td>{u.is_active ? 'ใช้งาน' : <span className="text-danger">ปิดใช้งาน</span>}</td>
                  <td>{thaiDateTime(u.last_login_at)}</td>
                  <td className="text-end text-nowrap">
                    <button type="button" className="btn btn-sm btn-outline-primary me-1" onClick={() => setForm({ ...blank, ...u, password: '' })}>แก้ไข</button>
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => resetPassword(u)}>ตั้งรหัสผ่านใหม่</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        show={!!form}
        title={form?.id ? `แก้ไขผู้ใช้ ${form.username}` : 'เพิ่มผู้ใช้'}
        onClose={() => setForm(null)}
        footer={(
          <>
            <button type="button" className="btn btn-light" onClick={() => setForm(null)}>ยกเลิก</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>บันทึก</button>
          </>
        )}
      >
        {form && (
          <>
            {!form.id && (
              <div className="mb-3">
                <label className="form-label" htmlFor="un">ชื่อผู้ใช้</label>
                <input id="un" className="form-control" value={form.username} onChange={setF('username')} autoComplete="off" />
                <div className="form-text">a-z, 0-9, จุด ขีดล่าง ขีดกลาง</div>
              </div>
            )}
            <div className="mb-3">
              <label className="form-label" htmlFor="fn">ชื่อ-สกุล</label>
              <input id="fn" className="form-control" value={form.full_name || ''} onChange={setF('full_name')} />
            </div>
            <div className="mb-3">
              <label className="form-label" htmlFor="rl">สิทธิ์</label>
              <select id="rl" className="form-select" value={form.role} onChange={setF('role')} disabled={form.id === me.id}>
                <option value="user">ผู้ใช้งาน</option>
                <option value="admin">ผู้ดูแลระบบ</option>
              </select>
            </div>
            {!form.id && (
              <div className="mb-3">
                <label className="form-label" htmlFor="pw">รหัสผ่านเริ่มต้น</label>
                <input id="pw" type="password" className="form-control" value={form.password} onChange={setF('password')} autoComplete="new-password" />
                <div className="form-text">อย่างน้อย 8 ตัวอักษร แจ้งผู้ใช้ให้เปลี่ยนหลังเข้าระบบครั้งแรก</div>
              </div>
            )}
            {form.id && form.id !== me.id && (
              <div className="form-check">
                <input id="ac" type="checkbox" className="form-check-input" checked={form.is_active} onChange={setF('is_active')} />
                <label className="form-check-label" htmlFor="ac">เปิดใช้งานบัญชี</label>
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
