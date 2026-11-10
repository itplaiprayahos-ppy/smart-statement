# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reconciliation tool for Thai hospital OPD claims: compares visits pulled from the **HOSxP v4** HIS database against **REP / Statement (STM)** xlsx files downloaded from NHSO e-Claim (สปสช.), then reports unsent, rejected, or mismatched-amount visits. `README.md` (Thai, very long, versioned by feature "v34–v57") is the authoritative domain spec — grep it before changing business rules. The user prefers replies in Thai.

## Commands

No root `package.json`; run inside `backend/` or `frontend/`. No tests, linter, or formatter exist (`backend/tests/` is empty).

```bash
docker compose up -d db            # PostgreSQL 15 on localhost:5433
cd backend && cp .env.example .env # then edit DB_*, HOSXP_*, JWT_SECRET, ADMIN_PASSWORD
npm install && npm run migrate && npm run seed
npm run dev                        # API on :4000 (nodemon)
npm run sample                     # generate dev sample data
npm run build:error-codes          # regenerate e-Claim error-code migration
cd frontend && npm install && npm run dev   # Vite on :5173, proxies /api -> :4000
npm run build                      # production bundle (Express serves frontend/dist in prod)
```

Mock HOSxP for local work: `createdb hos_mock && psql -d hos_mock -f backend/db/dev/mock_hosxp.sql`, set `HOSXP_DB=hos_mock`, import `samples/sample_rep_opd_2569-09.xlsx`, pull 1–30 Sep 2569 (2026).

`xlsx` is installed from `cdn.sheetjs.com` (npm version is vulnerable) — installs need internet access to that domain.

## Architecture

- **Backend**: Node ≥20, ESM, Express 4, raw `pg` (no ORM). `routes/*.routes.js` are thin; logic lives in `services/*Service.js`. Schema changes are numbered plain-SQL files in `backend/db/migrations/` (next free number after `023_statement.sql`), applied by `npm run migrate`.
- **Two databases**: the app's own `claim_recon` DB, and a separate **read-only** pool to HOSxP (`default_transaction_read_only=on`). Every HOSxP query lives in `services/hosxpService.js` — fix hospital schema differences there only. Never write to HOSxP.
- **Auth** (`app.js`): everything under `/api` except `/api/auth` and `/api/health` requires login (JWT in httpOnly SameSite=strict cookie). Roles: `admin`, `user`, `executive`; `executive` is blocked at the API from everything except `/dashboard/kpi` and `/status`. Imports, pulls, views, and exports are written to `access_logs` (`utils/audit.js`) — keep this when adding endpoints that expose patient data (PDPA).
- **Data flow**: (1) import REP/STM xlsx through an admin-defined *mapping* ("รูปแบบไฟล์", seeded by migration 011) that detects the header row and column names — upload is processed in memory, never written to disk; rows upsert by `TRAN_ID`. (2) Pull HOSxP by date range (≤93 days), replacing that range's snapshot. (3) Reconcile by **citizen ID + service date**; same-day multiple visits are matched 1:1 by amount order and flagged. Related services: `reconService`, `threeWayService` (registry vs HOSxP vs REP), `fundService` (fund split by pttype/ICD-10/items/activities), `pointService`, `registryService`, `dashboardService`, `errorCodeService`.
- **Frontend**: React 18 + Vite, plain JSX (no TypeScript, no state library), Bootstrap 5, axios in `src/api/`, auth in `context/AuthContext`.
- Deployment: `docker compose up -d --build`; Express serves API and built frontend on :4000 behind an HTTPS proxy (`TRUST_PROXY=1`; prod cookies are `secure`).

## Domain rules that are easy to get wrong

- **Dates**: Buddhist Era (พ.ศ.) and Gregorian both appear in files. Always parse through `backend/src/utils/dates.js` (`parseDate` → `YYYY-MM-DD` CE); year >2400 is converted, 2-digit years 40–99 = พ.ศ. Excel date cells can be off by minutes (old Thai timezone) — the parser rounds; don't re-implement.
- **Money** (changed in v36): visit totals are computed from `opitemrece` at pull time, not from `vn_stat`. `uc_money` = sum of items whose `paidst` is in `HOSXP_CLAIM_PAIDST` (default `02`). `HOSXP_AMOUNT_SOURCE=vn_stat` reverts. A repull is required after rule changes. Financial accuracy has already needed a fix commit — be careful with amount logic.
- **REP vs STM amounts**: resubmitted REP rounds count once for "เรียกเก็บ (REP)" (max) but "ได้รับ (REP)" sums all rounds; "โอนจริง (STM)" sums per `TRAN_ID`. "Rejected" is determined by REP Error Code, not the Deny column. IP rows in OPD files are skipped.
- Field/column glossary (ค่าใช้จ่าย, เรียกเก็บ, ได้รับ, ตั้งเบิก, โอนจริง) is defined in README §"คำศัพท์ที่ใช้ในระบบ"; use those exact names in UI text.

## Claude settings

`.claude/settings.json` denies Read/Edit of `.env` and `.env.*` and enables the sandbox. Do not read `backend/.env`; use `.env.example` for variable names.
