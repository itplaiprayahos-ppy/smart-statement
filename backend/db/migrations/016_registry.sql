-- =====================================================================
-- 016_registry.sql : ทะเบียนบริการที่เจ้าหน้าที่ผู้รับผิดชอบกองทุนอัปโหลด
-- ใช้เทียบ 3 แหล่ง: ทะเบียน / HOSxP / REP
--  - registry_batches : ประวัติการอัปโหลด (ไฟล์ละกองทุน)
--  - registry_rows    : รายการในทะเบียน (หนึ่งแถว = หนึ่งบริการ)
--    อัปโหลดใหม่จะแทนที่รายการของกองทุนนั้นในช่วงวันที่ที่ไฟล์ครอบคลุม
--  - item_aliases     : ชื่อรายการที่หน้างานพิมพ์ -> icode ของ HOSxP (จับคู่ครั้งเดียว ระบบจำไว้)
-- =====================================================================
CREATE TABLE registry_batches (
  id           SERIAL PRIMARY KEY,
  fund_code    VARCHAR(20)  NOT NULL REFERENCES funds (code) ON UPDATE CASCADE ON DELETE CASCADE,
  file_name    VARCHAR(255) NOT NULL,
  date_from    DATE,
  date_to      DATE,
  total_rows   INT NOT NULL DEFAULT 0,
  valid_rows   INT NOT NULL DEFAULT 0,
  error_rows   INT NOT NULL DEFAULT 0,
  errors       JSONB NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by  INT REFERENCES users (id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_registry_batches_fund ON registry_batches (fund_code, created_at DESC);

CREATE TABLE registry_rows (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      INT NOT NULL REFERENCES registry_batches (id) ON DELETE CASCADE,
  fund_code     VARCHAR(20) NOT NULL,
  row_number    INT,
  service_date  DATE NOT NULL,
  hn            VARCHAR(20),
  hn_key        VARCHAR(20),          -- HN ตัดเลข 0 ด้านหน้า ใช้จับคู่
  cid           VARCHAR(13),
  patient_name  VARCHAR(200),
  item_text     VARCHAR(300),         -- ชื่อรายการตามที่หน้างานพิมพ์
  item_key      VARCHAR(300),         -- ชื่อรายการแบบตัดช่องว่าง ตัวพิมพ์เล็ก
  icode         VARCHAR(20),          -- icode ที่จับคู่ได้ (null = ยังไม่รู้จักรายการ)
  item_name     VARCHAR(300),         -- ชื่อรายการใน HOSxP ของ icode
  qty           NUMERIC(12,2),
  price         NUMERIC(14,2)
);
CREATE INDEX idx_registry_rows_fund_date ON registry_rows (fund_code, service_date);
CREATE INDEX idx_registry_rows_item_key ON registry_rows (item_key) WHERE icode IS NULL;

CREATE TABLE item_aliases (
  alias_key   VARCHAR(300) PRIMARY KEY,
  alias_text  VARCHAR(300) NOT NULL,
  icode       VARCHAR(20)  NOT NULL,
  item_name   VARCHAR(300),
  created_by  INT REFERENCES users (id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
