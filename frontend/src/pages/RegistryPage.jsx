import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';
import Modal from '../components/Modal.jsx';
import Pagination from '../components/Pagination.jsx';
import PeriodFields from '../components/PeriodFields.jsx';
import SortTh from '../components/SortTh.jsx';
import { notifyDataChanged } from '../utils/dataEvents.js';
import { pullHosxpOpd } from '../utils/hosxp.js';
import { useSort, useSortState } from '../hooks/useSort.js';
import { useAuth } from '../context/AuthContext.jsx';
import { confirmAction, notifySuccess, showError, showSuccess } from '../utils/alert.js';
import { int, lastMonthRange, money, rangeErrorOf, thaiDate, thaiDateTime } from '../utils/format.js';

const PAGE_SIZE = 50;
/** สีและไอคอนของผลการเทียบ */
const STATUS_STYLE = {
  MATCH:           { color: 'var(--st-matched)', icon: 'bi-check-circle' },
  NOT_CHARGED:     { color: 'var(--st-denied)',  icon: 'bi-receipt' },
  NO_VISIT:        { color: 'var(--st-denied)',  icon: 'bi-person-x' },
  PRICE_DIFF:      { color: 'var(--st-diff)',    icon: 'bi-currency-exchange' },
  DENIED:          { color: 'var(--st-denied)',  icon: 'bi-x-octagon' },
  NOT_CLAIMED:     { color: 'var(--st-diff)',    icon: 'bi-send-exclamation' },
  NOT_PAID:        { color: 'var(--st-diff)',    icon: 'bi-cash' },
  NOT_IN_REGISTRY: { color: 'var(--st-not-his)',  icon: 'bi-journal-x' },
  UNKNOWN_ITEM:    { color: 'var(--cr-muted)',   icon: 'bi-question-circle' },
};
const SOURCE_TH = { registry: 'ทะเบียน', his: 'HOSxP', rep: 'REP' };

function SourceCell({ v }) {
  if (v.ok) {
    return <td className="num src-cell ok"><i className="bi bi-check-lg" aria-label="มี" />{v.amount != null ? money(v.amount) : ''}</td>;
  }
  return <td className="num src-cell no"><i className="bi bi-x-lg" aria-label="ไม่มี" />{v.note ? <span className="note">{v.note}</span> : ''}</td>;
}

