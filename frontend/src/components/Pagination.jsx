export default function Pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const from = Math.max(1, page - 2);
  const to = Math.min(pages, from + 4);
  const items = [];
  for (let p = from; p <= to; p += 1) items.push(p);

  const Item = ({ p, label, disabled, active }) => (
    <li className={`page-item ${disabled ? 'disabled' : ''} ${active ? 'active' : ''}`}>
      <button type="button" className="page-link" onClick={() => onChange(p)} disabled={disabled}>{label ?? p}</button>
    </li>
  );

  return (
    <nav aria-label="เปลี่ยนหน้า">
      <ul className="pagination pagination-sm mb-0">
        <Item p={1} label="«" disabled={page === 1} />
        <Item p={page - 1} label="‹" disabled={page === 1} />
        {items.map((p) => <Item key={p} p={p} active={p === page} />)}
        <Item p={page + 1} label="›" disabled={page === pages} />
        <Item p={pages} label="»" disabled={page === pages} />
      </ul>
    </nav>
  );
}
