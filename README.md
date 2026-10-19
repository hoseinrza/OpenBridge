<p align="center">
  <img src="public/logo-wordmark.svg" alt="OpenBridge" width="380" />
</p>

<h1 align="center">OpenBridge</h1>

<p align="center">A real-time chat application that connects people — built with React + NestJS.</p>

---

## ✨ Features

- 🔐 JWT authentication (register / login)
- 💬 Real-time 1:1 messaging over WebSocket (Socket.IO)
- 👥 Group chats with owner/member roles and membership management (web)
- 🟢 Online/offline presence
- 📎 Private file & image uploads (signed, expiring URLs)
- 😀 Message reactions
- 👤 User profiles (avatar, bio)

## 🧱 Tech stack

| Layer      | Stack                                                |
|------------|------------------------------------------------------|
| Frontend   | React 19, Vite, React Router, Socket.IO client       |
| Backend    | NestJS 10, Socket.IO, Prisma, JWT, Passport          |
| Database   | PostgreSQL (Prisma ORM)                              |

## 🔒 Security

OpenBridge is **not end-to-end encrypted**; the server stores message content
in plaintext. See [docs/SECURITY.md](docs/SECURITY.md) for the confidentiality
model, implemented controls, threat model, and known limitations.

The API requires `JWT_SECRET` and refuses to start without it. In production it
must be at least 32 characters. Cross-origin browser access is deny-by-default
in production; set `CORS_ORIGINS` to a comma-separated allowlist when the web
app and API are on different origins.

## 🧪 Tests

```bash
cd backend
npm run test:e2e   # builds the API and runs the security regression suite
```

The suite boots the Nest app against the configured PostgreSQL database,
creates temporary users, and cleans them up. The web build check is `npm run build`.

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
4. Set `CORS_ORIGINS` on the Render service to your frontend origin
   (e.g. `https://openbridge.vercel.app`). Without it, cross-origin browser
   requests from Vercel are rejected in production.

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
