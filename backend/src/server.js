import app from './app.js';
import { env } from './config/env.js';

app.listen(env.port, () => {
  console.log(`claim-recon API พร้อมใช้งานที่ http://localhost:${env.port}`);
});
