import { useCallback, useEffect, useState } from 'react';
import api from '../api/client.js';
import SortTh from '../components/SortTh.jsx';
import { useSort } from '../hooks/useSort.js';
import Modal from '../components/Modal.jsx';
import { confirmAction, notifySuccess, showError } from '../utils/alert.js';
import { thaiDateTime } from '../utils/format.js';

const SEP = ' | ';
const emptyForm = (fields) => ({
  id: null, name: '', claim_type: 'OPD', header_row: '', sheet_name: '', is_active: true,
  aliases: Object.fromEntries(Object.keys(fields).map((k) => [k, ''])),
});

export default function MappingsPage() {
  const [items, setItems] = useState([]);
  const mapSort = useSort(items, undefined, { is_active: (m) => !m.is_active });
  const [fields, setFields] = useState({});
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/mappings').then((r) => setItems(r.data)).catch(showError);
  }, []);

  useEffect(() => {
    api.get('/mappings/fields').then((r) => setFields(r.data)).catch(showError);
    load();
  }, [load]);

  const openEdit = (m) => {
    const f = emptyForm(fields);
    if (m) {
      Object.assign(f, {
        id: m.id, name: m.name, claim_type: m.claim_type, header_row: m.header_row ?? '',
        sheet_name: m.sheet_name ?? '', is_active: m.is_active,
      });
      Object.entries(m.mapping).forEach(([k, v]) => { f.aliases[k] = (Array.isArray(v) ? v : [v]).join(SEP); });
    }
    setForm(f);
  };

  const save = async () => {
    const mapping = {};
    Object.entries(form.aliases).forEach(([k, v]) => {
      const list = v.split('|').map((s) => s.trim()).filter(Boolean);
      if (list.length) mapping[k] = list;
    });
    const body = {
      name: form.name, claim_type: form.claim_type, header_row: form.header_row || null,
      sheet_name: form.sheet_name || null, is_active: form.is_active, mapping,
    };
    setBusy(true);
    try {
      if (form.id) await api.put(`/mappings/${form.id}`, body);
      else await api.post('/mappings', body);
      notifySuccess('บันทึกรูปแบบไฟล์แล้ว');
      setForm(null);
      load();
    } catch (err) {
      showError(err, 'บันทึกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m) => {
    if (!(await confirmAction({ title: `ลบรูปแบบ “${m.name}”?`, text: 'ประวัติการนำเข้าที่ใช้รูปแบบนี้ยังอยู่ครบ', confirmText: 'ลบ', danger: true }))) return;
    try {
      await api.delete(`/mappings/${m.id}`);
      notifySuccess('ลบแล้ว');
      load();
    } catch (err) {
      showError(err);
    }
  };

  const setF = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>รูปแบบไฟล์ Excel</h1>
          <p>กำหนดว่าหัวคอลัมน์ในไฟล์ของ สปสช. ตรงกับข้อมูลใดในระบบ เมื่อ สปสช. เปลี่ยนรูปแบบไฟล์ ให้แก้ที่นี่ได้ทันทีโดยไม่ต้องแก้โปรแกรม</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => openEdit(null)}>
          <i className="bi bi-plus-lg me-1" />เพิ่มรูปแบบไฟล์
        </button>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table className="table table-hover data-table">
            <thead><tr><SortTh k="name" sort={mapSort.sort} onSort={mapSort.toggle}>ชื่อ</SortTh><SortTh k="claim_type" sort={mapSort.sort} onSort={mapSort.toggle}>ประเภท</SortTh><SortTh k="header_row" sort={mapSort.sort} onSort={mapSort.toggle}>แถวหัวตาราง</SortTh><SortTh k="is_active" sort={mapSort.sort} onSort={mapSort.toggle}>สถานะ</SortTh><SortTh k="updated_at" sort={mapSort.sort} onSort={mapSort.toggle}>แก้ไขล่าสุด</SortTh><th /></tr></thead>
            <tbody>
              {mapSort.sorted.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.claim_type}</td>
                  <td>{m.header_row ?? <span className="muted">ค้นหาอัตโนมัติ</span>}</td>
                  <td>{m.is_active ? 'ใช้งาน' : <span className="muted">ปิดใช้งาน</span>}</td>
                  <td>{thaiDateTime(m.updated_at)}</td>
                  <td className="text-end text-nowrap">
                    <button type="button" className="btn btn-sm btn-outline-primary me-1" onClick={() => openEdit(m)}>แก้ไข</button>
                    <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => remove(m)} title="ลบ">
                      <i className="bi bi-trash" /><span className="visually-hidden">ลบ</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        show={!!form}
        size="modal-lg"
        title={form?.id ? 'แก้ไขรูปแบบไฟล์' : 'เพิ่มรูปแบบไฟล์'}
        onClose={() => setForm(null)}
        footer={(
          <>
            <button type="button" className="btn btn-light" onClick={() => setForm(null)}>ยกเลิก</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>บันทึก</button>
          </>
        )}
      >
        {form && (
          <>
            <div className="row g-3 mb-3">
              <div className="col-md-6">
                <label className="form-label" htmlFor="mn">ชื่อรูปแบบ</label>
                <input id="mn" className="form-control" value={form.name} onChange={setF('name')} />
              </div>
              <div className="col-md-2">
                <label className="form-label" htmlFor="mt">ประเภท</label>
                <select id="mt" className="form-select" value={form.claim_type} onChange={setF('claim_type')}>
                  <option>OPD</option><option>IPD</option>
                </select>
              </div>
              <div className="col-md-2">
                <label className="form-label" htmlFor="mh">แถวหัวตาราง</label>
                <input id="mh" type="number" min="1" className="form-control" placeholder="อัตโนมัติ" value={form.header_row} onChange={setF('header_row')} />
              </div>
              <div className="col-md-2">
                <label className="form-label" htmlFor="ms">ชื่อชีต</label>
                <input id="ms" className="form-control" placeholder="ชีตแรก" value={form.sheet_name} onChange={setF('sheet_name')} />
              </div>
            </div>

            <p className="small muted mb-2">
              ใส่ชื่อหัวคอลัมน์ตามที่ปรากฏในไฟล์ ถ้ามีได้หลายชื่อให้คั่นด้วยเครื่องหมาย | ระบบไม่สนใจตัวพิมพ์เล็กใหญ่และช่องว่าง
            </p>
            <table className="table table-sm align-middle">
              <tbody>
                {Object.entries(fields).map(([k, def]) => (
                  <tr key={k}>
                    <td style={{ width: '32%' }}>
                      <label htmlFor={`f-${k}`} className="mb-0">{def.label}{def.required && <span className="text-danger"> *</span>}</label>
                      <div className="small-id">{k}</div>
                    </td>
                    <td>
                      <input id={`f-${k}`} className="form-control form-control-sm" value={form.aliases[k] || ''}
                        onChange={(e) => setForm({ ...form, aliases: { ...form.aliases, [k]: e.target.value } })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="form-check">
              <input id="ma" type="checkbox" className="form-check-input" checked={form.is_active} onChange={setF('is_active')} />
              <label className="form-check-label" htmlFor="ma">เปิดให้เลือกใช้ในหน้านำเข้า</label>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
