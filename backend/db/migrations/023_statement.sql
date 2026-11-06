-- =====================================================================
-- 023_statement.sql : Statement (STM) ยืนยันการโอนเงินจริง ต่อจาก REP
--  - ข้อมูล STM เก็บแยกในตาราง stm_lines (ไม่ปนกับ REP ใน nhso_lines) เชื่อมกับ REP ด้วย TRAN_ID
--  - ประเภทไฟล์ "STM" ใช้กับ Statement แบบใหม่ ส่วน Statement รุ่นเก่า (ก่อน 011 ที่เก็บใน nhso_lines)
--    เปลี่ยนเป็น "OLD" เพื่อไม่ให้ปุ่ม "ลบข้อมูล Statement เดิม" ลบ Statement ใหม่ไปด้วย
--  - กองทุนที่ต้องมี Statement (stm_required) ใช้คิดขั้น "ได้รับโอนจริง" ในหน้ารายชื่อคนไข้
-- =====================================================================
ALTER TABLE column_mappings DROP CONSTRAINT IF EXISTS column_mappings_file_type_check;
UPDATE column_mappings SET file_type = 'OLD' WHERE file_type = 'STM';
ALTER TABLE column_mappings ADD CONSTRAINT column_mappings_file_type_check CHECK (file_type IN ('STM', 'REP', 'OLD'));
UPDATE import_batches SET file_type = 'OLD' WHERE file_type = 'STM';

ALTER TABLE funds ADD COLUMN stm_required BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE funds SET stm_required = TRUE WHERE code = 'OFC';

-- รายการจากไฟล์ Statement (ชีต Detail)
--  line_key = TRAN_ID + เลขที่เอกสาร: ไฟล์เดิมนำเข้าซ้ำ = อัปเดต, คนละรอบ (เลขที่เอกสารต่างกัน) = เก็บแยกแล้วรวมยอด
CREATE TABLE stm_lines (
  id             BIGSERIAL PRIMARY KEY,
  batch_id       INTEGER      NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  claim_type     VARCHAR(3)   NOT NULL,
  line_key       TEXT         NOT NULL,
  tran_id        VARCHAR(50)  NOT NULL,
  rep_no         VARCHAR(50),
  hn             VARCHAR(20),
  an             VARCHAR(20),
  pid            VARCHAR(13),
  patient_name   VARCHAR(200),
  service_date   DATE,
  fund           VARCHAR(50),
  claim_amount   NUMERIC(12,2),
  paid_amount    NUMERIC(12,2),             -- โอนจริง (STM) = ชดเชยสุทธิ ในไฟล์ Statement
  error_code     VARCHAR(100),
  stm_doc        VARCHAR(100),              -- เลขที่เอกสาร เช่น eclaim_11344_OPCS_25690811_191032713
  stm_date       DATE,                      -- วันที่ในเลขที่เอกสาร (งวด)
  raw            JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (claim_type, line_key)
);
CREATE INDEX idx_stm_lines_tran ON stm_lines (tran_id);
CREATE INDEX idx_stm_lines_date ON stm_lines (claim_type, service_date);
CREATE INDEX idx_stm_lines_batch ON stm_lines (batch_id);
CREATE INDEX IF NOT EXISTS idx_nhso_lines_tran ON nhso_lines (tran_id);

-- รูปแบบไฟล์ Statement OFC (e-Claim Invoice OPCS) หัวตาราง 2 ชั้นในชีต Detail
INSERT INTO column_mappings (name, claim_type, file_type, sheet_name, mapping) VALUES (
  'Statement OFC (ชีต Detail)', 'OPD', 'STM', 'Detail',
  '{
    "rep_no":       ["REP"],
    "tran_id":      ["TRAN_ID"],
    "hn":           ["HN"],
    "an":           ["AN"],
    "pid":          ["PID"],
    "patient_name": ["ชื่อ - สกุล", "ชื่อ-สกุล"],
    "service_date": ["วันเข้ารักษา"],
    "patient_type": ["ประเภทผู้ป่วย"],
    "fund":         ["กองทุน", "สิทธิหลัก"],
    "claim_amount": ["เรียกเก็บ"],
    "compensated":  ["ชดเชยสุทธิ"],
    "error_code":   ["Error Code"]
  }'::jsonb
) ON CONFLICT (name) DO NOTHING;
