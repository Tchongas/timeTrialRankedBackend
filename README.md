```bash
sudo bash install.sh
```

The installer installs system requirements, checks the Node version, copies the application to `/opt/time-trial-ranked`, creates the service account and default `.env`, installs dependencies, registers the systemd service, starts it, and checks `/health`.

After installation, edit usernames and website access if needed:

```bash
sudo nano /opt/timeTrialRankedBackend/.env
sudo systemctl restart time-trial-ranked
```

## Manual installation

Install Node and native build tools required by `better-sqlite3`:

```bash
sudo apt update
sudo apt install -y nodejs npm build-essential python3
node --version
npm --version
```

Do not continue if Node is older than version 18.

Create a dedicated service account and application directory:

```bash
sudo useradd --system --home /opt/time-trial-ranked --shell /usr/sbin/nologin timetrial
sudo mkdir -p /opt/time-trial-ranked
sudo chown timetrial:timetrial /opt/time-trial-ranked
```

Upload this project's contents into `/opt/time-trial-ranked`, then install production dependencies:

```bash
cd /opt/time-trial-ranked
sudo -u timetrial npm ci --omit=dev
sudo -u timetrial mkdir -p data
```

## Configuration

Create `/opt/time-trial-ranked/.env`:

```env
PORT=3000
DATABASE_PATH=./data/time-trial.sqlite
TRACKED_USERNAMES=HumorEpiadas
POLL_INTERVAL_MS=5000
ALLOWED_ORIGINS=https://your-site.example
```

Multiple usernames can be separated with commas:

```env
TRACKED_USERNAMES=HumorEpiadas,PlayerTwo,PlayerThree
```

Leaving `ALLOWED_ORIGINS` empty permits public read access from any website. API writes are not exposed.

Protect the configuration and ensure the service owns its files:

```bash
sudo chown -R timetrial:timetrial /opt/time-trial-ranked
sudo chmod 600 /opt/time-trial-ranked/.env
```

## Run with systemd

Install the included service file:

```bash
sudo cp /opt/time-trial-ranked/time-trial-ranked.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now time-trial-ranked
```

Check status and logs:

```bash
sudo systemctl status time-trial-ranked
sudo journalctl -u time-trial-ranked -f
```

Restart after uploading an update:

```bash
cd /opt/time-trial-ranked
sudo -u timetrial npm ci --omit=dev
sudo systemctl restart time-trial-ranked
```

## Public port

The API listens on port `3000` by default. If UFW is enabled, allow that port:

```bash
sudo ufw allow 3000/tcp
```

Test locally on the VPS:

```bash
curl http://127.0.0.1:3000/health
```

Test remotely by replacing the address with the VPS IP:

```text
http://VPS_IP:3000/health
```

## Connecting to the VPS

Oracle Cloud Ubuntu instances use the `ubuntu` user with the SSH key you created/downloaded when the instance was set up:

```bash
ssh -i /path/to/your-key.pem ubuntu@147.15.12.185
```

On Windows PowerShell, if the private key is in Downloads:

```powershell
ssh -i "$env:USERPROFILE\Downloads\your-key.pem" ubuntu@147.15.12.185
```

If Windows complains about key permissions, fix them once:

```powershell
icacls "$env:USERPROFILE\Downloads\your-key.pem" /inheritance:r /grant:r "$env:USERNAME:R"
```

## Updating the server

Everyday update flow — pull the latest code and redeploy:

```bash
cd ~/timeTrialRankedBackend
git fetch origin
git reset --hard origin/main
git clean -fd
sudo bash install.sh
```

The installer is safe to re-run: it preserves `/opt/time-trial-ranked/.env` and the `data/` database, reinstalls dependencies only when needed, and restarts the service.

Quick code-only update without the full installer:

```bash
cd ~/timeTrialRankedBackend
git pull
sudo cp -r src /opt/time-trial-ranked/
sudo chown -R timetrial:timetrial /opt/time-trial-ranked
sudo systemctl restart time-trial-ranked
```

Verify after an update:

```bash
curl http://127.0.0.1:3001/health
sudo journalctl -u time-trial-ranked -f
```

## SQLite data

The database is stored under `data/` and uses WAL mode so polling writes and API reads can run together. Back up the complete `data/` directory to preserve rankings.

## Matching rules

Only MCSR matches with both values below are stored:

```text
category = HOW_DID_WE_GET_HERE
gameMode = default
```

The match ID is the database primary key, so repeated polling updates existing matches instead of creating duplicates.

## Endpoints

```text
GET /health
GET /api/time-trial/players
GET /api/time-trial/leaderboard
GET /api/time-trial/runs?limit=20
```

`/api/time-trial/players` matches the structure consumed by the ranked frontend. It returns up to 100 recent runs per player. The leaderboard uses each player's latest 20 completed, non-forfeited runs and ranks higher average times first.
