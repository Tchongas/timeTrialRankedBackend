import { matchIdsNeedingCompletions, saveMatchCompletions, saveMatches, savePollError } from "./db.js";

const CATEGORIES = new Set(["HOW_DID_WE_GET_HERE", "HIGH"]);
const GAME_MODE = "default";
const API_BASE = "https://api.mcsrranked.com";

const FETCH_HEADERS = { accept: "application/json", "user-agent": "time-trial-ranked/1.0" };

function configuredUsernames() {
    return [...new Set((process.env.TRACKED_USERNAMES || "")
        .split(",")
        .map(username => username.trim())
        .filter(Boolean))];
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`MCSR API returned ${response.status} for ${url}`);
    const payload = await response.json();
    if (payload.status !== "success") throw new Error(`Unexpected MCSR API response for ${url}`);
    return payload.data;
}

async function fetchMatches(username) {
    const data = await fetchJson(`${API_BASE}/users/${encodeURIComponent(username)}/matches`);
    if (!Array.isArray(data)) throw new Error("Unexpected MCSR API response");
    return data.filter(match => CATEGORIES.has(match.category) && match.gameMode === GAME_MODE);
}

async function fetchCompletions(matchId) {
    const data = await fetchJson(`${API_BASE}/matches/${matchId}`);
    return Array.isArray(data?.completions) ? data.completions : [];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fillMissingCompletions(matches) {
    const pendingIds = matchIdsNeedingCompletions(matches.map(match => match.id));
    for (const matchId of pendingIds) {
        const completions = await fetchCompletions(matchId);
        saveMatchCompletions(matchId, completions);
        await sleep(250); // be polite to the MCSR API between detail requests
    }
    return pendingIds.length;
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
                const fetched = await fillMissingCompletions(matches);
                console.log(`[poller] ${username}: stored ${matches.length} eligible matches (${fetched} completions fetched)`);
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
