import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`ไม่พบค่า ${name} ในไฟล์ .env`);
  return value;
}

export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
  },
  hosxp: {
    host: process.env.HOSXP_HOST,
    port: Number(process.env.HOSXP_PORT || 5432),
    database: process.env.HOSXP_DB,
    user: process.env.HOSXP_USER,
    password: process.env.HOSXP_PASSWORD,
  },
  // กลุ่มสิทธิ (hipdata_code) ที่ไม่นับเข้ากองทุนเสมอ เช่น ชำระเงินเอง คั่นด้วยจุลภาค
  excludedHipdata: String(process.env.EXCLUDED_HIPDATA ?? 'XXX')
    .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9_]{1,10}$/.test(s)),
  // จำนวนหลักของ HN ใน HOSxP: HN ในทะเบียนที่สั้นกว่านี้จะถูกเติม 0 ด้านหน้า
  hnLength: Math.min(Math.max(Number(process.env.HN_LENGTH) || 9, 1), 20),
  // รัน migration ที่ค้างอยู่ให้อัตโนมัติตอนเปิดเซิร์ฟเวอร์ (ค่าเริ่มต้น: ไม่รัน แต่หยุดและแจ้งให้รัน npm run migrate)
  autoMigrate: ['1', 'true', 'yes'].includes(String(process.env.AUTO_MIGRATE || '').toLowerCase()),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresHours: Number(process.env.JWT_EXPIRES_HOURS || 8),
};

export const isProd = env.nodeEnv === 'production';
