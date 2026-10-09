import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DATA_CHANGED } from '../utils/dataEvents.js';
import { thaiDate } from '../utils/format.js';
import { pullHosxpOpd } from '../utils/hosxp.js';

const shortDate = (d) => (d ? thaiDate(String(d).slice(0, 10)) : null);

/**
 * แถบสถานะข้อมูลด้านบนทุกหน้า: แต่ละแหล่งอัปเดตล่าสุดเมื่อไร และข้อมูลถึงวันที่เท่าไร
 * ถ้า HOSxP ยังไม่ครอบคลุมวันที่ใน REP หรือทะเบียนใหม่กว่าการดึงล่าสุด แสดงปุ่มดึงเฉพาะช่วงที่ขาด
 */
export default function DataStatusBar() {
  const { user } = useAuth();
  const location = useLocation();
  const [st, setSt] = useState(null);
  const canPull = user.role !== 'executive';

  const load = useCallback(() => { api.get('/status').then((r) => setSt(r.data)).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, location.pathname]);
  useEffect(() => {
    window.addEventListener(DATA_CHANGED, load);
    return () => window.removeEventListener(DATA_CHANGED, load);
  }, [load]);
  if (!st) return null;

  const pull = async (range) => { if (await pullHosxpOpd(range)) load(); };
  const fix = st.pullForRep || st.pullForRegistry;
  const warn = canPull && fix;

  return (
    <div className={`data-status-bar ${warn ? 'warn' : ''}`} role="status" aria-label="สถานะข้อมูล">
      <span className="item" title="นำเข้าไฟล์ REP ล่าสุด / วันที่รับบริการล่าสุดใน REP">
        <i className="bi bi-file-earmark-spreadsheet" aria-hidden="true" />
        <strong>REP</strong>{' '}
        {st.rep.at ? <>นำเข้า {shortDate(st.rep.at)} <span className="sub">ข้อมูลถึง {shortDate(st.rep.maxDate)}</span></> : <span className="sub">ยังไม่มี</span>}
      </span>
      <span className="item" title="ดึงข้อมูล HOSxP ล่าสุด / วันที่ล่าสุดที่ดึงแล้ว">
        <i className="bi bi-hospital" aria-hidden="true" />
        <strong>HOSxP</strong>{' '}
        {st.his.at ? <>ดึง {shortDate(st.his.at)} <span className="sub">ข้อมูลถึง {shortDate(st.his.maxDate)}</span></> : <span className="sub">ยังไม่ได้ดึง</span>}
      </span>
      {user.role !== 'executive' && (
        <span className="item" title="อัปโหลดทะเบียนล่าสุด">
          <i className="bi bi-journal-text" aria-hidden="true" />
          <strong>ทะเบียน</strong>{' '}
          {st.registry.at ? <>อัปโหลด {shortDate(st.registry.at)} <span className="sub">{st.registry.funds} กองทุน</span></> : <span className="sub">ยังไม่มี</span>}
        </span>
      )}
      {warn && (
        <span className="item fix">
          <i className="bi bi-exclamation-triangle" aria-hidden="true" />
          {st.pullForRep
            ? <>HOSxP ยังไม่ครอบคลุมวันที่ใน REP</>
            : <>ทะเบียนใหม่กว่าข้อมูล HOSxP</>}
          <button type="button" className="btn btn-sm btn-warning ms-2" onClick={() => pull(fix)}>
            ดึง HOSxP {thaiDate(fix.dateFrom)}{fix.dateFrom !== fix.dateTo ? ` – ${thaiDate(fix.dateTo)}` : ''}
          </button>
        </span>
      )}
    </div>
  );
}
