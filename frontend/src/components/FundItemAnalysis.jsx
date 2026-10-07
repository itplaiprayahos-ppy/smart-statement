import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { showError } from '../utils/alert.js';
import { int, money } from '../utils/format.js';

const pct = (part, whole) => (whole ? (part / whole) * 100 : null);
const SOURCE_LABEL = { nondrug: 'ค่าบริการ', drug: 'ยา' };

function Rate({ value }) {
  if (value === null || value === undefined) return <span className="muted">–</span>;
  return (
    <span className="text-nowrap">
      <span className="rate-bar"><span style={{ width: `${Math.min(100, value)}%` }} /></span>
      {value.toFixed(0)}%
    </span>
  );
}

/**
 * วิเคราะห์รายการของกองทุนที่เลือก
 *  mode="items"  (แบบ B) อัตราได้รับเงินของแต่ละรายการที่ตั้งค่า
 *  mode="common" (แบบ C) รายการที่พบบ่อยในเคสได้รับเงิน เทียบกับเคสไม่สำเร็จ
 */
export default function FundItemAnalysis({ mode, params, fundCode, onShowMissing }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!fundCode) return;
    let alive = true;
    setLoading(true);
    api.get('/recon/funds/analysis', { params: { ...params, fundCode } })
      .then((r) => alive && setData(r.data))
      .catch((err) => showError(err, 'วิเคราะห์รายการไม่สำเร็จ'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [params, fundCode]);

  if (!fundCode) {
    return <p className="muted mb-0 py-3">เลือกกองทุนจากตาราง “สรุปรายกองทุน” ด้านบนก่อน (คลิกที่แถว)</p>;
  }
  if (loading || !data) return <div className="py-4 text-center"><span className="spinner-border spinner-border-sm text-secondary" /></div>;

  const tot = data.totals.find((t) => t.fund_code === fundCode) || { paid_n: 0, fail_n: 0 };

  if (mode === 'items') {
    return (
      <>
        <p className="small muted">
          แต่ละรายการที่ตั้งค่าไว้ในกองทุน {fundCode} พบใน visit ที่เข้าเกณฑ์กี่ visit และได้รับเงินกี่ visit
          รายการที่อัตราได้รับเงินต่ำ อาจเป็นรายการที่ไม่ควรอยู่ในกองทุนนี้ หรือมีปัญหาการบันทึกเบิก
          รายการที่ไม่พบเลยในช่วงนี้จะแสดงไว้ท้ายตาราง
        </p>
        <div className="table-wrap">
          <table className="table table-sm table-hover data-table">
            <thead>
              <tr>
                <th>รายการ</th>
                <th>ประเภท</th>
                <th className="num">visit</th>
                <th className="num">ได้รับเงิน</th>
                <th className="num">ไม่ได้รับเงินกองทุนนี้</th>
                <th className="num">ถูกปฏิเสธ</th>
                <th className="num">ไม่พบใน REP</th>
                <th>อัตราได้รับเงิน</th>
                <th className="num">ยอดตั้งเบิก</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.icode} className={it.visits ? '' : 'muted'}>
                  <td className="wrap">
                    {it.item_name || it.icode}
                    {it.required && <span className="badge text-bg-warning ms-1">จำเป็น</span>}
                    <div className="small-id">{it.icode}</div>
                  </td>
                  <td>{SOURCE_LABEL[it.source]}</td>
                  <td className="num">{int(it.visits)}</td>
                  <td className="num">{int(it.paid)}</td>
                  <td className="num">{int(it.not_paid)}</td>
                  <td className="num">{int(it.denied)}</td>
                  <td className="num">{int(it.not_sent)}</td>
                  <td><Rate value={pct(it.paid, it.visits)} /></td>
                  <td className="num">{money(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  // ---------- แบบ C ----------
  const { minPaid, commonRate } = data.thresholds;
  const rows = data.common.filter((c) => c.fund_code === fundCode);
  return (
    <>
      <p className="small muted">
        รายการ (ทั้งค่าบริการและยา รวมรายการที่ไม่ได้ตั้งค่าในกองทุน) ที่พบใน {Math.round(commonRate * 100)}% ขึ้นไปของเคสที่ได้รับเงิน
        เทียบกับสัดส่วนที่พบในเคสที่เคลมไม่สำเร็จ ({fundCode}: ได้รับเงิน {int(tot.paid_n)} visit, ไม่สำเร็จ {int(tot.fail_n)} visit)
        รายการที่เคสสำเร็จมีแต่เคสไม่สำเร็จไม่มี อยู่ด้านบนของตาราง
      </p>
      {tot.paid_n < minPaid ? (
        <div className="alert alert-info py-2 small mb-0">
          ต้องมีเคสที่ได้รับเงินอย่างน้อย {minPaid} visit จึงจะเทียบได้ (ตอนนี้มี {int(tot.paid_n)} visit)
          ลองเลือกช่วงวันที่กว้างขึ้น หรือนำเข้า REP เพิ่ม
        </div>
      ) : rows.length === 0 ? (
        <p className="muted mb-0">ไม่มีรายการที่พบบ่อยถึงเกณฑ์ในเคสที่ได้รับเงิน</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table-sm table-hover data-table">
              <thead>
                <tr>
                  <th>รายการ</th>
                  <th>ตั้งค่าในกองทุน</th>
                  <th>พบในเคสได้รับเงิน</th>
                  <th>พบในเคสไม่สำเร็จ</th>
                  <th className="num">ส่วนต่าง</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const paid = Number(c.paid_rate) * 100;
                  const fail = c.fail_rate === null ? null : Number(c.fail_rate) * 100;
                  const gap = fail === null ? null : paid - fail;
                  return (
                    <tr key={c.icode}>
                      <td className="wrap">{c.item_name || c.icode}<div className="small-id">{c.icode}</div></td>
                      <td>{c.configured ? 'ใช่' : <span className="muted">ไม่ได้ตั้งค่า</span>}</td>
                      <td><Rate value={paid} /> <span className="small-id">({int(c.paid_with)}/{int(c.paid_n)})</span></td>
                      <td><Rate value={fail} /> {fail !== null && <span className="small-id">({int(c.fail_with)}/{int(c.fail_n)})</span>}</td>
                      <td className={`num ${gap >= 30 ? 'text-danger fw-semibold' : ''}`}>{gap === null ? '–' : `${gap.toFixed(0)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm btn-outline-primary mt-2" onClick={onShowMissing}>
            ดู visit ที่ไม่สำเร็จและขาดรายการเหล่านี้
          </button>
        </>
      )}
    </>
  );
}
