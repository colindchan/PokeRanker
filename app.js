const GLOBAL_STORAGE_KEY = "pokemon-ranker-global-v6";
const THEME_KEY = "pokemon-ranker-theme";

// Optional: Set your hosted backend API URL here if hosted separately (e.g. "https://your-api.render.com")
const API_BASE_URL = window.location.origin;

const state = {
  pokemon: [],
  globalResults: {},
  headToHead: {},
  globalMatchups: 0,
  current: [],
  searchQuery: "",
  selectedGen: "all",
  hasApiBackend: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// Toast notification helper
function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 3000);
}

// Calculate NBA 2K Style OVR rating (Scale 60 to 99)
function calculateOvr(elo) {
  const r = elo !== undefined ? elo : 1500;
  // 1500 Elo -> 75 OVR; +20 Elo = +1 OVR
  const ovr = Math.round(75 + (r - 1500) / 20);
  return Math.min(99, Math.max(60, ovr));
}

function getOvrClass(ovr) {
  if (ovr >= 90) return "tier-90";
  if (ovr >= 80) return "tier-80";
  if (ovr >= 70) return "tier-70";
  return "tier-60";
}

// Primary image path builder (Root level part_01/0001_bulbasaur.png)
function getPrimaryImageUrl(pokemon) {
  const numStr = String(pokemon.number).padStart(4, "0");
  const partNum = String(Math.floor((pokemon.number - 1) / 50) + 1).padStart(2, "0");
  const fn = pokemon.fileName || pokemon.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `part_${partNum}/${numStr}_${fn}.png`;
}

function getFallbackImageUrl(pokemon) {
  if (pokemon.remoteUrl) return pokemon.remoteUrl;
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokemon.number}.png`;
}

// Multi-path smart fallback loader
function setImgSrcWithFallback(imgEl, pokemon) {
  const numStr = String(pokemon.number).padStart(4, "0");
  const partNum = String(Math.floor((pokemon.number - 1) / 50) + 1).padStart(2, "0");
  const fn = pokemon.fileName || pokemon.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  imgEl.src = `part_${partNum}/${numStr}_${fn}.png`;
  imgEl.alt = pokemon.name;

  imgEl.onerror = () => {
    imgEl.src = `pokemon_images/part_${partNum}/${numStr}_${fn}.png`;

    imgEl.onerror = () => {
      imgEl.src = getFallbackImageUrl(pokemon);

      imgEl.onerror = () => {
        imgEl.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.number}.png`;
      };
    };
  };
}

// Parse CSV fallback if JS dataset missing
function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(value); value = ""; }
    else value += char;
  }
  values.push(value.replace(/\r$/, ""));
  return values;
}

// Check all previous version keys in LocalStorage to preserve historical user data
function loadSavedLocalStorage() {
  const keys = [
    "pokemon-ranker-global-v6",
    "pokemon-ranker-global-v5",
    "pokemon-ranker-global-v4",
    "pokemon-ranker-global-v3",
    "pokemon-ranker-results-v2",
    "pokemon-ranker-results-v1"
  ];
  for (const k of keys) {
    const raw = localStorage.getItem(k);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.matchups > 0 || (parsed.results && Object.keys(parsed.results).length > 0))) {
          return parsed;
        }
      } catch (e) {}
    }
  }
  return null;
}

// Sync global data with server API
async function syncGlobalApiData() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/stats`);
    if (res.ok) {
      const data = await res.json();
      state.hasApiBackend = true;
      const serverTotal = data.totalMatchups || 0;

      if (serverTotal >= state.globalMatchups) {
        state.globalMatchups = serverTotal;
        if (data.stats) {
          state.globalResults = data.stats;
        }
        if (data.headToHead) {
          state.headToHead = data.headToHead;
        }
        saveGlobalState();
      } else if (state.globalMatchups > 0) {
        // Auto-restore server data if server restarted/reset
        await fetch(`${API_BASE_URL}/api/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            totalMatchups: state.globalMatchups,
            stats: state.globalResults,
            headToHead: state.headToHead,
          }),
        });
      }
      renderMatchup();
      renderRankings();
    }
  } catch (e) {
    state.hasApiBackend = false;
  }
}

