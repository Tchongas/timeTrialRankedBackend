import "dotenv/config";
import express from "express";
import {
    checkDatabase,
    closeDatabase,
    getLeaderboard,
    getPlayersWithRuns,
    getRecentRuns,
    initializeDatabase
} from "./db.js";
import { startPoller } from "./poller.js";

const app = express();
const port = Number.parseInt(process.env.PORT, 10) || 3000;
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean));
const categories = new Set(["HOW_DID_WE_GET_HERE", "HIGH"]);

function requestedCategory(request) {
    const category = String(request.query.category || "HOW_DID_WE_GET_HERE").toUpperCase();
    return categories.has(category) ? category : null;
}

app.disable("x-powered-by");
app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (!origin || !allowedOrigins.size || allowedOrigins.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin || "*");
        response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
});

app.get("/health", (request, response, next) => {
    try {
        checkDatabase();
        response.json({ status: "ok" });
    } catch (error) {
        next(error);
    }
});

app.get("/api/time-trial/players", (request, response, next) => {
    try {
        const category = requestedCategory(request);
        if (!category) return response.status(400).json({ status: "error", message: "Unsupported category" });
        const rows = getPlayersWithRuns(category);
        const players = new Map();
        for (const row of rows) {
            if (!players.has(row.uuid)) {
                players.set(row.uuid, {
                    uuid: row.uuid,
                    nickname: row.nickname,
                    country: row.country,
                    runs: []
                });
            }
            players.get(row.uuid).runs.push({
                id: row.id,
                time: row.time,
                date: row.match_date,
                seedType: row.seed_type,
                bastionType: row.bastion_type,
                forfeited: Boolean(row.forfeited),
                decayed: Boolean(row.decayed)
            });
        }

        response.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
        response.json({ status: "success", data: [...players.values()] });
    } catch (error) {
        next(error);
    }
});

app.get("/api/time-trial/leaderboard", (request, response, next) => {
    try {
        const category = requestedCategory(request);
        if (!category) return response.status(400).json({ status: "error", message: "Unsupported category" });
        response.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
        response.json({ status: "success", data: getLeaderboard(category) });
    } catch (error) {
        next(error);
    }
});

app.get("/api/time-trial/runs", (request, response, next) => {
    try {
        const category = requestedCategory(request);
        if (!category) return response.status(400).json({ status: "error", message: "Unsupported category" });
        const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 20));
        const rows = getRecentRuns(limit, category).map(row => ({
            ...row,
            forfeited: Boolean(row.forfeited),
            decayed: Boolean(row.decayed)
        }));
        response.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
        response.json({ status: "success", data: rows });
    } catch (error) {
        next(error);
    }
});

app.use((error, request, response, next) => {
    console.error(error);
    response.status(500).json({ status: "error", message: "Internal server error" });
});

initializeDatabase();
const stopPoller = startPoller();
const server = app.listen(port, () => console.log(`[server] listening on port ${port}`));

function shutdown() {
    stopPoller();
    server.close(() => {
        closeDatabase();
        process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