/* ---------- อัปโหลดทะเบียน ---------- */
function UploadModal({ fund, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f) => {
    setFile(f); setPreview(null);
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('fundCode', fund.code); fd.append('file', f);
      const { data } = await api.post('/registry/preview', fd);
      setPreview(data);
    } catch (err) { showError(err, 'อ่านไฟล์ไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const doImport = async () => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('fundCode', fund.code); fd.append('file', file);
      const { data } = await api.post('/registry', fd);
      await showSuccess('นำเข้าทะเบียนแล้ว', `${int(data.inserted)} รายการ (แทนที่รายการเดิม ${int(data.replaced)} รายการ)`
        + (data.unknown ? `<br>มีรายการที่ยังไม่รู้จัก ${int(data.unknown)} แถว กรุณาจับคู่รายการ` : ''));
      notifyDataChanged();
      onDone();
    } catch (err) { showError(err, 'นำเข้าไม่สำเร็จ'); } finally { setBusy(false); }
  };

  const ok = preview && !preview.missingRequired.length && preview.validRows > 0;
  return (
    <Modal show title={`อัปโหลดทะเบียน: ${fund.code} ${fund.name}`} onClose={onClose} size="modal-lg"
      footer={(<>
        <button type="button" className="btn btn-light" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!ok || busy} onClick={doImport}>
          {busy && <span className="spinner-border spinner-border-sm me-1" />}นำเข้า {ok ? `${int(preview.validRows)} รายการ` : ''}
        </button>
      </>)}>
      <input type="file" className="form-control mb-2" accept=".xlsx,.xls" disabled={busy} onChange={(e) => pick(e.target.files[0])} />
      <p className="small muted">
        คอลัมน์ที่ต้องมี: วันที่ให้บริการ, HN, รายการค่าบริการ (ชื่อรายการ) และควรมีราคา ระบบหาแถวหัวตารางเอง
        การนำเข้าจะ <strong>แทนที่ทะเบียนของกองทุนนี้ในช่วงวันที่ที่ไฟล์ครอบคลุม</strong> แก้ไฟล์ใน Excel แล้วอัปโหลดซ้ำได้
      </p>
      {busy && !preview && <div className="text-center py-3"><span className="spinner-border text-secondary" /></div>}
      {preview && (
        <>
          {preview.missingRequired.length > 0 ? (
            <div className="alert alert-danger py-2">ไม่พบคอลัมน์: {preview.missingRequired.join(', ')}</div>
          ) : (
            <ul className="list-unstyled mb-2 small">
              <li><i className="bi bi-table me-1" />ชีต “{preview.sheetName}” หัวตารางแถวที่ {preview.headerRowNumber}:{' '}
                {Object.entries(preview.columns).map(([, v]) => v).join(', ')}</li>
              <li><i className="bi bi-calendar-range me-1" />ช่วงวันที่ในไฟล์ {thaiDate(preview.dateFrom)} – {thaiDate(preview.dateTo)}
                {' '}(รายการเดิมของกองทุนนี้ในช่วงนี้จะถูกแทนที่)</li>
              <li><i className="bi bi-check2 me-1" />นำเข้าได้ {int(preview.validRows)} จาก {int(preview.totalRows)} แถว</li>
            </ul>
          )}
          {preview.errorCount > 0 && (
            <div className="alert alert-warning py-2 small mb-2">
              แถวที่มีปัญหา {int(preview.errorCount)} แถว (จะไม่ถูกนำเข้า):
              <ul className="mb-0">{preview.errors.slice(0, 5).map((e) => <li key={e.row}>แถว {e.row}: {e.message}</li>)}</ul>
              {preview.errorCount > 5 && '…'}
            </div>
          )}
          {preview.unknownItems.length > 0 && (
            <div className="alert alert-info py-2 small mb-0">
              ชื่อรายการที่ยังไม่รู้จัก {preview.unknownItems.length} ชื่อ (นำเข้าได้ แล้วจับคู่ภายหลัง):{' '}
              {preview.unknownItems.slice(0, 5).map((u) => `${u.text} (${u.count})`).join(', ')}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/* ---------- จับคู่ชื่อรายการ ---------- */
function MatchItemsModal({ fund, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [fundItems, setFundItems] = useState([]);
  const [search, setSearch] = useState({});
  const [results, setResults] = useState({});

  const load = useCallback(() => {
    api.get('/registry/unknown-items', { params: { fundCode: fund.code } }).then((r) => setList(r.data)).catch(showError);
  }, [fund.code]);
  useEffect(() => {
    load();
    api.get(`/funds/${fund.code}`).then((r) => setFundItems(r.data.items || [])).catch(() => {});
  }, [load, fund.code]);

  const choose = async (text, icode, itemName) => {
    try {
      const { data } = await api.post('/registry/aliases', { text, icode, itemName });
      notifySuccess(`จับคู่แล้ว ${int(data.updated)} แถว`);
      load(); onDone();
    } catch (err) { showError(err); }
  };
  const find = async (text) => {
    const q = (search[text] || '').trim();
    if (q.length < 2) return;
    try {
      const [a, b] = await Promise.all([
        api.get('/funds/items/search', { params: { source: 'nondrug', q } }),
        api.get('/funds/items/search', { params: { source: 'drug', q } }),
      ]);
      setResults((r) => ({ ...r, [text]: [...a.data.items, ...b.data.items].slice(0, 30) }));
    } catch (err) { showError(err, 'ค้นหาใน HOSxP ไม่สำเร็จ'); }
  };

  return (
    <Modal show title="จับคู่ชื่อรายการในทะเบียนกับรายการใน HOSxP" onClose={onClose} size="modal-lg"
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>เสร็จ</button>}>
      <p className="small muted">จับคู่ครั้งเดียว ระบบจำไว้ใช้กับการอัปโหลดครั้งต่อไปทุกกองทุน</p>
      {!list ? <div className="text-center py-3"><span className="spinner-border text-secondary" /></div>
        : list.length === 0 ? <p className="mb-0 text-success"><i className="bi bi-check-circle me-1" />จับคู่ครบทุกรายการแล้ว</p>
          : list.map((u) => (
            <div key={u.item_key} className="match-item">
              <div className="fw-medium">“{u.text}” <span className="small muted">{int(u.count)} แถว</span></div>
              <div className="d-flex flex-wrap gap-2 mt-1">
                <select className="form-select form-select-sm" style={{ maxWidth: 320 }} defaultValue=""
                  onChange={(e) => { const it = fundItems.find((x) => x.icode === e.target.value); if (it) choose(u.text, it.icode, it.item_name); }}>
                  <option value="" disabled>เลือกจากรายการของกองทุน {fund.code}</option>
                  {fundItems.map((it) => <option key={it.icode} value={it.icode}>{it.icode} {it.item_name}</option>)}
                </select>
                <div className="input-group input-group-sm" style={{ maxWidth: 320 }}>
                  <input className="form-control" placeholder="หรือค้นหาใน HOSxP" value={search[u.text] || ''}
                    onChange={(e) => setSearch((s) => ({ ...s, [u.text]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') find(u.text); }} />
                  <button type="button" className="btn btn-outline-primary" onClick={() => find(u.text)}>ค้นหา</button>
                </div>
              </div>
              {results[u.text]?.length > 0 && (
                <div className="list-group list-group-flush mt-1 small">
                  {results[u.text].map((it) => (
                    <button key={`${it.source}-${it.icode}`} type="button" className="list-group-item list-group-item-action py-1"
                      onClick={() => choose(u.text, it.icode, it.name)}>
                      {it.icode} {it.name} {it.price != null && <span className="muted">({money(it.price)})</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
    </Modal>
  );
}

/* ---------- หน้าเทียบ 3 แหล่ง ---------- */
export default function RegistryPage() {
  const { user, isAdmin } = useAuth();
  const [funds, setFunds] = useState([]);
  const [fundCode, setFundCode] = useState('');
  const [range, setRange] = useState(lastMonthRange());
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);
  const [batches, setBatches] = useState([]);
  const [showBatches, setShowBatches] = useState(false);
  const [sort, toggleSort] = useSortState();
  const onSort = (k) => { toggleSort(k); setPage(1); };
  const batchSort = useSort(batches, { key: 'created_at', dir: 'desc' });

  useEffect(() => {
    api.get('/funds').then((r) => {
      const list = r.data.filter((f) => f.is_active && !f.track_only);
      setFunds(list);
      const mine = (user.fund_codes || []).find((c) => list.some((f) => f.code === c));
      setFundCode(mine || list[0]?.code || '');
    }).catch(showError);
  }, [user.fund_codes]);

  const fund = funds.find((f) => f.code === fundCode);
  const rangeError = rangeErrorOf(range);
  const params = useMemo(() => ({
    fundCode, ...range, status: status || undefined, search: search || undefined,
    sort: sort.key || undefined, dir: sort.key ? sort.dir : undefined,
  }), [fundCode, range, status, search, sort]);

  const load = useCallback(() => {
    if (!fundCode || rangeError) return;
    setLoading(true);
    api.get('/registry/compare', { params: { ...params, page, pageSize: PAGE_SIZE } })
      .then((r) => setData(r.data))
      .catch((err) => showError(err, 'เทียบข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
    api.get('/registry/batches', { params: { fundCode } }).then((r) => setBatches(r.data)).catch(() => {});
  }, [params, page, fundCode, rangeError]);
  useEffect(() => { load(); }, [load]);

  const exportUrl = `/api/registry/compare/export?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined))}`;
  const removeBatch = async (b) => {
    if (!(await confirmAction({ title: 'ลบการอัปโหลดนี้?', text: `${b.file_name}: รายการในทะเบียนจากไฟล์นี้จะถูกลบ`, confirmText: 'ลบ', danger: true }))) return;
    try { await api.delete(`/registry/batches/${b.id}`); notifySuccess('ลบแล้ว'); notifyDataChanged(); load(); } catch (err) { showError(err); }
  };
  const totalRows = data ? Object.values(data.summary).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>เทียบ 3 แหล่ง</h1>
          <p>เทียบทะเบียนที่หน้างานบันทึก กับ HOSxP และ REP ทีละบริการ แล้วบอกว่าตรงกันหรือต่างกันตรงไหน</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <a className={`btn btn-outline-secondary ${fundCode ? '' : 'disabled'}`} href={`/api/registry/template?fundCode=${fundCode}`}>
            <i className="bi bi-file-earmark-arrow-down me-1" />แม่แบบทะเบียน
          </a>
          <button type="button" className="btn btn-primary" disabled={!fund} onClick={() => setModal('upload')}>
            <i className="bi bi-upload me-1" />อัปโหลดทะเบียน
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="row g-3 align-items-end">
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="rg-fund">กองทุน</label>
            <select id="rg-fund" className="form-select" value={fundCode} onChange={(e) => { setFundCode(e.target.value); setStatus(''); setPage(1); }}>
              {funds.map((f) => (
                <option key={f.code} value={f.code}>{f.code} {f.name}{(user.fund_codes || []).includes(f.code) ? ' ★' : ''}</option>
              ))}
            </select>
          </div>
          <PeriodFields idPrefix="rg" value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="rg-q">ค้นหา</label>
            <form className="input-group" onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
              <input id="rg-q" className="form-control" placeholder="HN, ชื่อ, รายการ" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
              <button type="submit" className="btn btn-outline-primary">ค้นหา</button>
            </form>
          </div>
        </div>
        {rangeError && <div className="text-danger small mt-2">{rangeError}</div>}
      </div>

      {data && data.registryRows === 0 && (
        <div className="alert alert-info d-flex align-items-center gap-2">
          <i className="bi bi-info-circle" />
          <span className="me-auto">ยังไม่มีทะเบียนของกองทุน {fundCode} ในช่วงนี้ ทุกรายการจาก HOSxP / REP จะขึ้นว่า “ไม่อยู่ในทะเบียน”</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setModal('upload')}>อัปโหลดทะเบียน</button>
        </div>
      )}
      {data?.unknownItems > 0 && (
        <div className="alert alert-warning d-flex align-items-center gap-2">
          <i className="bi bi-question-circle" />
          <span className="me-auto">มีชื่อรายการในทะเบียนที่ระบบยังไม่รู้จัก {int(data.unknownItems)} ชื่อ จับคู่กับรายการใน HOSxP เพื่อให้เทียบได้</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={() => setModal('match')}>จับคู่รายการ</button>
        </div>
      )}
      {data?.stale && (
        <div className="alert alert-warning d-flex flex-wrap align-items-center gap-2">
          <i className="bi bi-arrow-repeat" />
          <span className="me-auto">ทะเบียนถูกอัปโหลดหลังดึงข้อมูล HOSxP ครั้งล่าสุด ควรดึงข้อมูล HOSxP ช่วงนี้ใหม่ เพื่อให้เห็นรายการในทะเบียนครบ</span>
          <button type="button" className="btn btn-sm btn-warning" onClick={async () => { if (await pullHosxpOpd(range)) load(); }}>
            <i className="bi bi-database-down me-1" />ดึงข้อมูล HOSxP ช่วงนี้
          </button>
        </div>
      )}

      {data && (
        <div className="compare-summary">
          <button type="button" className={`cmp-chip ${!status ? 'active' : ''}`} onClick={() => { setStatus(''); setPage(1); }}>
            <span className="n">{int(totalRows)}</span><span className="t">ทั้งหมด</span>
          </button>
          {Object.entries(data.statuses).map(([k, s]) => (
            <button key={k} type="button" disabled={!data.summary[k]}
              className={`cmp-chip ${status === k ? 'active' : ''}`} style={{ '--c': STATUS_STYLE[k].color }}
              onClick={() => { setStatus(status === k ? '' : k); setPage(1); }}>
              <span className="n"><i className={`bi ${STATUS_STYLE[k].icon} me-1`} />{int(data.summary[k])}</span>
              <span className="t">{s.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <span className="small muted">
            {data && <>แสดง {int(data.total)} รายการ{status ? ` (${data.statuses[status].label})` : ''}</>}
            {loading && <span className="spinner-border spinner-border-sm ms-2" />}
          </span>
          <a className={`btn btn-sm btn-outline-secondary ${data?.total ? '' : 'disabled'}`} href={exportUrl}>
            <i className="bi bi-file-earmark-excel me-1" />ส่งออก Excel
          </a>
        </div>
        <div className="table-wrap">
          <table className="table data-table compare-table sticky-first">
            <thead>
              <tr>
                <SortTh k="sdate" sort={sort} onSort={onSort}>วันที่</SortTh>
                <SortTh k="hn" sort={sort} onSort={onSort}>HN / ชื่อ</SortTh>
                <SortTh k="item" sort={sort} onSort={onSort}>รายการ</SortTh>
                {Object.entries(SOURCE_TH).map(([k, t]) => <SortTh key={k} k={k} sort={sort} onSort={onSort} className="num src-head">{t}</SortTh>)}
                <SortTh k="status" sort={sort} onSort={onSort}>จุดที่ต่าง</SortTh>
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && <tr><td colSpan={7} className="text-center muted py-4">ไม่มีรายการ</td></tr>}
              {data?.rows.map((r, i) => (
                <tr key={`${r.src}-${r.reg_id || ''}-${r.vn || ''}-${r.icode || ''}-${i}`}>
                  <td className="text-nowrap">{thaiDate(r.sdate)}</td>
                  <td>{r.hn}<div className="small-id">{r.patient_name}</div></td>
                  <td className="wrap">{r.item}{r.icode && <div className="small-id">{r.icode}</div>}</td>
                  <SourceCell v={r.registry} />
                  <SourceCell v={r.his} />
                  <SourceCell v={r.rep} />
                  <td className="wrap">
                    <span className="cmp-status" style={{ '--c': STATUS_STYLE[r.status].color }}>
                      <i className={`bi ${STATUS_STYLE[r.status].icon} me-1`} />{data.statuses[r.status].label}
                    </span>
                    {r.status !== 'MATCH' && <div className="small">{r.issues.join(' / ')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />}
      </div>

      <div className="panel">
        <button type="button" className="btn btn-link p-0" onClick={() => setShowBatches((v) => !v)}>
          <i className={`bi ${showBatches ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`} />
          ประวัติอัปโหลดทะเบียน {fundCode} ({batches.length})
        </button>
        {showBatches && (
          <div className="table-wrap mt-2">
            <table className="table table-sm data-table mb-0">
              <thead>
                <tr>
                  <SortTh k="created_at" sort={batchSort.sort} onSort={batchSort.toggle}>เวลา</SortTh>
                  <SortTh k="file_name" sort={batchSort.sort} onSort={batchSort.toggle}>ไฟล์</SortTh>
                  <SortTh k="date_from" sort={batchSort.sort} onSort={batchSort.toggle}>ช่วงวันที่</SortTh>
                  <SortTh k="valid_rows" sort={batchSort.sort} onSort={batchSort.toggle} className="num">นำเข้า</SortTh>
                  <SortTh k="current_rows" sort={batchSort.sort} onSort={batchSort.toggle} className="num">ยังใช้อยู่</SortTh>
                  <SortTh k="error_rows" sort={batchSort.sort} onSort={batchSort.toggle} className="num">มีปัญหา</SortTh>
                  <SortTh k="uploaded_by_name" sort={batchSort.sort} onSort={batchSort.toggle}>ผู้อัปโหลด</SortTh>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batchSort.sorted.map((b) => (
                  <tr key={b.id}>
                    <td className="text-nowrap">{thaiDateTime(b.created_at)}</td>
                    <td>{b.file_name}</td>
                    <td className="text-nowrap">{thaiDate(b.date_from)} – {thaiDate(b.date_to)}</td>
                    <td className="num">{int(b.valid_rows)}</td>
                    <td className="num">{b.current_rows ? int(b.current_rows) : <span className="muted">ถูกแทนที่</span>}</td>
                    <td className="num">{int(b.error_rows)}</td>
                    <td>{b.uploaded_by_name || '–'}</td>
                    <td className="text-end">
                      {(isAdmin || b.uploaded_by === user.id) && (
                        <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeBatch(b)} title="ลบ">
                          <i className="bi bi-trash" /><span className="visually-hidden">ลบ</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {batches.length === 0 && <tr><td colSpan={8} className="muted text-center">ยังไม่มีการอัปโหลด</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal === 'upload' && fund && <UploadModal fund={fund} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
      {modal === 'match' && fund && <MatchItemsModal fund={fund} onClose={() => { setModal(null); load(); }} onDone={() => {}} />}
    </>
  );
}