async function sendVoteToApi(winnerNumber, loserNumber) {
  if (!state.hasApiBackend) return;
  try {
    await fetch(`${API_BASE_URL}/api/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winner: winnerNumber, loser: loserNumber }),
    });
  } catch (e) {
    console.warn("Failed to sync vote to API backend:", e);
  }
}

async function loadPokemonData() {
  if (window.POKEMON_DATA && Array.isArray(window.POKEMON_DATA) && window.POKEMON_DATA.length > 0) {
    state.pokemon = window.POKEMON_DATA;
  } else {
    // CSV fallback
    const response = await fetch("pokemon_images_log.csv");
    const lines = (await response.text()).trim().split("\n").slice(1);
    state.pokemon = lines.map((line) => {
      const [number, name, pageUrl, image, localFilename] = parseCsvLine(line);
      const num = Number(number);
      let gen = 1;
      if (num <= 151) gen = 1;
      else if (num <= 251) gen = 2;
      else if (num <= 386) gen = 3;
      else if (num <= 493) gen = 4;
      else if (num <= 649) gen = 5;
      else if (num <= 721) gen = 6;
      else if (num <= 809) gen = 7;
      else if (num <= 905) gen = 8;
      else gen = 9;

      const fileName = localFilename.replace(/^\d{4}_/, "").replace(/\.(png|jpg|webp)$/, "");
      return { number: num, name, fileName, remoteUrl: image, gen };
    });
  }

  // Load local storage fallback across all historical version keys
  const savedGlobal = loadSavedLocalStorage();
  if (savedGlobal) {
    state.globalResults = savedGlobal.results || {};
    state.headToHead = savedGlobal.headToHead || {};
    state.globalMatchups = savedGlobal.matchups || 0;
  }

  // Sync with API server if present
  await syncGlobalApiData();

  renderMatchup();
  renderRankings();
}

function saveGlobalState() {
  localStorage.setItem(
    GLOBAL_STORAGE_KEY,
    JSON.stringify({
      results: state.globalResults,
      headToHead: state.headToHead,
      matchups: state.globalMatchups,
    })
  );
}

function getGlobalStats(number) {
  const data = state.globalResults[number] || { wins: 0, losses: 0, elo: 1500 };
  if (data.elo === undefined) data.elo = 1500;
  return data;
}

// Local Elo update (opponent-strength weighted)
function updateLocalElo(winnerNum, loserNum) {
  const winnerStats = getGlobalStats(winnerNum);
  const loserStats = getGlobalStats(loserNum);

  const rW = winnerStats.elo;
  const rL = loserStats.elo;

  const expectedW = 1 / (1 + Math.pow(10, (rL - rW) / 400));
  const K = 32;

  winnerStats.elo = Math.round(rW + K * (1 - expectedW));
  loserStats.elo = Math.round(rL - K * (1 - expectedW));

  state.globalResults[winnerNum] = winnerStats;
  state.globalResults[loserNum] = loserStats;
}

function randomPair() {
  if (state.pokemon.length < 2) return [];
  const first = Math.floor(Math.random() * state.pokemon.length);
  let second = Math.floor(Math.random() * state.pokemon.length);
  while (second === first) {
    second = Math.floor(Math.random() * state.pokemon.length);
  }
  return [state.pokemon[first], state.pokemon[second]];
}

function fillCard(id, pokemon) {
  const card = $(`#${id}`);
  if (!card) return;

  const img = card.querySelector("img");
  setImgSrcWithFallback(img, pokemon);

  card.querySelector(".dex-number").textContent = `#${String(pokemon.number).padStart(4, "0")}`;
  card.querySelector("h3").textContent = pokemon.name;

  const stats = getGlobalStats(pokemon.number);
  const ovr = calculateOvr(stats.elo);

  const badgeEl = card.querySelector(".ovr-badge");
  if (badgeEl) {
    badgeEl.textContent = `${ovr} OVR`;
    badgeEl.className = `ovr-badge ${getOvrClass(ovr)}`;
  }

  const total = stats.wins + stats.losses;
  const winRate = total ? Math.round((stats.wins / total) * 100) : 0;

  card.querySelector(".user-record").textContent = `Global Record: ${stats.wins}W - ${stats.losses}L`;
  card.querySelector(".win-rate").textContent = total ? `${winRate}% win rate` : "No votes";

  const btn = card.querySelector(".pick-button");
  btn.onclick = () => choose(pokemon);
  card.onclick = (e) => {
    if (e.target !== btn && !btn.contains(e.target)) {
      choose(pokemon);
    }
  };
}

function renderMatchup() {
  state.current = randomPair();
  if (state.current.length < 2) return;

  fillCard("card-a", state.current[0]);
  fillCard("card-b", state.current[1]);

  const loadingEl = $("#loading-state");
  const boardEl = $("#matchup-board");
  if (loadingEl) loadingEl.hidden = true;
  if (boardEl) boardEl.hidden = false;

  $("#matchup-count").textContent = state.globalMatchups.toLocaleString();
}

function choose(winner) {
  const loser = state.current.find((p) => p.number !== winner.number);
  if (!loser) return;

  // Local state update
  const winnerStats = getGlobalStats(winner.number);
  winnerStats.wins += 1;
  const loserStats = getGlobalStats(loser.number);
  loserStats.losses += 1;

  // Head to Head tracking
  const h2hKey = `${winner.number}_vs_${loser.number}`;
  state.headToHead[h2hKey] = (state.headToHead[h2hKey] || 0) + 1;

  // Elo rating update based on opponent strength
  updateLocalElo(winner.number, loser.number);

  state.globalMatchups += 1;
  saveGlobalState();

  // Send vote to backend API
  sendVoteToApi(winner.number, loser.number);

  renderMatchup();
  renderRankings();
}

function getSortedPokemon() {
  return [...state.pokemon].sort((a, b) => {
    const sa = getGlobalStats(a.number), sb = getGlobalStats(b.number);
    const ovrA = calculateOvr(sa.elo), ovrB = calculateOvr(sb.elo);
    const totalA = sa.wins + sa.losses, totalB = sb.wins + sb.losses;
    const rateA = totalA ? sa.wins / totalA : 0, rateB = totalB ? sb.wins / totalB : 0;

    return ovrB - ovrA || rateB - rateA || sb.wins - sa.wins || a.number - b.number;
  });
}

function renderRankings() {
  const sorted = getSortedPokemon();

  const query = state.searchQuery.toLowerCase().trim();
  const genFilter = state.selectedGen;

  const filtered = sorted.filter((pokemon) => {
    const matchesGen = genFilter === "all" || String(pokemon.gen) === genFilter;
    const matchesSearch =
      !query ||
      pokemon.name.toLowerCase().includes(query) ||
      String(pokemon.number).includes(query) ||
      `#${String(pokemon.number).padStart(4, "0")}`.includes(query);
    return matchesGen && matchesSearch;
  });

  $("#ranking-summary").textContent = state.globalMatchups
    ? `${state.globalMatchups.toLocaleString()} global matchups`
    : "0 global matchups";

  const tbody = $("#ranking-rows");
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">No Pokémon found matching your query.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((pokemon, index) => {
      const stats = getGlobalStats(pokemon.number);
      const ovr = calculateOvr(stats.elo);
      const ovrClass = getOvrClass(ovr);
      const total = stats.wins + stats.losses;
      const rate = total ? `${Math.round((stats.wins / total) * 100)}%` : "—";
      const primaryUrl = getPrimaryImageUrl(pokemon);
      const fallbackUrl = getFallbackImageUrl(pokemon);

      return `
      <tr>
        <td>#${index + 1}</td>
        <td><span class="ovr-badge ${ovrClass}">${ovr}</span></td>
        <td>
          <div class="rank-name">
            <img src="${primaryUrl}" alt="${pokemon.name}" loading="lazy" onerror="this.onerror=null; this.src='${fallbackUrl}'">
            <div>
              <span>${pokemon.name}</span>
              <div style="font-size: 11px; color: var(--text-muted); font-weight: normal;">#${String(pokemon.number).padStart(4, "0")} · Gen ${pokemon.gen}</div>
            </div>
          </div>
        </td>
        <td class="record">${total ? `${stats.wins}W - ${stats.losses}L` : "No votes"}</td>
        <td class="rate">${rate}</td>
      </tr>`;
    })
    .join("");
}

