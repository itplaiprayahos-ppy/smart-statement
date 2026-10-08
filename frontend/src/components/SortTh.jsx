/**
 * หัวคอลัมน์ที่กดเรียงได้
 * <SortTh k="sdate" sort={sort} onSort={toggle} className="num">วันที่</SortTh>
 */
export default function SortTh({ k, sort, onSort, className = '', children, title, ...rest }) {
  const active = sort?.key === k;
  const dir = active ? sort.dir : null;
  return (
    <th className={`${className} sortable ${active ? 'sorted' : ''}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} {...rest}>
      <button type="button" className="th-sort" onClick={() => onSort(k)} title={title || 'กดเพื่อเรียง'}>
        <span>{children}</span>
        <i className={`bi ${!active ? 'bi-arrow-down-up' : dir === 'asc' ? 'bi-caret-up-fill' : 'bi-caret-down-fill'}`} aria-hidden="true" />
      </button>
    </th>
  );
}
