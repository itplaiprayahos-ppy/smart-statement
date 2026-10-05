import Swal from 'sweetalert2';
import { errorMessage } from '../api/client.js';

const base = {
  confirmButtonText: 'ตกลง',
  cancelButtonText: 'ยกเลิก',
  confirmButtonColor: '#0f5c5a',
  reverseButtons: true,
};

const toast = Swal.mixin({
  toast: true,
  position: 'top-end',
  showConfirmButton: false,
  timer: 2600,
  timerProgressBar: true,
});

export const notifySuccess = (title) => toast.fire({ icon: 'success', title });

export const showError = (err, title = 'ทำรายการไม่สำเร็จ') =>
  Swal.fire({ ...base, icon: 'error', title, text: typeof err === 'string' ? err : errorMessage(err) });

export const showInfo = (title, html) => Swal.fire({ ...base, icon: 'info', title, html });

export const showSuccess = (title, html) => Swal.fire({ ...base, icon: 'success', title, html });

/** ยืนยันก่อนทำรายการ คืน true เมื่อผู้ใช้กดยืนยัน */
export async function confirmAction({ title, text, confirmText = 'ยืนยัน', danger = false }) {
  const res = await Swal.fire({
    ...base,
    icon: danger ? 'warning' : 'question',
    title,
    text,
    showCancelButton: true,
    confirmButtonText: confirmText,
    confirmButtonColor: danger ? '#b42318' : base.confirmButtonColor,
  });
  return res.isConfirmed;
}

/** แสดง loading ระหว่างรอ แล้วปิดอัตโนมัติ */
export async function withLoading(title, fn) {
  Swal.fire({ title, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  try {
    return await fn();
  } finally {
    Swal.close();
  }
}

export { Swal };
