import axios from 'axios';

const api = axios.create({ baseURL: '/api', withCredentials: true });

// เซสชันหมดอายุ: แจ้ง AuthContext ให้พากลับหน้า login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const url = err.config?.url || '';
    if (err.response?.status === 401 && !url.includes('/auth/')) {
      window.dispatchEvent(new Event('auth:expired'));
    }
    return Promise.reject(err);
  },
);

export const errorMessage = (err) =>
  err?.response?.data?.message || err?.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';

export default api;
