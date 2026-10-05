-- =====================================================================
-- 005_fund_group_columns.sql : ยึดชื่อกองทุนตามแถวที่ 13 ของไฟล์ REP
-- ใส่ชื่อหัวกลุ่ม เช่น "HC" ระบบจะรวมทุกคอลัมน์ย่อยใต้กลุ่มนั้น (HC + DRUG)
-- กลุ่มที่มี "ยอดชดเชยที่จ่ายจริง" (เช่น DMIS) ใช้เฉพาะคอลัมน์นั้น
-- แก้เฉพาะกองทุนที่ยังเป็นค่าเริ่มต้นเดิม ไม่ทับค่าที่ผู้ใช้แก้เองแล้ว
-- =====================================================================
UPDATE funds SET stm_columns = '["HC"]'::jsonb, updated_at = now()
WHERE code = 'HC' AND stm_columns = '["HC / HC"]'::jsonb;

UPDATE funds SET stm_columns = '["AE"]'::jsonb, updated_at = now()
WHERE code = 'AE' AND stm_columns = '["AE / AE", "AE / DRUG"]'::jsonb;

UPDATE funds SET stm_columns = '["DMIS"]'::jsonb, updated_at = now()
WHERE code = 'DMIS' AND stm_columns = '["DMIS / ยอดชดเชยที่จ่ายจริง"]'::jsonb;

-- ค่ายามะเร็ง (HC / DRUG) รวมอยู่ในกองทุน HC แล้ว:
-- ย้ายรายการยาของกองทุน DRUG ไปไว้ใน HC และปิดใช้งานกองทุน DRUG (เปิดกลับได้ในหน้าตั้งค่า)
INSERT INTO fund_items (fund_code, icode, item_name, source)
SELECT 'HC', fi.icode, fi.item_name, fi.source
FROM fund_items fi
WHERE fi.fund_code = 'DRUG'
  AND EXISTS (SELECT 1 FROM funds WHERE code = 'DRUG' AND is_active AND stm_columns = '["HC / DRUG"]'::jsonb)
ON CONFLICT (fund_code, icode) DO NOTHING;

UPDATE funds SET is_active = FALSE, updated_at = now()
WHERE code = 'DRUG' AND is_active AND stm_columns = '["HC / DRUG"]'::jsonb;
