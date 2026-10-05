-- =====================================================================
-- ฐานข้อมูล HOSxP จำลอง สำหรับทดลองระบบบนเครื่องนักพัฒนาเท่านั้น
-- มีเฉพาะตาราง/ฟิลด์ที่ระบบใช้ ข้อมูลทั้งหมดเป็นข้อมูลสมมติ
-- วิธีใช้: createdb hos_mock && psql -d hos_mock -f db/dev/mock_hosxp.sql
-- =====================================================================
DROP TABLE IF EXISTS opitemrece, nondrugitems, drugitems, vn_stat, patient, pttype;

CREATE TABLE pttype (
  pttype        VARCHAR(2) PRIMARY KEY,
  name          VARCHAR(200),
  hipdata_code  VARCHAR(10),
  isuse         CHAR(1) DEFAULT 'Y'
);
INSERT INTO pttype VALUES
  ('10', 'บัตรทอง (UC)', 'UCS', 'Y'),
  ('20', 'ข้าราชการ', 'OFC', 'Y'),
  ('30', 'ชำระเงินเอง', 'A1', 'Y'),
  ('99', 'บัตรทอง (เลิกใช้)', 'UCS', 'N');

CREATE TABLE patient (
  hn     VARCHAR(9) PRIMARY KEY,
  cid    VARCHAR(13),
  pname  VARCHAR(25),
  fname  VARCHAR(100),
  lname  VARCHAR(100)
);
INSERT INTO patient (hn, cid, pname, fname, lname)
SELECT lpad(i::text, 9, '0'),
       '3' || lpad((100000000000 + i * 7919)::text, 12, '0'),
       CASE WHEN i % 2 = 0 THEN 'นาง' ELSE 'นาย' END,
       'ทดสอบ' || i, 'สมมติ'
FROM generate_series(1, 40) AS i;

CREATE TABLE vn_stat (
  vn        VARCHAR(13) PRIMARY KEY,
  hn        VARCHAR(9),
  vstdate   DATE,
  pttype    VARCHAR(2),
  pdx       VARCHAR(7),
  income    NUMERIC(12,2),
  uc_money  NUMERIC(12,2)
);
INSERT INTO vn_stat (vn, hn, vstdate, pttype, pdx, income, uc_money)
SELECT to_char(d, 'YYMMDD') || lpad(g::text, 6, '0'),
       lpad((((g * 7) % 40) + 1)::text, 9, '0'),
       d,
       pt,
       (ARRAY['J069','I10','E119','K297','M545'])[(g % 5) + 1],
       inc,
       CASE WHEN pt = '30' THEN 0 ELSE inc END
FROM (
  SELECT g,
         DATE '2026-09-01' + (g % 30) AS d,
         CASE g % 5 WHEN 0 THEN '20' WHEN 1 THEN '30' ELSE '10' END AS pt,
         (200 + (g * 37) % 800)::numeric AS inc
  FROM generate_series(1, 90) AS g
) s;

-- ผู้ป่วยคนเดียวกันมา 2 ครั้งในวันเดียว (ใช้ทดสอบสถานะ "จับคู่ได้หลายรายการ")
INSERT INTO vn_stat VALUES
  ('260915900001', '000000005', '2026-09-15', '10', 'J069', 350, 350),
  ('260915900002', '000000005', '2026-09-15', '10', 'R509', 420, 420);

-- ---------------------------------------------------------------------
-- รายการค่าบริการ / ยา และค่าใช้จ่ายราย visit (ใช้ทดสอบการแยกกองทุน)
-- ---------------------------------------------------------------------
CREATE TABLE nondrugitems (
  icode   VARCHAR(7) PRIMARY KEY,
  name    VARCHAR(200),
  price    NUMERIC(12,2),
  istatus  CHAR(1) DEFAULT 'Y'
);
INSERT INTO nondrugitems VALUES
  ('3000001', 'CT Scan สมอง', 3500, 'Y'),
  ('3000002', 'ฉายรังสีรักษา', 2000, 'Y'),
  ('3000009', 'CT Scan (รหัสเก่า เลิกใช้)', 3000, 'N'),
  ('3100001', 'ค่าทำแผลอุบัติเหตุ', 300, 'Y'),
  ('3200001', 'เลนส์แก้วตาเทียม', 2800, 'Y'),
  ('3300001', 'ฝังยาคุมกำเนิด', 800, 'Y'),
  ('3400001', 'ค่าบริการผู้ป่วยนอก', 50, 'Y');

CREATE TABLE drugitems (
  icode     VARCHAR(7) PRIMARY KEY,
  name      VARCHAR(200),
  strength  VARCHAR(100),
  istatus   CHAR(1) DEFAULT 'Y'
);
INSERT INTO drugitems VALUES
  ('1600001', 'Capecitabine', '500 mg', 'Y'),
  ('1600009', 'Capecitabine (เลิกใช้)', '150 mg', 'N'),
  ('1000001', 'Paracetamol', '500 mg', 'Y');

CREATE TABLE opitemrece (
  hos_guid   SERIAL PRIMARY KEY,
  vn         VARCHAR(13),
  an         VARCHAR(9),
  hn         VARCHAR(9),
  vstdate    DATE,
  icode      VARCHAR(7),
  qty        NUMERIC(12,2),
  sum_price  NUMERIC(12,2)
);
-- ทุก visit มีค่าบริการทั่วไปและยาพื้นฐาน
INSERT INTO opitemrece (vn, hn, vstdate, icode, qty, sum_price)
SELECT vn, hn, vstdate, '3400001', 1, 50 FROM vn_stat
UNION ALL
SELECT vn, hn, vstdate, '1000001', 10, 20 FROM vn_stat;
-- บาง visit มีรายการที่เข้าเงื่อนไขกองทุน
INSERT INTO opitemrece (vn, hn, vstdate, icode, qty, sum_price)
SELECT vn, hn, vstdate, icode, 1, price FROM (
  SELECT v.vn, v.hn, v.vstdate, i.icode, i.price, right(v.vn, 6)::int AS g
  FROM vn_stat v CROSS JOIN (VALUES
    ('3000001', 3500), ('3100001', 300), ('3200001', 2800), ('3300001', 800), ('1600001', 4200)
  ) AS i(icode, price)
) s
WHERE (icode = '3000001' AND g % 7 = 0)
   OR (icode = '3100001' AND g % 9 = 0)
   OR (icode = '3200001' AND g % 11 = 0)
   OR (icode = '3300001' AND g % 13 = 0)
   OR (icode = '1600001' AND g % 8 = 0);
