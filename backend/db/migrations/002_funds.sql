-- =====================================================================
-- 002_funds.sql : แยกกองทุนตามรายการค่าบริการ (nondrugitems / drugitems)
-- =====================================================================

-- กองทุนตามหัวข้อใน Statement
-- stm_columns = หัวคอลัมน์ในไฟล์ REP ที่เป็น "ยอดที่ได้รับ" ของกองทุนนี้ (หลายคอลัมน์จะถูกรวมกัน)
--   หัวตารางหลายชั้นเขียนแบบ "กลุ่ม / คอลัมน์ย่อย" เช่น "HC / HC"
CREATE TABLE funds (
  code         VARCHAR(20)  PRIMARY KEY,
  name         VARCHAR(200) NOT NULL,
  stm_columns  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- รายการค่าบริการ/ยาที่ทำให้ visit เข้าเงื่อนไขกองทุน (มีอย่างน้อย 1 รายการ = เข้าเงื่อนไข)
CREATE TABLE fund_items (
  fund_code   VARCHAR(20)  NOT NULL REFERENCES funds(code) ON DELETE CASCADE ON UPDATE CASCADE,
  icode       VARCHAR(20)  NOT NULL,
  item_name   VARCHAR(300),
  source      VARCHAR(10)  NOT NULL CHECK (source IN ('nondrug', 'drug')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (fund_code, icode)
);
CREATE INDEX idx_fund_items_icode ON fund_items (icode);

-- รายการค่าใช้จ่ายของ visit จาก HOSxP (opitemrece) เฉพาะ icode ที่ตั้งค่าไว้ในกองทุน
CREATE TABLE his_opd_items (
  vn          VARCHAR(20)   NOT NULL,
  icode       VARCHAR(20)   NOT NULL,
  vstdate     DATE          NOT NULL,
  qty         NUMERIC(12,2),
  sum_price   NUMERIC(12,2),
  pulled_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (vn, icode)
);
CREATE INDEX idx_his_opd_items_date ON his_opd_items (vstdate);

-- ยอดที่ได้รับแยกตามกองทุน จากไฟล์ REP เช่น {"HC": 1500, "AE": 0}
ALTER TABLE nhso_lines ADD COLUMN fund_amounts JSONB NOT NULL DEFAULT '{}'::jsonb;

-- กองทุนเริ่มต้นสำหรับ OPD (ชื่อคอลัมน์เป็นค่าคาดการณ์ ให้ admin ตรวจกับไฟล์จริงในหน้าตั้งค่ากองทุน)
INSERT INTO funds (code, name, stm_columns, sort_order) VALUES
  ('HC',         'ค่าใช้จ่ายสูง (รวมรังสีรักษา)',      '["HC / HC"]',                       10),
  ('DRUG',       'ค่ายามะเร็ง',                        '["HC / DRUG"]',                     20),
  ('AE',         'อุบัติเหตุฉุกเฉิน (OPAE)',            '["AE / AE", "AE / DRUG"]',          30),
  ('INST',       'อวัยวะเทียม / อุปกรณ์บำบัดรักษา',     '["INST"]',                          40),
  ('DMIS',       'กองทุนโรคเฉพาะ',                     '["DMIS / ยอดชดเชยที่จ่ายจริง"]',     50),
  ('DMISHD',     'Vascular Access',                   '["DMIS / DMISHD"]',                 60),
  ('PALLIATIVE', 'การดูแลผู้ป่วยระยะท้าย',               '["DMIS / Palliative care"]',        70),
  ('PP',         'วางแผนครอบครัว',                     '["DMIS / PP"]',                     80);
