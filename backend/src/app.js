import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isProd } from './config/env.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/users.routes.js';
import mappingRoutes from './routes/mappings.routes.js';
import importRoutes from './routes/imports.routes.js';
import hisRoutes from './routes/his.routes.js';
import reconRoutes from './routes/recon.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import fundRoutes from './routes/funds.routes.js';

const app = express();

// ถ้าวางหลัง reverse proxy (nginx) ให้ใช้ IP จริงของผู้ใช้ใน log และ rate limit
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.use(helmet());
app.use(morgan(isProd ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);

// ทุกเส้นทางด้านล่างต้อง login
app.use('/api', requireAuth);
app.use('/api/users', userRoutes);
app.use('/api/mappings', mappingRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/his', hisRoutes);
app.use('/api/recon', reconRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/funds', fundRoutes);
app.use('/api', notFound);

// production: ให้ Express เสิร์ฟหน้าเว็บที่ build แล้ว (frontend/dist)
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use(errorHandler);

export default app;
