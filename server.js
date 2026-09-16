const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "global_stats.json");

// Load or initialize global data
let globalData = {
  totalMatchups: 0,
  stats: {}, // pokemon_number -> { wins, losses }
  headToHead: {} // "winner_vs_loser" -> count
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    globalData.totalMatchups = parsed.totalMatchups || 0;
    globalData.stats = parsed.stats || {};
    globalData.headToHead = parsed.headToHead || {};

    // Ranking is now driven purely by wins/losses (no more Elo tracking),
    // so drop any leftover elo field from previously-saved data.
    for (const num in globalData.stats) {
      delete globalData.stats[num].elo;
    }
  } catch (e) {
    console.error("Error reading global_stats.json, starting fresh.");
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(globalData, null, 2), "utf8");
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
    res.end(JSON.stringify(globalData));
    return;
  }

  // POST /api/vote -> Submit a matchup vote { winner: number, loser: number }
  if (req.method === "POST" && url.pathname === "/api/vote") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { winner, loser } = JSON.parse(body);
        if (winner && loser) {
          if (!globalData.stats[winner]) globalData.stats[winner] = { wins: 0, losses: 0 };
          if (!globalData.stats[loser]) globalData.stats[loser] = { wins: 0, losses: 0 };

          globalData.stats[winner].wins += 1;
          globalData.stats[loser].losses += 1;
          globalData.totalMatchups += 1;

          // Record Head-to-Head
          const h2hKey = `${winner}_vs_${loser}`;
          globalData.headToHead[h2hKey] = (globalData.headToHead[h2hKey] || 0) + 1;

          saveData();

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, totalMatchups: globalData.totalMatchups }));
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
    req.on("end", () => {
      try {
        const { totalMatchups, stats, headToHead } = JSON.parse(body);
        if (totalMatchups && stats) {
          if (totalMatchups > globalData.totalMatchups) {
            globalData.totalMatchups = totalMatchups;
          }
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
          saveData();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, totalMatchups: globalData.totalMatchups }));
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

server.listen(PORT, () => {
  console.log(`🚀 PokéRanker Global Server running on http://localhost:${PORT}`);
});
