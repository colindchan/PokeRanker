const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "global_stats.json");

// Load or initialize global data
let globalData = {
  totalMatchups: 0,
  stats: {} // pokemon_number -> { wins, losses }
};

if (fs.existsSync(DATA_FILE)) {
  try {
    globalData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
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

  // GET /api/stats -> Return global stats
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
  console.log(`🚀 Pokémon Ranker Global Server running on http://localhost:${PORT}`);
});
