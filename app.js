const GLOBAL_STORAGE_KEY = "pokemon-ranker-global-v6";
const THEME_KEY = "pokemon-ranker-theme";

// Optional: Set your hosted backend API URL here if hosted separately (e.g. "https://pokeranker.onrender.com")
const API_BASE_URL = window.location.origin;

const state = {
  pokemon: [],
  globalResults: {},
  headToHead: {},
  globalMatchups: 0,
  current: [],
  searchQuery: "",
  selectedGens: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  sortBy: "composite",
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

// Wilson score CENTER estimate (not the lower bound): shrinks a small sample
// toward 50% instead of trusting the raw rate outright, but — unlike the
// lower-bound version — a genuinely 50/50 record always centers on exactly
// 0.5 no matter the sample size, rather than reading as "below average"
// until it has a huge number of games. Converges to the raw win rate as
// games played grows.
function shrunkWinRate(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 0.5;
  const z = 1.96; // 95% confidence
  const z2 = z * z;
  const phat = wins / n;
  return (phat + z2 / (2 * n)) / (1 + z2 / n);
}

// Calculate NBA 2K Style OVR rating (Scale 60 to 99), driven entirely by the
// win/loss record, so it's always consistent with what's displayed and needs
// no separately-tracked rating that could drift from it. An average (50%)
// record always lands at 75 OVR, regardless of how many games it's played.
function calculateOvr(stats) {
  if (!stats) return 75;
  const wins = stats.wins || 0;
  const losses = stats.losses || 0;
  const total = wins + losses;
  if (!total) return 75;

  const rate = shrunkWinRate(wins, losses);
  const ovr = Math.round(75 + (rate - 0.5) * 48); // 0 -> 51, 0.5 -> 75, 1 -> 99
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

// Fetch with a timeout, since Render's free tier can take 30-50s to wake up
// from a cold start, which a plain fetch() may otherwise hang on indefinitely
// (especially over a slow/unstable connection) before the browser gives up.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Sync global data with server API. Retries on failure (with backoff) before
// giving up, so a slow cold-start or a flaky connection doesn't get mistaken
// for "the global data was reset" when the server actually still has it.
async function syncGlobalApiData() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(`${API_BASE_URL}/api/stats`, {}, 12000);
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
          await fetchWithTimeout(`${API_BASE_URL}/api/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              totalMatchups: state.globalMatchups,
              stats: state.globalResults,
              headToHead: state.headToHead,
            }),
          }, 12000);
        }
        renderMatchup();
        renderRankings();
        return;
      }
    } catch (e) {
      // Fall through to retry below
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }

  // All attempts failed: don't silently present an empty/local-only view as
  // if the global data were gone — tell the user it's a connectivity issue.
  state.hasApiBackend = false;
  showToast("Couldn't reach the global server — showing locally cached results.");
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
  if (!state.globalResults[number]) {
    state.globalResults[number] = { wins: 0, losses: 0 };
  }
  return state.globalResults[number];
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
  const ovr = calculateOvr(stats);

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

// Animate a number counting up/down to its new value instead of snapping
function animateCount(el, endValue) {
  if (!el) return;
  const startValue = Number(el.dataset.rawValue || 0) || 0;
  if (startValue === endValue) {
    el.textContent = endValue.toLocaleString();
    el.dataset.rawValue = String(endValue);
    return;
  }
  const duration = 400;
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(startValue + (endValue - startValue) * eased).toLocaleString();
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      el.dataset.rawValue = String(endValue);
    }
  }
  requestAnimationFrame(tick);
}

function renderMatchup() {
  state.current = randomPair();
  if (state.current.length < 2) return;

  fillCard("card-a", state.current[0]);
  fillCard("card-b", state.current[1]);

  const cardA = $("#card-a");
  const cardB = $("#card-b");
  if (cardA) cardA.classList.remove("card-picked", "card-not-picked");
  if (cardB) cardB.classList.remove("card-picked", "card-not-picked");

  const loadingEl = $("#loading-state");
  const boardEl = $("#matchup-board");
  if (loadingEl) loadingEl.hidden = true;
  if (boardEl) boardEl.hidden = false;

  animateCount($("#matchup-count"), state.globalMatchups);
}

// Crossfades to the next matchup: highlight the pick, hold briefly so it
// reads clearly, fade the whole board out, swap content while invisible
// (so nothing ever changes mid-motion), then fade back in.
function choose(winner) {
  const loser = state.current.find((p) => p.number !== winner.number);
  if (!loser) return;

  const boardEl = $("#matchup-board");
  const winnerCardId = state.current[0].number === winner.number ? "card-a" : "card-b";
  const loserCardId = winnerCardId === "card-a" ? "card-b" : "card-a";
  const winnerCardEl = $(`#${winnerCardId}`);
  const loserCardEl = $(`#${loserCardId}`);
  if (winnerCardEl) winnerCardEl.classList.add("card-picked");
  if (loserCardEl) loserCardEl.classList.add("card-not-picked");
  if (boardEl) boardEl.style.pointerEvents = "none";

  // Local state update
  const winnerStats = getGlobalStats(winner.number);
  winnerStats.wins += 1;
  const loserStats = getGlobalStats(loser.number);
  loserStats.losses += 1;

  // Head to Head tracking
  const h2hKey = `${winner.number}_vs_${loser.number}`;
  state.headToHead[h2hKey] = (state.headToHead[h2hKey] || 0) + 1;

  state.globalMatchups += 1;
  saveGlobalState();

  // Send vote to backend API
  sendVoteToApi(winner.number, loser.number);

  setTimeout(() => {
    if (boardEl) boardEl.classList.add("is-swapping");
    setTimeout(() => {
      renderMatchup();
      renderRankings();
      if (boardEl) {
        boardEl.classList.remove("is-swapping");
        boardEl.style.pointerEvents = "";
      }
    }, 150);
  }, 220);
}

function getWinRate(stats) {
  const total = stats.wins + stats.losses;
  return total ? stats.wins / total : 0;
}

function getSortedPokemon() {
  return [...state.pokemon].sort((a, b) => {
    const sa = getGlobalStats(a.number), sb = getGlobalStats(b.number);
    const ovrA = calculateOvr(sa), ovrB = calculateOvr(sb);
    const rateA = getWinRate(sa), rateB = getWinRate(sb);

    if (state.sortBy === "winRate") {
      return rateB - rateA || ovrB - ovrA || sb.wins - sa.wins || a.number - b.number;
    }
    return ovrB - ovrA || rateB - rateA || sb.wins - sa.wins || a.number - b.number;
  });
}

function renderRankings() {
  const sorted = getSortedPokemon();

  const query = state.searchQuery.toLowerCase().trim();

  const filtered = sorted.filter((pokemon) => {
    const matchesGen = state.selectedGens.has(pokemon.gen);
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
    const emptyMsg = state.selectedGens.size === 0
      ? "Select at least one generation to view rankings."
      : "No Pokémon found matching your query.";
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">${emptyMsg}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((pokemon, index) => {
      const stats = getGlobalStats(pokemon.number);
      const ovr = calculateOvr(stats);
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

// Social Share feature (Includes website link pokeranker.onrender.com)
function shareTopTen() {
  const sorted = getSortedPokemon();
  const top10 = sorted.slice(0, 10);
  let text = "🏆 PokéRanker Global Top 10:\n\n";

  top10.forEach((p, idx) => {
    const stats = getGlobalStats(p.number);
    const ovr = calculateOvr(stats);
    const total = stats.wins + stats.losses;
    const rate = total ? `${Math.round((stats.wins / total) * 100)}% win rate` : "unvoted";
    text += `${idx + 1}. ${p.name} (${ovr} OVR) — ${rate}\n`;
  });

  text += "\nVote on Pokémon matchups in PokéRanker: https://pokeranker.onrender.com";

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
    const iconEl = themeBtn.querySelector(".theme-icon");
    iconEl.textContent = savedTheme === "dark" ? "☀️" : "🌙";
    themeBtn.onclick = () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
      iconEl.style.transform = "scale(0) rotate(180deg)";
      setTimeout(() => {
        iconEl.textContent = next === "dark" ? "☀️" : "🌙";
        iconEl.style.transform = "scale(1) rotate(0deg)";
      }, 150);
    };
  }

  // Navigation tabs switching, with a sliding indicator behind the active tab
  const tabIndicator = $(".tab-indicator");
  function moveTabIndicator(tabEl) {
    if (!tabIndicator || !tabEl) return;
    tabIndicator.style.width = `${tabEl.offsetWidth}px`;
    tabIndicator.style.transform = `translateX(${tabEl.offsetLeft}px)`;
  }
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
      moveTabIndicator(tab);
      ["matchup", "rankings", "disclosure", "about"].forEach((view) => {
        const el = $(`#${view}-view`);
        if (el) el.hidden = tab.dataset.view !== view;
      });
    })
  );
  moveTabIndicator($(".tab.is-active"));
  window.addEventListener("resize", () => moveTabIndicator($(".tab.is-active")));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => moveTabIndicator($(".tab.is-active")));
  }

  // Search & Gen Filters
  const searchInput = $("#search-input");
  if (searchInput) {
    searchInput.oninput = (e) => {
      state.searchQuery = e.target.value;
      renderRankings();
    };
  }

  $$(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sortBy = btn.dataset.sort;
      $$(".sort-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      renderRankings();
    });
  });

  const genToggleGroup = $("#gen-toggle-group");
  if (genToggleGroup) {
    genToggleGroup.addEventListener("click", (e) => {
      const btn = e.target.closest(".gen-btn");
      if (!btn) return;
      const gen = Number(btn.dataset.gen);
      if (state.selectedGens.has(gen)) {
        state.selectedGens.delete(gen);
        btn.classList.remove("is-active");
      } else {
        state.selectedGens.add(gen);
        btn.classList.add("is-active");
      }
      renderRankings();
    });
  }

  const genToggleAll = $("#gen-toggle-all");
  if (genToggleAll) {
    genToggleAll.addEventListener("click", () => {
      const allSelected = state.selectedGens.size === 9;
      if (allSelected) {
        state.selectedGens.clear();
        $$(".gen-btn").forEach((b) => b.classList.remove("is-active"));
      } else {
        for (let g = 1; g <= 9; g++) state.selectedGens.add(g);
        $$(".gen-btn").forEach((b) => b.classList.add("is-active"));
      }
      renderRankings();
    });
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
