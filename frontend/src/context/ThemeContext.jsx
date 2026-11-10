import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Chart } from 'chart.js';

const STORAGE_KEY = 'claim-recon-theme';
const ThemeContext = createContext(null);

/** ธีมเริ่มต้น: ค่าที่ผู้ใช้เลือกไว้ ถ้ายังไม่เคยเลือกให้ตามธีมของระบบปฏิบัติการ */
function initialTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* localStorage ใช้ไม่ได้ */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** สีตัวอักษร/เส้นของกราฟ Chart.js ตามธีม (กราฟที่วาดใหม่หลังสลับจะใช้ค่านี้) */
function applyChartDefaults(theme) {
  const dark = theme === 'dark';
  Chart.defaults.color = dark ? '#c5d0d4' : '#5b6b73';
  Chart.defaults.borderColor = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)';
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(initialTheme);

  // ตั้งก่อน render ลูก เพื่อให้กราฟที่สร้างใหม่ใช้สีของธีมปัจจุบัน
  applyChartDefaults(theme);

  useEffect(() => {
    document.documentElement.setAttribute('data-bs-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ไม่เป็นไร */ }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  const value = useMemo(() => ({ theme, isDark: theme === 'dark', toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme ต้องใช้ภายใน ThemeProvider');
  return ctx;
}

/** ปุ่มสลับธีม Dark / Light */
export function ThemeToggle({ className = 'btn btn-sm btn-link text-light p-1' }) {
  const { isDark, toggle } = useTheme();
  const label = isDark ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด';
  return (
    <button type="button" className={className} onClick={toggle} title={label} aria-label={label}>
      <i className={`bi ${isDark ? 'bi-sun' : 'bi-moon-stars'}`} />
    </button>
  );
}

/** สีชุดข้อมูลของกราฟตามธีม (โหมดมืดใช้สีสว่างขึ้นเพื่อให้เห็นชัดบนพื้นเข้ม) */
export function useChartColors() {
  const { isDark } = useTheme();
  return isDark
    ? { dark: true, strong: '#3fb1ab', soft: '#7aa6a2', pending: '#4a6360', accent: '#e7b559', danger: '#f0766a' }
    : { dark: false, strong: '#0f5c5a', soft: '#8fb5b1', pending: '#c9d9d7', accent: '#e7b559', danger: '#b42318' };
}
