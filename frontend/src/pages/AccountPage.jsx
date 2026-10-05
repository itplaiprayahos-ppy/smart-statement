import { useState } from 'react';
import api from '../api/client.js';
import { notifySuccess, showError } from '../utils/alert.js';

export default function AccountPage() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return showError('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
    setBusy(true);
    try {
      await api.post('/auth/change-password', form);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      notifySuccess('เปลี่ยนรหัสผ่านแล้ว');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head"><div><h1>เปลี่ยนรหัสผ่าน</h1></div></div>
      <form className="panel" style={{ maxWidth: 460 }} onSubmit={submit}>
        <div className="mb-3">
          <label className="form-label" htmlFor="cur">รหัสผ่านปัจจุบัน</label>
          <input id="cur" type="password" className="form-control" autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} required />
        </div>
        <div className="mb-3">
          <label className="form-label" htmlFor="np">รหัสผ่านใหม่</label>
          <input id="np" type="password" className="form-control" autoComplete="new-password" minLength={8} value={form.newPassword} onChange={set('newPassword')} required />
          <div className="form-text">อย่างน้อย 8 ตัวอักษร</div>
        </div>
        <div className="mb-4">
          <label className="form-label" htmlFor="cf">ยืนยันรหัสผ่านใหม่</label>
          <input id="cf" type="password" className="form-control" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>บันทึกรหัสผ่านใหม่</button>
      </form>
    </>
  );
}
