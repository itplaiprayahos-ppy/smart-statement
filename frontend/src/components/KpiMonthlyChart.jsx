import {
  BarController, BarElement, CategoryScale, Chart as ChartJS, Legend, LineController, LineElement,
  LinearScale, PointElement, Tooltip,
} from 'chart.js';
import { Chart } from 'react-chartjs-2';
import { money, rate, thaiMonth } from '../utils/format.js';

ChartJS.register(CategoryScale, LinearScale, BarController, BarElement, LineController, LineElement, PointElement, Tooltip, Legend);

/** แท่ง = ยอดเบิกได้ (เดือนรอผลสีจาง), เส้น = อัตราการส่งเบิก เทียบเส้นเป้าหมาย */
export default function KpiMonthlyChart({ months, target }) {
  const sendRate = months.map((m) => (m.closed ? rate(m.sent, m.eligible) : null));
  const data = {
    labels: months.map((m) => `${thaiMonth(m.month)}${m.closed ? '' : ' (รอผล)'}`),
    datasets: [
      {
        type: 'bar', label: 'ได้รับจาก REP (บาท)', yAxisID: 'y', order: 3, // วาดก่อน (อยู่ด้านหลังเส้น)
        data: months.map((m) => Number(m.stm_amount)),
        backgroundColor: months.map((m) => (m.closed ? '#0f5c5a' : '#c9d9d7')),
      },
      {
        type: 'line', label: 'อัตราการส่งเบิก (%)', yAxisID: 'y1', data: sendRate, order: 1, borderWidth: 3,
        borderColor: '#e7b559', backgroundColor: '#e7b559', tension: 0.25, spanGaps: false,
      },
      {
        type: 'line', label: `เป้าหมาย ${target}%`, yAxisID: 'y1', data: months.map(() => target), order: 2,
        borderColor: '#b42318', borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5,
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
            ? `${c.dataset.label}: ${c.raw === null ? 'รอผล' : `${Number(c.raw).toFixed(1)}%`}`
            : `${c.dataset.label}: ${money(c.raw)}`),
        },
      },
    },
    scales: {
      y: { position: 'left', ticks: { callback: (v) => Number(v).toLocaleString('th-TH') } },
      y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: (v) => `${v}%` } },
    },
  };
  return <div style={{ height: 320 }}><Chart type="bar" data={data} options={options} /></div>;
}
