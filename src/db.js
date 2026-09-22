import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const databasePath = resolve(process.env.DATABASE_PATH || "./data/time-trial.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");

export function initializeDatabase() {
    database.exec(`
        CREATE TABLE IF NOT EXISTS players (
            uuid TEXT PRIMARY KEY,
            nickname TEXT NOT NULL,
            country TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY,
            result_uuid TEXT REFERENCES players(uuid),
            result_time INTEGER,
            match_date INTEGER NOT NULL,
            seed_type TEXT,
            bastion_type TEXT,
            season INTEGER,
            forfeited INTEGER NOT NULL DEFAULT 0,
            decayed INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS match_players (
            match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
            player_uuid TEXT NOT NULL REFERENCES players(uuid) ON DELETE CASCADE,
            PRIMARY KEY (match_id, player_uuid)
        );

        CREATE TABLE IF NOT EXISTS poller_state (
            username TEXT PRIMARY KEY,
            last_success_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS matches_date_idx ON matches (match_date DESC);
        CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players (player_uuid);
    `);
}

initializeDatabase();

const upsertPlayer = database.prepare(`
    INSERT INTO players (uuid, nickname, country)
    VALUES (?, ?, ?)
    ON CONFLICT (uuid) DO UPDATE SET
        nickname = excluded.nickname,
        country = excluded.country,
        updated_at = CURRENT_TIMESTAMP
`);
const insertUnknownPlayer = database.prepare(`
    INSERT INTO players (uuid, nickname)
    VALUES (?, ?)
    ON CONFLICT (uuid) DO NOTHING
`);
const upsertMatch = database.prepare(`
    INSERT INTO matches (
        id, result_uuid, result_time, match_date, seed_type, bastion_type,
        season, forfeited, decayed, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
        result_uuid = excluded.result_uuid,
        result_time = excluded.result_time,
        match_date = excluded.match_date,
        seed_type = excluded.seed_type,
        bastion_type = excluded.bastion_type,
        season = excluded.season,
        forfeited = excluded.forfeited,
        decayed = excluded.decayed,
        source = excluded.source,
        updated_at = CURRENT_TIMESTAMP
`);
const insertMatchPlayer = database.prepare(`
    INSERT INTO match_players (match_id, player_uuid)
    VALUES (?, ?)
    ON CONFLICT DO NOTHING
`);
const saveSuccess = database.prepare(`
    INSERT INTO poller_state (username, last_success_at, last_error)
    VALUES (?, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT (username) DO UPDATE SET
        last_success_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
`);

const saveMatchesTransaction = database.transaction((username, matches) => {
    for (const match of matches) {
        for (const player of match.players || []) {
            upsertPlayer.run(player.uuid, player.nickname, player.country || null);
        }

        const resultUuid = match.result?.uuid || null;
        if (resultUuid && !(match.players || []).some(player => player.uuid === resultUuid)) {
            insertUnknownPlayer.run(resultUuid, resultUuid);
        }

        upsertMatch.run(
            match.id,
            resultUuid,
            Number.isFinite(match.result?.time) ? match.result.time : null,
            match.date,
            match.seedType || match.seed?.overworld || null,
            match.bastionType || match.seed?.nether || null,
            match.season ?? null,
            match.forfeited ? 1 : 0,
            match.decayed ? 1 : 0,
            JSON.stringify(match)
        );

        for (const player of match.players || []) {
            insertMatchPlayer.run(match.id, player.uuid);
        }
    }
    saveSuccess.run(username);
});

export function saveMatches(username, matches) {
    saveMatchesTransaction(username, matches);
}

export function savePollError(username, error) {
    database.prepare(`
        INSERT INTO poller_state (username, last_error)
        VALUES (?, ?)
        ON CONFLICT (username) DO UPDATE SET
            last_error = excluded.last_error,
            updated_at = CURRENT_TIMESTAMP
    `).run(username, String(error.message || error).slice(0, 1000));
}

export function checkDatabase() {
    return database.prepare("SELECT 1 AS ok").get();
}

export function getPlayersWithRuns() {
    return database.prepare(`
        WITH player_runs AS (
            SELECT
                p.uuid,
                p.nickname,
                p.country,
                m.id,
                CASE WHEN m.result_uuid = p.uuid THEN m.result_time ELSE NULL END AS time,
                m.match_date,
                m.seed_type,
                m.bastion_type,
                m.forfeited,
                m.decayed,
                ROW_NUMBER() OVER (PARTITION BY p.uuid ORDER BY m.match_date DESC) AS run_number
            FROM players p
            JOIN match_players mp ON mp.player_uuid = p.uuid
            JOIN matches m ON m.id = mp.match_id
        )
        SELECT * FROM player_runs
        WHERE run_number <= 100
        ORDER BY nickname ASC, match_date DESC
    `).all();
}

export function getLeaderboard() {
    return database.prepare(`
        WITH eligible AS (
            SELECT
                p.uuid,
                p.nickname,
                p.country,
                m.result_time,
                ROW_NUMBER() OVER (PARTITION BY p.uuid ORDER BY m.match_date DESC) AS run_number
            FROM players p
            JOIN match_players mp ON mp.player_uuid = p.uuid
            JOIN matches m ON m.id = mp.match_id
            WHERE m.result_uuid = p.uuid
              AND m.result_time IS NOT NULL
              AND m.forfeited = 0
        )
        SELECT
            uuid,
            nickname,
            country,
            COUNT(*) AS runs,
            CAST(ROUND(AVG(result_time)) AS INTEGER) AS average_time,
            MAX(result_time) AS best_time
        FROM eligible
        WHERE run_number <= 20
        GROUP BY uuid, nickname, country
        ORDER BY average_time DESC
    `).all();
}

export function getRecentRuns(limit) {
    return database.prepare(`
        SELECT
            m.id,
            m.result_time AS time,
            m.match_date AS date,
            m.seed_type,
            m.bastion_type,
            m.forfeited,
            m.decayed,
            p.uuid,
            p.nickname,
            p.country
        FROM matches m
        LEFT JOIN players p ON p.uuid = m.result_uuid
        ORDER BY m.match_date DESC
        LIMIT ?
    `).all(limit);
}

export function closeDatabase() {
    database.close();
}
