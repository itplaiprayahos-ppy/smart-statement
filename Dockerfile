# ---------- build หน้าเว็บ ----------
FROM node:20-alpine AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine
ENV NODE_ENV=production TZ=Asia/Bangkok
RUN apk add --no-cache tzdata
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/ ./
COPY --from=web /app/frontend/dist /app/frontend/dist
USER node
EXPOSE 4000
# อัปเดต schema ก่อนเริ่ม API ทุกครั้ง (รันซ้ำได้ ไม่ทำซ้ำไฟล์ที่รันแล้ว)
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
