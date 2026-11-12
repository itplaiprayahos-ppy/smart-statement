-- กองทุนที่ใช้คอลัมน์ "ยอดที่ได้รับ" ร่วมกับกองทุนอื่นในไฟล์ REP (เช่น ฝังเข็ม IMC กับ Telemedicine)
-- rep_subfunds = ค่าในคอลัมน์ "กองทุนย่อย" ของ REP ที่เป็นของกองทุนนี้ (เช่น ["TELEMED"])
-- ถ้าไม่ว่าง ตอนนำเข้าไฟล์จะนับยอดให้กองทุนนี้เฉพาะแถวที่กองทุนย่อยตรงกับค่าที่ตั้งไว้
ALTER TABLE funds ADD COLUMN IF NOT EXISTS rep_subfunds JSONB NOT NULL DEFAULT '[]'::jsonb;
