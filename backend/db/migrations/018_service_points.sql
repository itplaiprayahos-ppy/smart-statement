-- =====================================================================
-- 018_service_points.sql : เทียบยอดตามจุดบริการ (ทะเบียนหน้างาน / HOSxP แยก dep_code / REP)
--  - service_points        : จุดบริการ เช่น ทันตกรรม กายภาพ ผูกกับ dep_code ของ HOSxP ได้หลายรหัส
--  - his_opd_dep           : ยอดค่าใช้จ่ายของแต่ละ visit แยกตาม opitemrece.dep_code
--  - point_registry_*      : ทะเบียนยอดรวมต่อคนไข้ต่อวัน ที่หน้างานของแต่ละจุดอัปโหลด
--  - users.point_codes     : จุดบริการที่ผู้ใช้รับผิดชอบ
-- =====================================================================
CREATE TABLE service_points (
  code        VARCHAR(20)  PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  dep_codes   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE his_opd_dep (
  vn        VARCHAR(20)   NOT NULL,
  dep_code  VARCHAR(20)   NOT NULL,
  vstdate   DATE          NOT NULL,
  amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  items     INT           NOT NULL DEFAULT 0,
  PRIMARY KEY (vn, dep_code)
);
CREATE INDEX idx_his_opd_dep_date ON his_opd_dep (vstdate);
CREATE INDEX idx_his_opd_dep_code ON his_opd_dep (dep_code, vstdate);

CREATE TABLE point_registry_batches (
  id           SERIAL PRIMARY KEY,
  point_code   VARCHAR(20)  NOT NULL REFERENCES service_points (code) ON UPDATE CASCADE ON DELETE CASCADE,
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

CREATE TABLE point_registry_rows (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      INT NOT NULL REFERENCES point_registry_batches (id) ON DELETE CASCADE,
  point_code    VARCHAR(20) NOT NULL,
  row_number    INT,
  service_date  DATE NOT NULL,
  hn            VARCHAR(20),
  hn_key        VARCHAR(20),
  cid           VARCHAR(13),
  patient_name  VARCHAR(200),
  amount        NUMERIC(14,2) NOT NULL
);
CREATE INDEX idx_point_rows ON point_registry_rows (point_code, service_date);

ALTER TABLE users ADD COLUMN point_codes JSONB NOT NULL DEFAULT '[]'::jsonb;
