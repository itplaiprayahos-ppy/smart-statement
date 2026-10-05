# ระบบกระทบยอดเบิกจ่าย OPD: HOSxP v4 เทียบ Statement สปสช.

เว็บแอปสำหรับเทียบรายการรับบริการ OPD ใน HOSxP v4 (PostgreSQL) กับไฟล์ REP / Statement ที่ดาวน์โหลดจาก e-Claim เพื่อหารายการที่ยังไม่ส่ง ถูกปฏิเสธ หรือได้รับชดเชยไม่ตรงยอด

| ส่วน | เทคโนโลยี |
|---|---|
| Backend | Node.js 20+, Express, pg, SheetJS, JWT (httpOnly cookie), bcrypt |
| ฐานข้อมูลของระบบ | PostgreSQL 15 (ฐาน `claim_recon` แยกจาก HOSxP) |
| Frontend | React 18 + Vite, Bootstrap 5, SweetAlert2, Chart.js |

## โครงสร้างโปรเจค

```
claim-recon/
├── backend/
│   ├── db/migrations/        ไฟล์ SQL สร้างตาราง (รันตามลำดับชื่อไฟล์)
│   ├── db/dev/mock_hosxp.sql ฐาน HOSxP จำลองสำหรับทดลอง
│   ├── scripts/              migrate.js, seed.js, dev-make-sample.js
│   └── src/
│       ├── config/           env.js, db.js (pool ระบบ + pool HOSxP แบบ read-only)
│       ├── middleware/       auth.js (requireAuth, requireRole), errorHandler.js
│       ├── routes/           auth, users, mappings, imports, his, recon, dashboard
│       ├── services/         excelParser, importService, hosxpService, reconService
│       └── utils/            dates.js (รองรับ พ.ศ.), audit.js, http.js
├── frontend/src/
│   ├── api/client.js         axios + จัดการเซสชันหมดอายุ
│   ├── context/AuthContext.jsx
│   ├── components/           Layout, ProtectedRoute, Modal, StatusBadge, StatusChart, Pagination
│   ├── pages/                Login, Dashboard, Import, ReconOpd, Mappings, Users, Account
│   └── utils/                alert.js (SweetAlert2), format.js
├── samples/                  ไฟล์ REP ตัวอย่าง (ข้อมูลสมมติ)
├── Dockerfile
└── docker-compose.yml
```

## เริ่มต้นใช้งาน (เครื่องนักพัฒนา)

### 1. เตรียมฐานข้อมูล

```bash
# ใช้ Docker
docker compose up -d db          # PostgreSQL 15 ที่ localhost:5433

# หรือใช้ PostgreSQL ที่มีอยู่
createuser -P recon
createdb -O recon claim_recon
```

### 2. Backend

```bash
cd backend
cp .env.example .env             # แก้ค่า DB_*, HOSXP_*, JWT_SECRET, ADMIN_PASSWORD
npm install
npm run migrate                  # สร้างตาราง
npm run seed                     # สร้าง admin และรูปแบบไฟล์เริ่มต้น
npm run dev                      # http://localhost:4000
```

