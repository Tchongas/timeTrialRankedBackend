# Time Trial Ranked Backend

Node.js service that polls MCSR Ranked for Time Trial matches (`HOW_DID_WE_GET_HERE` / `default`), stores every player's final time in SQLite, and serves the ranked leaderboard API.

- App lives at `/opt/time-trial-ranked` on the VPS
- Runs as systemd service `time-trial-ranked` (user `timetrial`)
- Public API: `https://timetrial.tchongas.red` (Caddy reverse proxy → `127.0.0.1:3001`)

## Connecting to the VPS

```powershell
ssh -i "$env:USERPROFILE\Downloads\your-key.pem" ubuntu@147.15.12.185
```

## Updating after a GitHub change

Exact sequence — pull the new code and redeploy:

```bash
cd ~/timeTrialRankedBackend
git fetch origin
git reset --hard origin/main
git clean -fd
sudo bash install.sh
```

The installer is safe to re-run: it keeps `.env` and the `data/` database, reinstalls deps if needed, and restarts the service.

## Configuration

```bash
sudo nano /opt/time-trial-ranked/.env
sudo systemctl restart time-trial-ranked
```

```env
PORT=3001
DATABASE_PATH=./data/time-trial.sqlite
TRACKED_USERNAMES=HumorEpiadas,PlayerTwo
POLL_INTERVAL_MS=5000
ALLOWED_ORIGINS=
```

## Useful commands

```bash
sudo systemctl restart time-trial-ranked     # restart the app
sudo systemctl status time-trial-ranked      # status
sudo journalctl -u time-trial-ranked -f      # live logs (Ctrl+C to exit)
curl https://timetrial.tchongas.red/health   # public health check
```

## Endpoints

```text
GET /health
GET /api/time-trial/players       # frontend consumes this
GET /api/time-trial/leaderboard
GET /api/time-trial/runs?limit=20
```

## Database

SQLite at `/opt/time-trial-ranked/data/time-trial.sqlite` (WAL mode). To back up rankings, copy the whole `data/` folder.

## Fresh install on a new VPS

```bash
git clone https://github.com/Tchongas/timeTrialRankedBackend.git
cd timeTrialRankedBackend
sudo bash install.sh
```
