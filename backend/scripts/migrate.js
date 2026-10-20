// รันไฟล์ .sql ใน db/migrations ตามลำดับชื่อไฟล์ และจำว่ารันไฟล์ไหนไปแล้ว
import { db } from '../src/config/db.js';
import { runMigrations } from '../src/config/migrations.js';

const { failed } = await runMigrations((msg, isError) => (isError ? console.error(msg) : console.log(msg)));
if (failed) process.exitCode = 1;
await db.end();
