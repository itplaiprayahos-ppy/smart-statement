-- =====================================================================
-- 004_fund_columns_rep.sql : ปรับชื่อคอลัมน์กองทุนเริ่มต้นให้ตรงกับไฟล์ REP จริง
-- ในไฟล์ REP คอลัมน์ PP, DMISHD, Palliative care เป็นคอลัมน์เดี่ยว ไม่ได้อยู่ใต้กลุ่ม DMIS
-- แก้เฉพาะกองทุนที่ยังเป็นค่าเริ่มต้นเดิม ไม่ทับค่าที่ผู้ใช้แก้เองแล้ว
-- =====================================================================
UPDATE funds SET stm_columns = '["DMISHD"]'::jsonb, updated_at = now()
WHERE code = 'DMISHD' AND stm_columns = '["DMIS / DMISHD"]'::jsonb;

UPDATE funds SET stm_columns = '["Palliative care"]'::jsonb, updated_at = now()
WHERE code = 'PALLIATIVE' AND stm_columns = '["DMIS / Palliative care"]'::jsonb;

UPDATE funds SET stm_columns = '["PP"]'::jsonb, updated_at = now()
WHERE code = 'PP' AND stm_columns = '["DMIS / PP"]'::jsonb;
