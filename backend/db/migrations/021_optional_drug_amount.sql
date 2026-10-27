-- แยกยอด "ยา" ออกจากยอดรายการยกเว้น (optional_amount = ค่าบริการอัตโนมัติ + ยา)
-- ให้หน้าจอแสดงได้ว่าค่าบริการอัตโนมัติกี่บาท ยากี่บาท (ต้องดึงข้อมูล HOSxP ใหม่จึงจะมีค่า)
ALTER TABLE his_opd_dep ADD COLUMN IF NOT EXISTS optional_drug_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
