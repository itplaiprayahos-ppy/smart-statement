-- =====================================================================
-- 012_rights_mode_error_codes.sql
--  1) วิธีคัด visit เข้ากองทุน (match_mode)
--     items  = มีรายการค่าบริการ/ยาที่ตั้งค่าอย่างน้อย 1 รายการ + สิทธิตรงเงื่อนไข (เดิม)
--     rights = ทุก visit ของสิทธิที่เลือกที่มียอดเรียกเก็บ ไม่ต้องตั้งรายการ (เช่น กองทุน OFC)
--  2) ตารางรหัสข้อผิดพลาด e-Claim (admin นำเข้าเองจากแหล่งอ้างอิง)
-- =====================================================================
ALTER TABLE funds ADD COLUMN match_mode VARCHAR(10) NOT NULL DEFAULT 'items'
  CHECK (match_mode IN ('items', 'rights'));

-- กองทุนรหัส OFC ที่ยังไม่มีรายการค่าบริการ ตั้งให้คัดตามสิทธิอย่างเดียว
UPDATE funds f SET match_mode = 'rights', updated_at = now()
WHERE f.code = 'OFC' AND NOT f.track_only
  AND NOT EXISTS (SELECT 1 FROM fund_items fi WHERE fi.fund_code = f.code);

CREATE TABLE error_codes (
  code         VARCHAR(10)  PRIMARY KEY,   -- เลขรหัสไม่มีตัว C นำหน้า เช่น 438
  description  TEXT         NOT NULL,
  guidance     TEXT,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
