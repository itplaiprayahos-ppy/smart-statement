-- =====================================================================
-- 006_item_analysis.sql : วิเคราะห์รายการค่าบริการ
--  - fund_items.required : รายการจำเป็นของกองทุน (แบบ A)
--  - his_opd_items เก็บทุกรายการของ visit ที่เข้าเกณฑ์กองทุน พร้อมชื่อรายการ (ใช้เทียบกับเคสที่เคลมสำเร็จ แบบ C)
-- =====================================================================
ALTER TABLE fund_items ADD COLUMN required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE his_opd_items
  ADD COLUMN item_name VARCHAR(300),
  ADD COLUMN source    VARCHAR(10);

CREATE INDEX idx_his_opd_items_icode ON his_opd_items (icode);