// Social Share feature
function shareTopTen() {
  const sorted = getSortedPokemon();
  const top10 = sorted.slice(0, 10);
  let text = "🏆 PokéRanker Global Top 10:\n\n";

  top10.forEach((p, idx) => {
    const stats = getGlobalStats(p.number);
    const ovr = calculateOvr(stats.elo);
    const total = stats.wins + stats.losses;
    const rate = total ? `${Math.round((stats.wins / total) * 100)}% win rate` : "unvoted";
    text += `${idx + 1}. ${p.name} (${ovr} OVR) — ${rate}\n`;
  });

  text += "\nVote on Pokémon matchups in PokéRanker!";

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Global Top 10 copied to clipboard!");
    }).catch(() => {
      showToast("Copy failed. Check clipboard permissions.");
    });
  } else {
    showToast("Top 10 generated!");
  }
}

// Event Listeners
document.addEventListener("DOMContentLoaded", () => {
  // Theme initialization
  const savedTheme = localStorage.getItem(THEME_KEY) || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  const themeBtn = $("#theme-toggle");
  if (themeBtn) {
    themeBtn.querySelector(".theme-icon").textContent = savedTheme === "dark" ? "☀️" : "🌙";
    themeBtn.onclick = () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
      themeBtn.querySelector(".theme-icon").textContent = next === "dark" ? "☀️" : "🌙";
    };
  }

  // Navigation tabs switching
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
      ["matchup", "rankings", "disclosure"].forEach((view) => {
        const el = $(`#${view}-view`);
        if (el) el.hidden = tab.dataset.view !== view;
      });
    })
  );

  // Search & Gen Filters
  const searchInput = $("#search-input");
  if (searchInput) {
    searchInput.oninput = (e) => {
      state.searchQuery = e.target.value;
      renderRankings();
    };
  }

  const genFilter = $("#gen-filter");
  if (genFilter) {
    genFilter.onchange = (e) => {
      state.selectedGen = e.target.value;
      renderRankings();
    };
  }

  // Share button
  const shareBtn = $("#share-button");
  if (shareBtn) shareBtn.onclick = shareTopTen;

  // Initial Data Load
  loadPokemonData().catch((err) => {
    console.error("Failed to load Pokédex data:", err);
    $("#loading-state").textContent = "Could not load Pokédex data. Please refresh.";
  });
});