> `xlsx` ติดตั้งจาก `cdn.sheetjs.com` (เวอร์ชันบน npm เก่าและมีช่องโหว่ที่รู้จักแล้ว) เครื่องที่ติดตั้งต้องออกอินเทอร์เน็ตไปโดเมนนี้ได้

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                      # http://localhost:5173 (ส่ง /api ต่อไปที่ :4000 ให้อัตโนมัติ)
```

เข้าสู่ระบบด้วย `ADMIN_USERNAME` / `ADMIN_PASSWORD` จาก `.env` แล้ว **เปลี่ยนรหัสผ่านทันที**

### ทดลองโดยไม่ต่อ HOSxP จริง

```bash
createdb hos_mock
psql -d hos_mock -f backend/db/dev/mock_hosxp.sql
# ตั้ง HOSXP_DB=hos_mock ใน .env
```

จากนั้นนำเข้า `samples/sample_rep_opd_2569-09.xlsx` และดึงข้อมูล HOSxP ช่วง 1–30 ก.ย. 2569 (2026) จะเห็นผลครบทุกสถานะ

## การเชื่อมต่อ HOSxP v4

สร้าง user อ่านอย่างเดียว (แนะนำให้ต่อที่เครื่อง replica):

```sql
CREATE ROLE claim_reader LOGIN PASSWORD 'รหัสที่แข็งแรง';
GRANT CONNECT ON DATABASE hos TO claim_reader;
GRANT USAGE ON SCHEMA public TO claim_reader;
GRANT SELECT ON vn_stat, patient, pttype, opitemrece, nondrugitems, drugitems TO claim_reader;
```

ระบบตั้ง `default_transaction_read_only=on` ให้ทุก connection ของ HOSxP อีกชั้นหนึ่ง

query อยู่ที่ `backend/src/services/hosxpService.js` ที่เดียว ใช้ฟิลด์ `vn_stat (vn, hn, vstdate, pttype, pdx, income, uc_money)`, `patient (cid, pname, fname, lname)` และ `pttype (name, hipdata_code)` หากรพ.ปรับแต่งโครงสร้าง ให้ตรวจด้วย `\d vn_stat` แล้วแก้ที่ไฟล์นี้

## หลักการทำงาน

1. **นำเข้าไฟล์ สปสช.** ระบบหาแถวหัวตารางเอง จับคู่คอลัมน์ตาม "รูปแบบไฟล์" ที่ admin กำหนด แสดงตัวอย่างและแถวที่มีปัญหาก่อนบันทึก รายการที่มี TRAN_ID เดิมจะถูกอัปเดต ไม่เพิ่มซ้ำ
2. **ดึงข้อมูล HOSxP** ตามช่วงวันที่ (ไม่เกิน 93 วันต่อครั้ง) แทนที่ snapshot เดิมของช่วงนั้นทั้งหมด
3. **กระทบยอด** จับคู่ด้วย เลขบัตรประชาชน + วันที่รับบริการ ถ้าผู้ป่วยมาหลายครั้งในวันเดียว ระบบจับคู่ 1:1 ตามลำดับยอดเงินและติดสถานะให้ตรวจสอบ

| สถานะ | ความหมาย |
|---|---|
| ตรงกัน | พบทั้งสองฝั่ง ยอดเท่ากัน |
| ยอดต่าง | พบทั้งสองฝั่ง ยอดไม่เท่ากัน (เลือกได้ว่าเทียบกับยอดเรียกเก็บหรือยอดชดเชย) |
| ถูกปฏิเสธ / ติด C | มีรหัสข้อผิดพลาดจาก สปสช. |
| หลายครั้งในวันเดียว | จับคู่ตามลำดับยอดเงิน ควรตรวจด้วยคน |
| ไม่พบใน Statement | มีใน HOSxP แต่ยังไม่มีผลจาก สปสช. |
| ไม่พบใน HOSxP | มีใน Statement แต่หาใน HOSxP ไม่เจอ |

## แยกกองทุน OPD

แยก visit ตามกองทุนของ Statement (HC, ค่ายามะเร็ง, AE, INST, DMIS ฯลฯ) จากรายการค่าบริการ/ยาที่คนไข้ได้รับ

1. **ตั้งค่ากองทุน** (admin) ที่เมนู "ตั้งค่ากองทุน" ค้นหารายการจาก `nondrugitems` (ค่าบริการ) หรือ `drugitems` (ยา) แล้วเพิ่มเข้ากองทุน visit ที่มีรายการเหล่านี้ **อย่างน้อย 1 รายการ** จะถูกนับเข้ากองทุน
2. **กำหนดคอลัมน์ยอดที่ได้รับ** ของแต่ละกองทุนในไฟล์ REP หัวตารางหลายชั้นเขียนแบบ `กลุ่ม / คอลัมน์ย่อย` เช่น `HC / HC` หลายคอลัมน์จะรวมยอดให้ ดูชื่อที่ถูกต้องได้จาก "หัวคอลัมน์ทั้งหมดในไฟล์" ในหน้าตรวจไฟล์
3. **นำเข้าไฟล์ REP** (หรือนำเข้าซ้ำหลังแก้คอลัมน์) ระบบจะอ่านยอดรายกองทุนเก็บไว้
4. **ดึงข้อมูล HOSxP** ระบบดึงรายการจาก `opitemrece` เฉพาะ icode ที่ตั้งค่าไว้ เพิ่มรายการใหม่ในกองทุนแล้วต้องดึงใหม่
5. **ดูผล** ที่เมนู "แยกกองทุน OPD" สถานะต่อกองทุน: ได้รับเงิน, ไม่ได้รับเงินกองทุนนี้, ถูกปฏิเสธ / ติด C, ไม่พบใน Statement

query ของ HOSxP สำหรับส่วนนี้อยู่ที่ `ITEMS_SQL` และ `SEARCH_SQL` ใน `hosxpService.js`

## สิทธิ์ผู้ใช้

| การทำงาน | admin | user |
|---|:-:|:-:|
| นำเข้าไฟล์ ดึง HOSxP ดูผล ส่งออก Excel | ✓ | ✓ |
| ลบประวัติการนำเข้า | ✓ | |
| จัดการรูปแบบไฟล์ Excel และตั้งค่ากองทุน | ✓ | |
| จัดการผู้ใช้ | ✓ | |

## API หลัก

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | /api/auth/login, /logout, /change-password | |
| GET | /api/auth/me | |
| GET/POST/PUT | /api/users | admin |
| GET/POST/PUT/DELETE | /api/mappings | แก้ไขได้เฉพาะ admin |
| POST | /api/imports/preview | multipart: `file`, `mappingId` |
| POST/GET/DELETE | /api/imports | ลบได้เฉพาะ admin |
| POST | /api/his/opd/pull | `{ dateFrom, dateTo }` |
| GET | /api/recon/opd | `dateFrom, dateTo, fund, compare, onlyClaimable, status, search, page, pageSize` |
| GET | /api/recon/opd/export | พารามิเตอร์เดียวกัน คืนไฟล์ .xlsx |

## ติดตั้งใช้งานจริง

```bash
cp backend/.env.example backend/.env   # ตั้ง NODE_ENV=production และ JWT_SECRET ใหม่
docker compose up -d --build
docker compose exec app node scripts/seed.js
```

แอปเปิดที่พอร์ต 4000 (Express เสิร์ฟทั้ง API และหน้าเว็บ) ควรวางหลัง nginx ที่ใช้ HTTPS และตั้ง `TRUST_PROXY=1` ใน `.env` เมื่อใช้ production cookie จะถูกตั้งเป็น `secure` จึงต้องเข้าผ่าน HTTPS

## ความปลอดภัยและ PDPA

ข้อมูลไม่ออกนอกเครือข่ายรพ. ไฟล์ที่อัปโหลดประมวลผลในหน่วยความจำ ไม่เขียนลงดิสก์ token เก็บใน httpOnly cookie แบบ SameSite=strict มีการจำกัดการลอง login และทุกการดูผล ส่งออก นำเข้า และดึงข้อมูล ถูกบันทึกในตาราง `access_logs`

## งานถัดไปที่แนะนำ

ฝั่ง IPD (จับคู่ด้วย AN จาก `an_stat`), บันทึกการติดตามรายรายการ, กราฟแนวโน้มรายเดือน และนำเข้าหลายไฟล์พร้อมกัน
