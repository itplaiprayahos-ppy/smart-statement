import { withTransaction } from '../config/db.js';

const COLS = ['batch_id', 'claim_type', 'line_key', 'rep_no', 'tran_id', 'hn', 'an', 'pid',
  'patient_name', 'service_date', 'fund', 'claim_amount', 'compensated', 'error_code', 'fund_amounts', 'stm_doc', 'stm_period', 'raw'];
const CHUNK = 500;

/**
 * บันทึกผลการอ่านไฟล์ลงฐานข้อมูล
 * รายการที่เคยนำเข้าแล้ว (TRAN_ID เดิม) จะถูกอัปเดตเป็นค่าล่าสุดแทนการเพิ่มซ้ำ
 */
export async function saveImport({ fileName, profile, parsed, userId }) {
  return withTransaction(async (client) => {
    const { rows: [batch] } = await client.query(
      `INSERT INTO import_batches (file_name, claim_type, mapping_id, total_rows, error_rows, errors, imported_by,
         stm_doc, stm_period, file_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [fileName, profile.claim_type, profile.id, parsed.totalRows, parsed.errorCount,
        JSON.stringify(parsed.errors), userId, parsed.stmDoc, parsed.stmPeriod, profile.file_type || 'REP'],
    );

    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < parsed.records.length; i += CHUNK) {
      const chunk = parsed.records.slice(i, i + CHUNK);
      const params = [];
      const values = chunk.map((r) => {
        const row = {
          ...r, batch_id: batch.id, raw: JSON.stringify(r.raw), fund_amounts: JSON.stringify(r.fund_amounts || {}),
        };
        const placeholders = COLS.map((c) => {
          params.push(row[c]);
          return `$${params.length}`;
        });
        return `(${placeholders.join(',')})`;
      });
      const updates = COLS.filter((c) => !['claim_type', 'line_key'].includes(c))
        .map((c) => `${c} = EXCLUDED.${c}`).join(', ');

      const { rows } = await client.query(
        `INSERT INTO nhso_lines (${COLS.join(',')}) VALUES ${values.join(',')}
         ON CONFLICT (claim_type, line_key) DO UPDATE SET ${updates}, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        params,
      );
      rows.forEach((r) => (r.inserted ? inserted++ : updated++));
    }

    await client.query(
      'UPDATE import_batches SET inserted_rows = $1, updated_rows = $2 WHERE id = $3',
      [inserted, updated, batch.id],
    );
    return { batchId: batch.id, inserted, updated, errorCount: parsed.errorCount };
  });
}
