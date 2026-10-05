import { STATUS_META } from '../utils/format.js';

export default function StatusBadge({ status }) {
  const meta = STATUS_META[status];
  if (!meta) return null;
  return <span className="status-badge" style={{ '--st-color': meta.color }} title={meta.hint}>{meta.label}</span>;
}
