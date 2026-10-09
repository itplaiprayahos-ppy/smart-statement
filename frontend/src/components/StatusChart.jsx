import {
  BarElement, CategoryScale, Chart as ChartJS, Legend, LinearScale, Tooltip,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { STATUS_META, STATUS_ORDER, money } from '../utils/format.js';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);
ChartJS.defaults.font.family = "'IBM Plex Sans Thai', sans-serif";

/** กราฟเทียบยอด HOSxP / เรียกเก็บ / ชดเชย แยกตามสถานะ */
export default function StatusChart({ summary }) {
  const labels = STATUS_ORDER.map((s) => STATUS_META[s].label);
  const pick = (k) => STATUS_ORDER.map((s) => Number(summary?.[s]?.[k] || 0));

  const data = {
    labels,
    datasets: [
      { label: 'เรียกเก็บ (HOSxP)', data: pick('his_amount'), backgroundColor: '#0f5c5a' },
      { label: 'เรียกเก็บ (REP)', data: pick('claim_amount'), backgroundColor: '#8fb5b1' },
      { label: 'ได้รับ (REP)', data: pick('compensated'), backgroundColor: '#e7b559' },
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom' },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.raw)} บาท` } },
    },
    scales: { y: { ticks: { callback: (v) => Number(v).toLocaleString('th-TH') } } },
  };

  return <div style={{ height: 300 }}><Bar data={data} options={options} /></div>;
}
