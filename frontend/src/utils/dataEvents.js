/** แจ้งทุกส่วนของหน้าเว็บว่าข้อมูลเปลี่ยน (นำเข้า REP, ดึง HOSxP, อัปโหลดทะเบียน) แถบสถานะข้อมูลจะโหลดใหม่ */
export const DATA_CHANGED = 'claim-recon:data-changed';
export const notifyDataChanged = () => window.dispatchEvent(new Event(DATA_CHANGED));
