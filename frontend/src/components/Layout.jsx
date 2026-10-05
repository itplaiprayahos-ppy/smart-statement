import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { confirmAction } from '../utils/alert.js';

const MENU = [
  { group: 'งานประจำ' },
  { to: '/', icon: 'bi-house', label: 'ภาพรวม', end: true },
  { to: '/import', icon: 'bi-file-earmark-arrow-up', label: 'นำเข้าไฟล์ สปสช.' },
  { to: '/recon/opd', icon: 'bi-ui-checks', label: 'กระทบยอด OPD' },
  { to: '/recon/funds', icon: 'bi-diagram-3', label: 'แยกกองทุน OPD' },
  { group: 'ผู้ดูแลระบบ', admin: true },
  { to: '/mappings', icon: 'bi-table', label: 'รูปแบบไฟล์ Excel', admin: true },
  { to: '/funds/settings', icon: 'bi-sliders', label: 'ตั้งค่ากองทุน', admin: true },
  { to: '/users', icon: 'bi-people', label: 'ผู้ใช้งาน', admin: true },
];

export default function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const handleLogout = async () => {
    if (await confirmAction({ title: 'ออกจากระบบ?', confirmText: 'ออกจากระบบ' })) {
      await logout();
      navigate('/login');
    }
  };

  return (
    <div className="app-shell">
      <div className="mobile-bar">
        <button type="button" className="btn btn-sm btn-outline-light" onClick={() => setOpen(true)} aria-label="เปิดเมนู">
          <i className="bi bi-list" />
        </button>
        <span>กระทบยอดเบิกจ่าย สปสช.</span>
      </div>

      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="sidebar-brand">
          <div className="title">กระทบยอดเบิกจ่าย</div>
          <div className="sub">HOSxP เทียบ Statement สปสช.</div>
        </div>
        <nav>
          {MENU.filter((m) => !m.admin || isAdmin).map((m) =>
            m.group ? (
              <div key={m.group} className="nav-group">{m.group}</div>
            ) : (
              <NavLink key={m.to} to={m.to} end={m.end} className="nav-link">
                <i className={`bi ${m.icon}`} aria-hidden="true" />
                {m.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-user">
          <div className="name">{user.full_name || user.username}</div>
          <div className="d-flex align-items-center justify-content-between mt-1">
            <span className="role-tag">{user.role === 'admin' ? 'ผู้ดูแลระบบ' : 'ผู้ใช้งาน'}</span>
            <span className="d-flex gap-1">
              <NavLink to="/account" className="btn btn-sm btn-link text-light p-1" title="เปลี่ยนรหัสผ่าน">
                <i className="bi bi-key" /><span className="visually-hidden">เปลี่ยนรหัสผ่าน</span>
              </NavLink>
              <button type="button" className="btn btn-sm btn-link text-light p-1" onClick={handleLogout} title="ออกจากระบบ">
                <i className="bi bi-box-arrow-right" /><span className="visually-hidden">ออกจากระบบ</span>
              </button>
            </span>
          </div>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
