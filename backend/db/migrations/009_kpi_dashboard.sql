-- =====================================================================
-- 009_kpi_dashboard.sql : แดชบอร์ดตัวชี้วัด
--  - เป้าหมายตัวชี้วัดต่อกองทุน (%)
--  - บทบาท executive (ผู้บริหาร) เห็นเฉพาะแดชบอร์ด ไม่เห็นข้อมูลรายคนไข้
-- =====================================================================
ALTER TABLE funds
  ADD COLUMN target_send     NUMERIC(5,2) NOT NULL DEFAULT 95,  -- อัตราการส่งเบิก
  ADD COLUMN target_success  NUMERIC(5,2) NOT NULL DEFAULT 90,  -- อัตราเคลมสำเร็จ
  ADD COLUMN target_complete NUMERIC(5,2) NOT NULL DEFAULT 95;  -- ความครบถ้วนของข้อมูล

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user', 'executive'));
