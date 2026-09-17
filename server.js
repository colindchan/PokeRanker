const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "global_stats.json");

// Optional durable storage: Upstash Redis (REST API, no client library needed).
// Render's local filesystem is ephemeral and gets wiped on every deploy, so
// when these are set, Redis is the source of truth and the local file is
// only ever used as a fallback for local development without credentials.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = "pokeranker:global_data";
const usingRedis = Boolean(REDIS_URL && REDIS_TOKEN);

let globalData = {
  stats: {}, // pokemon_number -> { wins, losses }
  headToHead: {} // "winner_vs_loser" -> count
};

function normalizeData(parsed) {
  const data = {
    stats: (parsed && parsed.stats) || {},
    headToHead: (parsed && parsed.headToHead) || {},
  };
  // Ranking is driven purely by wins/losses, so drop any leftover elo field
  // from previously-saved data.
  for (const num in data.stats) {
    delete data.stats[num].elo;
  }
  return data;
}

async function loadData() {
  if (usingRedis) {
    try {
      const res = await fetch(`${REDIS_URL}/get/${REDIS_KEY}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      });
      const body = await res.json();
      if (body.result) {
        console.log("Loaded global data from Redis.");
        return normalizeData(JSON.parse(body.result));
      }
      console.log("No existing data in Redis yet — starting fresh.");
    } catch (e) {
      console.error("Error reading from Redis, starting fresh:", e);
    }
    return normalizeData(null);
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      return normalizeData(JSON.parse(raw));
    } catch (e) {
      console.error("Error reading global_stats.json, starting fresh.");
    }
  }
  return normalizeData(null);
}

async function saveData() {
  if (usingRedis) {
    try {
      await fetch(`${REDIS_URL}/set/${REDIS_KEY}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
        body: JSON.stringify(globalData),
      });
    } catch (e) {
      console.error("Error saving to Redis:", e);
    }
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(globalData, null, 2), "utf8");
}

function getTotalMatchups() {
  let total = 0;
  for (const num in globalData.stats) {
    total += globalData.stats[num].wins || 0;
  }
  return total;
}

const server = http.createServer((req, res) => {
  // Enable CORS for any domain
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/stats -> Return global stats and head-to-head data
  if (req.method === "GET" && url.pathname === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...globalData, totalMatchups: getTotalMatchups() }));
    return;
  }

  // POST /api/vote -> Submit a matchup vote { winner: number, loser: number }
  if (req.method === "POST" && url.pathname === "/api/vote") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { winner, loser } = JSON.parse(body);
        if (winner && loser) {
          if (!globalData.stats[winner]) globalData.stats[winner] = { wins: 0, losses: 0 };
          if (!globalData.stats[loser]) globalData.stats[loser] = { wins: 0, losses: 0 };

          globalData.stats[winner].wins += 1;
          globalData.stats[loser].losses += 1;

          // Record Head-to-Head
          const h2hKey = `${winner}_vs_${loser}`;
          globalData.headToHead[h2hKey] = (globalData.headToHead[h2hKey] || 0) + 1;

          await saveData();

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, totalMatchups: getTotalMatchups() }));
          return;
        }
      } catch (e) {
        console.error("Invalid vote payload:", e);
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request payload" }));
    });
    return;
  }

  // POST /api/sync -> Auto-restore / merge client cached global votes
  if (req.method === "POST" && url.pathname === "/api/sync") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { stats, headToHead } = JSON.parse(body);
        if (stats) {
          for (const num in stats) {
            const incoming = stats[num] || {};
            if (!globalData.stats[num]) {
              globalData.stats[num] = { wins: 0, losses: 0 };
            }
            if ((incoming.wins || 0) > globalData.stats[num].wins) {
              globalData.stats[num].wins = incoming.wins;
            }
            if ((incoming.losses || 0) > globalData.stats[num].losses) {
              globalData.stats[num].losses = incoming.losses;
            }
          }
          if (headToHead) {
            for (const k in headToHead) {
              globalData.headToHead[k] = Math.max(globalData.headToHead[k] || 0, headToHead[k]);
            }
          }
          await saveData();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, totalMatchups: getTotalMatchups() }));
          return;
        }
      } catch (e) {
        console.error("Invalid sync payload:", e);
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid sync request" }));
    });
    return;
  }

  // Serve static web app files
  let filePath = path.join(__dirname, url.pathname === "/" ? "index.html" : url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".csv": "text/csv"
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
});

(async () => {
  globalData = await loadData();
  server.listen(PORT, () => {
    console.log(`🚀 PokéRanker Global Server running on http://localhost:${PORT}`);
    console.log(usingRedis ? "Persistence: Upstash Redis" : "Persistence: local file (not durable across deploys)");
  });
})();
