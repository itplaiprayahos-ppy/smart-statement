-- กิจกรรมย่อยของกองทุน (เช่น PP: ทดสอบการตั้งครรภ์ / ฝากครรภ์ / อัลตร้าซาวน์)
-- แต่ละกิจกรรมมีรายการค่าบริการ/ยา และรหัสโรค (ICD-10) ของตัวเอง
-- กองทุนที่คัดตามรายการ (match_mode = items) และมีกิจกรรมที่เปิดใช้งาน:
--   visit เข้าเกณฑ์เมื่อผ่านกิจกรรมใดกิจกรรมหนึ่งครบ (รายการ + รหัสโรคของกิจกรรมนั้น) แทนรายการระดับกองทุน
--   ยอดได้รับยังเป็นระดับกองทุน (คอลัมน์เดียวใน REP) จึงไม่นับเงินซ้ำ
CREATE TABLE IF NOT EXISTS fund_activities (
  id           SERIAL PRIMARY KEY,
  fund_code    VARCHAR(20)  NOT NULL REFERENCES funds(code) ON DELETE CASCADE ON UPDATE CASCADE,
  name         VARCHAR(200) NOT NULL,
  items_mode   VARCHAR(5)   NOT NULL DEFAULT 'any' CHECK (items_mode IN ('any', 'all')),  -- any = มีรายการใดก็ได้ / all = ต้องมีครบ
  icd10_codes  JSONB        NOT NULL DEFAULT '[]'::jsonb,                                 -- ว่าง = ไม่กรองรหัสโรค
  icd10_scope  VARCHAR(5)   NOT NULL DEFAULT 'any' CHECK (icd10_scope IN ('any', 'pdx')),
  sort_order   INT          NOT NULL DEFAULT 0,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fund_activities_fund ON fund_activities (fund_code);

CREATE TABLE IF NOT EXISTS fund_activity_items (
  activity_id  INT          NOT NULL REFERENCES fund_activities(id) ON DELETE CASCADE,
  icode        VARCHAR(20)  NOT NULL,
  item_name    VARCHAR(300),
  source       VARCHAR(10)  NOT NULL DEFAULT 'nondrug' CHECK (source IN ('nondrug', 'drug')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),   -- เวลาเพิ่มรายการ ใช้เตือนให้ดึง HOSxP ใหม่
  PRIMARY KEY (activity_id, icode)
);
CREATE INDEX IF NOT EXISTS idx_fund_activity_items_icode ON fund_activity_items (icode);
