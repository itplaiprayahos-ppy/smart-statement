import {
  BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LineController, LineElement,
  LinearScale, PointElement, Tooltip,
} from 'chart.js';
import { Chart } from 'react-chartjs-2';
import { money, thaiMonth } from '../utils/format.js';

// กราฟผสม (แท่ง + เส้น) ต้องลงทะเบียน controller ของทั้งสองชนิด
ChartJS.register(CategoryScale, LinearScale, BarController, BarElement, LineController, LineElement, PointElement, Tooltip, Legend);

/** กราฟรายเดือน: แท่ง = ยอดตั้งเบิก / ยอดเบิกได้, เส้น = จำนวนคนไข้ */
export default function MonthlyFundChart({ months }) {
  const data = {
    labels: months.map((m) => thaiMonth(m.month)),
    datasets: [
      { type: 'bar', label: 'ยอดตั้งเบิก (HOSxP)', data: months.map((m) => m.his_amount), backgroundColor: '#8fb5b1', yAxisID: 'y' },
      { type: 'bar', label: 'ยอดเบิกได้', data: months.map((m) => m.stm_amount), backgroundColor: '#0f5c5a', yAxisID: 'y' },
      {
        type: 'line', label: 'คนไข้', data: months.map((m) => m.patients), borderColor: '#e7b559',
        backgroundColor: '#e7b559', yAxisID: 'y1', tension: 0.25,
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
  return <div style={{ height: 300 }}><Chart type="bar" data={data} options={options} /></div>;
}
