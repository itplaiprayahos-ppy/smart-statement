import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { errorMessage } from '../api/client.js';
import { STATUS_META } from '../utils/format.js';

const EXAMPLE = ['MATCHED', 'AMOUNT_DIFF', 'DENIED', 'NOT_IN_STM'];

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(form.username, form.password);
      navigate(location.state?.from?.pathname || '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-side" aria-hidden="true">
        <h2>ทุกรายการที่ส่งเบิก ต้องตามได้ว่าได้รับเงินหรือยัง</h2>
        <div className="login-rows">
          {EXAMPLE.map((s) => (
            <div key={s} style={{ '--st-color': STATUS_META[s].hex }}>
              <span>{STATUS_META[s].label}</span>
              <span className="muted" style={{ color: '#a9c4c0' }}>{STATUS_META[s].hint}</span>
            </div>
          ))}
        </div>
        <p>เทียบข้อมูลการรับบริการจาก HOSxP กับไฟล์ตอบกลับจาก สปสช. เพื่อหารายการที่ยังไม่ส่ง ถูกปฏิเสธ หรือได้รับชดเชยไม่ครบ</p>
      </section>

      <section className="login-form">
        <form onSubmit={submit} noValidate>
          <h1 className="h4 fw-semibold mb-1">เข้าสู่ระบบ</h1>
          <p className="muted mb-4">ใช้บัญชีที่ได้รับจากผู้ดูแลระบบ</p>

          {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

          <div className="mb-3">
            <label htmlFor="username" className="form-label">ชื่อผู้ใช้</label>
            <input id="username" className="form-control" autoComplete="username" autoFocus required
              value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div className="mb-4">
            <label htmlFor="password" className="form-label">รหัสผ่าน</label>
            <input id="password" type="password" className="form-control" autoComplete="current-password" required
              value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
          <button type="submit" className="btn btn-primary w-100" disabled={busy || !form.username || !form.password}>
            {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
          </button>
        </form>
      </section>
    </div>
  );
}
