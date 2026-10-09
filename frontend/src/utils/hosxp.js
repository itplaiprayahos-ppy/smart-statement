import api from '../api/client.js';
import { confirmAction, notifySuccess, showError, withLoading } from './alert.js';
import { daysInRange, int, thaiDate } from './format.js';
import { notifyDataChanged } from './dataEvents.js';

/** ยืนยันแล้วดึงข้อมูล OPD (visit + รายการค่าบริการตามกองทุน) จาก HOSxP คืน true เมื่อสำเร็จ */
export async function pullHosxpOpd({ dateFrom, dateTo }) {
  const long = daysInRange(dateFrom, dateTo) > 62;
  const ok = await confirmAction({
    title: 'ดึงข้อมูล OPD จาก HOSxP?',
    text: `ช่วง ${thaiDate(dateFrom)} – ${thaiDate(dateTo)} ข้อมูลเดิมของช่วงนี้ในระบบจะถูกแทนที่ด้วยข้อมูลล่าสุด${
      long ? ' ช่วงยาวหลายเดือนอาจใช้เวลาหลายนาที ระบบจะดึงทีละเดือน' : ''}`,
    confirmText: 'ดึงข้อมูล',
  });
  if (!ok) return false;
  try {
    const res = await withLoading('กำลังดึงข้อมูลจาก HOSxP…', () => api.post('/his/opd/pull', { dateFrom, dateTo }));
    notifySuccess(`ดึงข้อมูลแล้ว ${int(res.data.rowCount)} visit, รายการค่าบริการตามกองทุน ${int(res.data.itemCount)} รายการ`);
    notifyDataChanged();
    return true;
  } catch (err) {
    showError(err, 'ดึงข้อมูล HOSxP ไม่สำเร็จ');
    return false;
  }
}
