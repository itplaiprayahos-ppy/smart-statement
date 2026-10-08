-- =====================================================================
-- 015_match_mode_icd.sql : วิธีคัด visit เข้ากองทุนแบบที่ 3 "ICD-10"
--   items  = ค่าบริการ     : มีรายการค่าบริการ/ยาที่ตั้งไว้
--   rights = สิทธิการรักษา : ทุก visit ของสิทธิที่เลือก ที่มียอดเรียกเก็บ
--   icd    = ICD-10        : ทุก visit ที่มีรหัสโรคตามที่กำหนด ที่มียอดเรียกเก็บ
-- =====================================================================
ALTER TABLE funds DROP CONSTRAINT IF EXISTS funds_match_mode_check;
ALTER TABLE funds ADD CONSTRAINT funds_match_mode_check CHECK (match_mode IN ('items', 'rights', 'icd'));
