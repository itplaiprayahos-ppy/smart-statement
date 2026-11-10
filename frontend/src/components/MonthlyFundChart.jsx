import {
  BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LineController, LineElement,
  LinearScale, PointElement, Tooltip,
} from 'chart.js';
import { Chart } from 'react-chartjs-2';
import { money, thaiMonth } from '../utils/format.js';
import { useChartColors } from '../context/ThemeContext.jsx';

// กราฟผสม (แท่ง + เส้น) ต้องลงทะเบียน controller ของทั้งสองชนิด
ChartJS.register(CategoryScale, LinearScale, BarController, BarElement, LineController, LineElement, PointElement, Tooltip, Legend);

/** กราฟรายเดือน: แท่ง = ยอดตั้งเบิก / ยอดเบิกได้, เส้น = จำนวนคนไข้ */
export default function MonthlyFundChart({ months }) {
  const col = useChartColors();
  const data = {
    labels: months.map((m) => thaiMonth(m.month)),
    datasets: [
      { type: 'bar', label: 'ตั้งเบิก (กองทุน)', data: months.map((m) => m.his_amount), backgroundColor: col.soft, yAxisID: 'y' },
      { type: 'bar', label: 'ได้รับ (กองทุน)', data: months.map((m) => m.stm_amount), backgroundColor: col.strong, yAxisID: 'y' },
      {
        type: 'line', label: 'คนไข้', data: months.map((m) => m.patients), borderColor: col.accent,
        backgroundColor: col.accent, yAxisID: 'y1', tension: 0.25,
      },
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom' },
      tooltip: {
        callbacks: {
          label: (c) => (c.dataset.yAxisID === 'y1'
            ? `${c.dataset.label}: ${c.raw} คน`
            : `${c.dataset.label}: ${money(c.raw)} บาท`),
        },
      },
    },
    scales: {
      y: { position: 'left', ticks: { callback: (v) => Number(v).toLocaleString('th-TH') } },
      y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { precision: 0 }, title: { display: true, text: 'คน' } },
    },
  };
  return <div style={{ height: 300 }}><Chart key={col.dark ? 'dark' : 'light'} type="bar" data={data} options={options} /></div>;
}
