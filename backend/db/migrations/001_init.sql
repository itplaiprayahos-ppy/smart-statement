-- =====================================================================
-- 001_init.sql : โครงสร้างฐานข้อมูล claim_recon (PostgreSQL 15)
-- =====================================================================

-- ผู้ใช้งานระบบ
CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(50)  NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  full_name      VARCHAR(150),
  role           VARCHAR(10)  NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- รูปแบบการจับคู่คอลัมน์ของไฟล์ Excel จาก สปสช.
-- mapping = { "<ฟิลด์ในระบบ>": ["ชื่อหัวคอลัมน์ที่เป็นไปได้", ...] }
CREATE TABLE column_mappings (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL UNIQUE,
  claim_type   VARCHAR(3)   NOT NULL DEFAULT 'OPD' CHECK (claim_type IN ('OPD', 'IPD')),
  header_row   INTEGER,                 -- NULL = ให้ระบบค้นหาแถวหัวตารางเอง
  sheet_name   VARCHAR(100),            -- NULL = ใช้ชีตแรก
  mapping      JSONB        NOT NULL,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ประวัติการนำเข้าไฟล์
CREATE TABLE import_batches (
  id             SERIAL PRIMARY KEY,
  file_name      VARCHAR(255) NOT NULL,
  claim_type     VARCHAR(3)   NOT NULL,
  mapping_id     INTEGER      REFERENCES column_mappings(id) ON DELETE SET NULL,
  total_rows     INTEGER      NOT NULL DEFAULT 0,
  inserted_rows  INTEGER      NOT NULL DEFAULT 0,
  updated_rows   INTEGER      NOT NULL DEFAULT 0,
  error_rows     INTEGER      NOT NULL DEFAULT 0,
  errors         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  imported_by    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- รายการจากไฟล์ REP / Statement ของ สปสช.
CREATE TABLE nhso_lines (
  id             BIGSERIAL PRIMARY KEY,
  batch_id       INTEGER      NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  claim_type     VARCHAR(3)   NOT NULL,
  line_key       TEXT         NOT NULL,   -- TRAN_ID หรือ REP+PID+วันที่ ใช้กันข้อมูลซ้ำ
  rep_no         VARCHAR(50),
  tran_id        VARCHAR(50),
  hn             VARCHAR(20),
  an             VARCHAR(20),
  pid            VARCHAR(13),
  patient_name   VARCHAR(200),
  service_date   DATE,
  fund           VARCHAR(50),
  claim_amount   NUMERIC(12,2),
  compensated    NUMERIC(12,2),
  error_code     VARCHAR(100),
  raw            JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (claim_type, line_key)
);
CREATE INDEX idx_nhso_lines_match ON nhso_lines (claim_type, pid, service_date);
CREATE INDEX idx_nhso_lines_batch ON nhso_lines (batch_id);

-- สำเนาข้อมูล OPD จาก HOSxP (snapshot ณ เวลาที่ดึง)
CREATE TABLE his_opd_visits (
  vn            VARCHAR(20)  PRIMARY KEY,
  hn            VARCHAR(20)  NOT NULL,
  cid           VARCHAR(13),
  ptname        VARCHAR(200),
  vstdate       DATE         NOT NULL,
  pttype        VARCHAR(10),
  pttype_name   VARCHAR(200),
  hipdata_code  VARCHAR(10),
  pdx           VARCHAR(10),
  income        NUMERIC(12,2),
  uc_money      NUMERIC(12,2),
  pulled_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_his_opd_match ON his_opd_visits (cid, vstdate);
CREATE INDEX idx_his_opd_date  ON his_opd_visits (vstdate);

-- ประวัติการดึงข้อมูลจาก HOSxP
CREATE TABLE his_pull_logs (
  id          SERIAL PRIMARY KEY,
  claim_type  VARCHAR(3)   NOT NULL,
  date_from   DATE         NOT NULL,
  date_to     DATE         NOT NULL,
  row_count   INTEGER      NOT NULL DEFAULT 0,
  pulled_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- บันทึกการเข้าถึงข้อมูล (รองรับ PDPA)
CREATE TABLE access_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(50)  NOT NULL,
  detail      JSONB,
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_access_logs_user ON access_logs (user_id, created_at DESC);
