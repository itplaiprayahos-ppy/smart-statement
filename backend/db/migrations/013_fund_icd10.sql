-- =====================================================================
-- 013_fund_icd10.sql : เงื่อนไขรหัสโรค (ICD-10) ต่อกองทุน
--  - icd10_codes : รหัสโรคหรือขึ้นต้นด้วย (ไม่มีจุด) เช่น ["H25", "Z515"]  ว่าง = ไม่กรองรหัสโรค
--  - icd10_scope : any = โรคหลักหรือโรครอง, pdx = เฉพาะโรคหลัก
--  - his_opd_dx  : รหัสวินิจฉัยทุกตัวของ visit จาก HOSxP (ovstdiag)
-- เงื่อนไขรหัสโรคใช้ร่วมกับเงื่อนไขเดิม (และ): ต้องผ่านทั้งรายการ/สิทธิ และรหัสโรค
-- =====================================================================
ALTER TABLE funds
  ADD COLUMN icd10_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN icd10_scope VARCHAR(5) NOT NULL DEFAULT 'any' CHECK (icd10_scope IN ('any', 'pdx'));

CREATE TABLE his_opd_dx (
  vn        VARCHAR(20) NOT NULL,
  icd10     VARCHAR(10) NOT NULL,
  diagtype  VARCHAR(2),
  vstdate   DATE        NOT NULL,
  PRIMARY KEY (vn, icd10)
);
CREATE INDEX idx_his_opd_dx_date ON his_opd_dx (vstdate);
