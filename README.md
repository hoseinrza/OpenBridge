<p align="center">
  <img src="public/logo-wordmark.svg" alt="OpenBridge" width="380" />
</p>

<h1 align="center">OpenBridge</h1>

<p align="center">A real-time chat application that connects people — built with React + NestJS.</p>

---

## ✨ Features

- 🔐 JWT authentication (register / login)
- 💬 Real-time 1:1 messaging over WebSocket (Socket.IO)
- 🟢 Online/offline presence
- 📎 File & image uploads
- 😀 Message reactions
- 📞 Video call signaling
- 👤 User profiles (avatar, bio)

## 🧱 Tech stack

| Layer      | Stack                                                |
|------------|------------------------------------------------------|
| Frontend   | React 19, Vite, React Router, Socket.IO client       |
| Backend    | NestJS 10, Socket.IO, Prisma, JWT, Passport          |
| Database   | PostgreSQL (Prisma ORM)                              |

## 🚀 Local development

### Prerequisites
- Node.js 20+
- Docker (for PostgreSQL) — or any local PostgreSQL instance

### 1. Backend

```bash
cd backend
docker compose up -d            # starts PostgreSQL on :5432
cp .env.example .env            # then edit values
npm install
npx prisma db push              # create tables
npm run start:dev               # → http://localhost:3000/api
```

### 2. Frontend

```bash
cp .env.example .env            # set VITE_API_URL=http://localhost:3000/api
npm install
npm run dev                     # → http://localhost:5173
```

## ☁️ Deployment

The frontend deploys to **Vercel**; the backend + database deploy to **Render**.

### Backend → Render
1. Push this repo to GitHub.
2. On [Render](https://dashboard.render.com): **New → Blueprint**, pick this repo.
   Render reads [`render.yaml`](render.yaml) and provisions the API + PostgreSQL.
3. Copy the deployed API URL, e.g. `https://openbridge-api.onrender.com`.

### Frontend → Vercel
1. On [Vercel](https://vercel.com): **New Project**, import this repo (root directory).
2. Add an environment variable:
   - `VITE_API_URL = https://openbridge-api.onrender.com/api`
3. Deploy. [`vercel.json`](vercel.json) handles the Vite build and SPA routing.

> The frontend reads a single env var, `VITE_API_URL`; both the REST calls and the
> Socket.IO connection are derived from it.

## 📁 Structure

```
.
├── src/                # React frontend
├── public/             # Static assets + logos
├── backend/            # NestJS API (REST + WebSocket gateway)
│   ├── src/
│   └── prisma/         # Prisma schema
├── render.yaml         # Render blueprint (backend + DB)
└── vercel.json         # Vercel config (frontend)
```
