import { saveMatches, savePollError } from "./db.js";

const CATEGORY = "HOW_DID_WE_GET_HERE";
const GAME_MODE = "default";
const API_BASE = "https://api.mcsrranked.com/users";

function configuredUsernames() {
    return [...new Set((process.env.TRACKED_USERNAMES || "")
        .split(",")
        .map(username => username.trim())
        .filter(Boolean))];
}

async function fetchMatches(username) {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(username)}/matches`, {
        headers: { accept: "application/json", "user-agent": "time-trial-ranked/1.0" },
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`MCSR API returned ${response.status}`);
    const payload = await response.json();
    if (payload.status !== "success" || !Array.isArray(payload.data)) throw new Error("Unexpected MCSR API response");
    return payload.data.filter(match => match.category === CATEGORY && match.gameMode === GAME_MODE);
}

export function startPoller() {
    const usernames = configuredUsernames();
    const interval = Math.max(5000, Number.parseInt(process.env.POLL_INTERVAL_MS, 10) || 5000);
    let stopped = false;
    let timer;

    const poll = async () => {
        for (const username of usernames) {
            if (stopped) return;
            try {
                const matches = await fetchMatches(username);
                await saveMatches(username, matches);
                console.log(`[poller] ${username}: stored ${matches.length} eligible matches`);
            } catch (error) {
                console.error(`[poller] ${username}:`, error.message);
                try {
                    await savePollError(username, error);
                } catch (databaseError) {
                    console.error(`[poller] unable to save error:`, databaseError.message);
                }
            }
        }
        if (!stopped) timer = setTimeout(poll, interval);
    };

    if (!usernames.length) {
        console.warn("[poller] TRACKED_USERNAMES is empty; API will run without polling");
    } else {
        poll();
    }

    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
