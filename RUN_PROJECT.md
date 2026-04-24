# Run This Project (Backend + MCP + Frontend + Webhook Tunnel)

## 0) Prerequisites
- Node.js installed
- `.env` files configured:
  - `backend/.env` (at least `GEMINI_API_KEY`, `GITHUB_TOKEN`, `WEBHOOK_SECRET`)
  - `mcp-server/.env` (if used by your MCP server)

## 1) Start MCP server (port 8000)
```powershell
cd C:\Users\shank\Desktop\MCP-Agent\mcp-server
npm run dev
```

## 2) Start backend (port 4000)
```powershell
cd C:\Users\shank\Desktop\MCP-Agent\backend
node server.js
```

## 3) Start frontend (port 3000)
```powershell
cd C:\Users\shank\Desktop\MCP-Agent\frontend
npm start
```

## 4) (For Webhook Mode) Start tunnel (ngrok)
### If ngrok is already running, keep it running.
```powershell
& "C:\Users\shank\AppData\Local\Microsoft\WinGet\Links\ngrok.exe" http 4000
```

Copy the **Forwarding** HTTPS URL from ngrok, and use this in GitHub webhook:
- `Payload URL`: `https://<ngrok-forwarding-url>/api/webhooks/github`
- `Content type`: `application/json`
- `Secret`: same as `WEBHOOK_SECRET` in `backend/.env`

## 4.1) (Optional) Add Auth to Webhook Mode UI endpoints
Your backend can optionally protect these endpoints:
- `GET /api/webhooks/events`
- `GET /api/webhooks/latest`
- `GET /api/webhooks/history`
- `POST /api/webhooks/reanalyze`

### Step A: set a monitor API key
In `backend/.env`, add:
```env
WEBHOOK_MONITOR_API_KEY=your-monitor-api-key
```

### Step B: how clients must send the key
Backend accepts either:
- Header: `x-api-key: your-monitor-api-key`
- Query param: `?apiKey=your-monitor-api-key`

### Important
The current React UI calls these endpoints without an auth header. If you enable `WEBHOOK_MONITOR_API_KEY`, you must also update the frontend requests to include `x-api-key` or `apiKey`.

Quick approach for debugging: use browser/curl calls with `?apiKey=...`.

## 4.2) If tunnel URL changes / webhook fails
If your tunnel provider gives a new URL (ngrok/localtunnel/local changes), you must update GitHub webhook:
- GitHub webhook **Payload URL** should point to the latest public URL:
  `https://<current-tunnel-url>/api/webhooks/github`
- Then click **Redeliver** or push a new commit.

If delivery errors:
- `401` = wrong `WEBHOOK_SECRET` (signature mismatch)
- `404` = wrong webhook path
- `408`/timeout = tunnel/backend not reachable at that moment

## 5) Test
- Manual mode: use the UI and scan any repo URL.
- Webhook mode: commit/push to your GitHub repo (webhook must be configured).

