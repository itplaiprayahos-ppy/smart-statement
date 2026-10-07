-- =====================================================================
-- 011_rep_import.sql : เปลี่ยนการนำเข้าจาก Statement เป็นไฟล์ REP ของ e-Claim
--  - แยกประเภทไฟล์ (STM / REP) ทั้งรูปแบบไฟล์และประวัติการนำเข้า ให้ลบข้อมูล STM เดิมได้
--  - กองทุนแบบ "ติดตามยอดรับ" (track_only) ไม่ต้องตั้งรายการ นับเฉพาะยอดที่ได้รับจาก REP
--  - ตั้งคอลัมน์ยอดกองทุนให้ตรงกับหัวตาราง REP (ชีต Detail)
-- =====================================================================
ALTER TABLE column_mappings ADD COLUMN file_type VARCHAR(3) NOT NULL DEFAULT 'STM'
  CHECK (file_type IN ('STM', 'REP'));
ALTER TABLE import_batches ADD COLUMN file_type VARCHAR(3) NOT NULL DEFAULT 'STM';
ALTER TABLE funds ADD COLUMN track_only BOOLEAN NOT NULL DEFAULT FALSE;

-- รูปแบบไฟล์ Statement เดิมปิดใช้งาน (ไม่ลบ) แล้วเพิ่มรูปแบบ REP
UPDATE column_mappings SET is_active = FALSE, updated_at = now() WHERE file_type = 'STM';

INSERT INTO column_mappings (name, claim_type, file_type, sheet_name, mapping) VALUES (
  'e-Claim REP OPD (ชีต Detail)', 'OPD', 'REP', 'Detail',
  '{
    "rep_no":       ["REP No.", "REP"],
    "tran_id":      ["TRAN_ID"],
    "hn":           ["HN"],
    "an":           ["AN"],
    "pid":          ["PID"],
    "patient_name": ["ชื่อ-สกุล", "ชื่อ - สกุล"],
    "service_date": ["วันเข้ารักษา"],
    "patient_type": ["ประเภทผู้ป่วย"],
    "fund":         ["สิทธิหลัก"],
    "claim_amount": ["รวมยอดเรียกเก็บ (1.3) = (1.1)+(1.2)"],
    "compensated":  ["ชดเชยสุทธิ"],
    "error_code":   ["Error Code"]
  }'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- คอลัมน์ยอดกองทุนตามหัวตาราง REP (ผู้ป่วยนอก)
UPDATE funds SET stm_columns = '["ค่าใช้จ่ายสูง (HC) / OPHC"]', updated_at = now() WHERE code = 'HC';
UPDATE funds SET stm_columns = '["อุบัติเหตุฉุกเฉิน (AE) / OPAE"]', updated_at = now() WHERE code = 'AE';
UPDATE funds SET stm_columns = '["อวัยวะเทียม/อุปกรณ์บำบัดรักษา (INST) / OPINST"]', updated_at = now() WHERE code = 'INST';
UPDATE funds SET stm_columns = '[
    "โรคเฉพาะ (DMIS) / CATARACT", "โรคเฉพาะ (DMIS) / CATINST", "โรคเฉพาะ (DMIS) / DMISRC",
    "โรคเฉพาะ (DMIS) / RCUHOSC", "โรคเฉพาะ (DMIS) / RCUHOSR", "โรคเฉพาะ (DMIS) / LLOP",
    "โรคเฉพาะ (DMIS) / LLRGC", "โรคเฉพาะ (DMIS) / LLRGR", "โรคเฉพาะ (DMIS) / LP",
    "โรคเฉพาะ (DMIS) / STROKE-STEMI DRUG", "โรคเฉพาะ (DMIS) / DMIDML", "โรคเฉพาะ (DMIS) / DMICNT",
    "โรคเฉพาะ (DMIS) / DM"
  ]', updated_at = now() WHERE code = 'DMIS';
UPDATE funds SET stm_columns = '["โรคเฉพาะ (DMIS) / DMISHD"]', updated_at = now() WHERE code = 'DMISHD';
UPDATE funds SET stm_columns = '["โรคเฉพาะ (DMIS) / Paliative Care"]', updated_at = now() WHERE code = 'PALLIATIVE';
UPDATE funds SET stm_columns = '["โรคเฉพาะ (DMIS) / PP"]', updated_at = now() WHERE code = 'PP';

-- กองทุนติดตามยอดรับ: FS (Fee Schedule) และ DRUG (ค่ายา)
-- กองทุน DRUG เดิม (ค่ายามะเร็ง) รวมอยู่ใน HC แล้ว จึงนำรหัสมาใช้ใหม่เป็นค่ายาตาม REP
DELETE FROM fund_items WHERE fund_code = 'DRUG';
UPDATE funds SET name = 'ค่ายา (DRUG)', stm_columns = '["DRUG"]', track_only = TRUE, is_active = TRUE,
       pttypes = '[]', updated_at = now()
WHERE code = 'DRUG';
INSERT INTO funds (code, name, stm_columns, sort_order, track_only)
VALUES ('DRUG', 'ค่ายา (DRUG)', '["DRUG"]', 90, TRUE) ON CONFLICT (code) DO NOTHING;
INSERT INTO funds (code, name, stm_columns, sort_order, track_only)
VALUES ('FS', 'ค่าบริการตามรายการ (Fee Schedule)', '["FS"]', 95, TRUE) ON CONFLICT (code) DO NOTHING;
UPDATE funds SET sort_order = 90 WHERE code = 'DRUG';
