import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { showError } from '../utils/alert.js';
import { int, thaiDate, thaiDateTime } from '../utils/format.js';

function Coverage({ title, data, emptyText, action }) {
  const has = data && data.count > 0;
  return (
    <div className="panel h-100">
      <div className="panel-title">{title}</div>
      {has ? (
        <>
          <div className="fs-4 fw-semibold">{int(data.count)} <span className="fs-6 fw-normal muted">รายการ</span></div>
          <div className="muted">ช่วงวันที่ {thaiDate(data.date_min)} – {thaiDate(data.date_max)}</div>
        </>
      ) : (
        <p className="muted mb-2">{emptyText}</p>
      )}
      <div className="mt-3">{action}</div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/dashboard').then((r) => setData(r.data)).catch(showError);
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>สวัสดี {user.full_name || user.username}</h1>
          <p>ขั้นตอนการทำงาน: นำเข้าไฟล์จาก สปสช. → ดึงข้อมูล HOSxP ช่วงเดียวกัน → ตรวจผลในหน้ากระทบยอด</p>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-md-6">
          <Coverage
            title="ข้อมูลจาก สปสช. (OPD)"
            data={data?.nhso}
            emptyText="ยังไม่มีไฟล์ที่นำเข้า"
            action={<Link to="/import" className="btn btn-outline-primary btn-sm">นำเข้าไฟล์</Link>}
          />
        </div>
        <div className="col-md-6">
          <Coverage
            title="ข้อมูลจาก HOSxP (OPD)"
            data={data?.his}
            emptyText="ยังไม่ได้ดึงข้อมูลจาก HOSxP"
            action={<Link to="/recon/opd" className="btn btn-outline-primary btn-sm">ไปหน้ากระทบยอด</Link>}
          />
        </div>
      </div>

      <div className="panel mt-3">
        <div className="panel-title">กิจกรรมล่าสุด</div>
        <ul className="list-unstyled mb-0">
          <li className="mb-2">
            <i className="bi bi-file-earmark-arrow-up me-2 muted" />
            {data?.lastImport
              ? <>นำเข้า <strong>{data.lastImport.file_name}</strong> โดย {data.lastImport.username} เมื่อ {thaiDateTime(data.lastImport.created_at)}</>
              : <span className="muted">ยังไม่มีการนำเข้าไฟล์</span>}
          </li>
          <li>
            <i className="bi bi-database-down me-2 muted" />
            {data?.lastPull
              ? <>ดึง HOSxP ช่วง {thaiDate(data.lastPull.date_from)} – {thaiDate(data.lastPull.date_to)} ({int(data.lastPull.row_count)} รายการ) โดย {data.lastPull.username} เมื่อ {thaiDateTime(data.lastPull.created_at)}</>
              : <span className="muted">ยังไม่มีการดึงข้อมูล HOSxP</span>}
          </li>
        </ul>
      </div>
    </>
  );
}
