-- =====================================================================
-- 020_optional_fee_items.sql : ค่าบริการที่ติดอัตโนมัติ (เช่น ค่าบริการผู้ป่วยนอก 50 บาท)
-- ทะเบียนของห้อง/แผนกจะรวมหรือไม่รวมรายการเหล่านี้ก็ได้ ระบบถือว่าตรงทั้งสองแบบ
--  - app_settings                 : ค่าตั้งระบบแบบ key/value (key = optional_fee_items)
--  - his_opd_dep.optional_amount  : ยอดของรายการเหล่านี้ใน visit แยกตาม dep_code (ดึงใหม่จาก HOSxP)
-- =====================================================================
CREATE TABLE IF NOT EXISTS app_settings (
  key         VARCHAR(50)  PRIMARY KEY,
  value       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by  INT          REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE his_opd_dep ADD COLUMN IF NOT EXISTS optional_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
