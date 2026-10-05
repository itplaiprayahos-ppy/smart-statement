-- =====================================================================
-- 007_stm_rounds.sql : รองรับ Statement หลายรอบ
--  - เก็บเลขเอกสาร STM (เช่น OPUCS256908-01) และเดือนของรอบ (stm_period)
--  - รายการ TRAN_ID เดียวกันที่อยู่คนละรอบ เก็บแยกกัน (เดิมรอบหลังทับรอบแรก)
--    ระบบจะรวมยอดทุกรอบตอนแสดงผล รวมยอดปรับลดที่ติดลบด้วย
-- =====================================================================
ALTER TABLE import_batches ADD COLUMN stm_doc VARCHAR(50), ADD COLUMN stm_period DATE;
ALTER TABLE nhso_lines     ADD COLUMN stm_doc VARCHAR(50), ADD COLUMN stm_period DATE;

-- เติมเลขเอกสารให้ไฟล์ที่นำเข้าแล้ว จากชื่อไฟล์ เช่น STM_11344_OPUCS256908_01.xls -> OPUCS256908-01
UPDATE import_batches b
SET stm_doc = x.m[1] || COALESCE('-' || x.m[2], '')
FROM (SELECT id, regexp_match(file_name, '([A-Z]{2,}[0-9]{6,})(?:[_ ]+([0-9]{1,3}))?') AS m FROM import_batches) x
WHERE x.id = b.id AND x.m IS NOT NULL;

UPDATE import_batches
SET stm_period = make_date(substring(stm_doc from '(25[0-9]{2})(?:0[1-9]|1[0-2])')::int - 543,
                           substring(stm_doc from '25[0-9]{2}(0[1-9]|1[0-2])')::int, 1)
WHERE stm_doc ~ '25[0-9]{2}(0[1-9]|1[0-2])';

UPDATE nhso_lines l
SET stm_doc = b.stm_doc, stm_period = b.stm_period, line_key = l.line_key || '|' || b.stm_doc
FROM import_batches b
WHERE b.id = l.batch_id AND b.stm_doc IS NOT NULL;

CREATE INDEX idx_nhso_lines_date ON nhso_lines (claim_type, service_date);
