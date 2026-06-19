import OpenAI from "openai";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_VISION_MODEL = "gpt-4o";

type ApiFootballFixture = {
  fixture: {
    id: number;
    date: string;
    venue?: { name?: string; city?: string };
    status?: { long?: string; short?: string; elapsed?: number | null };
  };
  league: {
    id: number;
    name: string;
    country?: string;
  };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
};

type ExtractedSelection = {
  game: string;
  homeTeam?: string;
  awayTeam?: string;
  competition?: string;
  startsAt?: string;
  market: string;
  selection: string;
  odd: number | null;
  rawText?: string;
  confidence?: number;
  screenshotIndex?: number;
  bookmaker?: string;
};

type EnrichedSelection = ExtractedSelection & {
  fixtureId?: number;
  apiGame?: string;
  apiLeague?: string;
  apiStartsAt?: string;
  impliedProbability?: number | null;
  apiContext?: Record<string, unknown>;
  category?: MarketCategory;
  bookmaker?: string;
  source?: "print" | "api_odds";
};

type MarketCategory =
  | "resultado_final"
  | "dupla_chance"
  | "mais_menos_gols"
  | "ambas_marcam"
  | "handicap"
  | "escanteios"
  | "cartoes"
  | "chutes_gol"
  | "time_marca"
  | "outros";

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function getEnv(name: string) {
  return Netlify.env.get(name) || "";
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bookmakerPriority(name?: string) {
  const normalized = normalizeText(String(name || ""));
  if (normalized.includes("betano")) return 12;
  return 0;
}

function isBetanoBookmaker(name?: string) {
  return normalizeText(String(name || "")).includes("betano");
}

function hasDifficultLine(value: string) {
  return /(^|[^\d])\d+[,.](25|75)([^\d]|$)/.test(String(value || ""));
}

function marketCategory(market: string, selection = ""): MarketCategory {
  const normalized = normalizeText(`${market} ${selection}`);
  if (normalized.includes("handicap") || normalized.includes("asian") || normalized.includes("spread") || normalized.includes("goal line")) return "outros";
  if (normalized.includes("dupla") || normalized.includes("double chance")) return "dupla_chance";
  if (normalized.includes("ambas") || normalized.includes("btts") || normalized.includes("both teams")) return "ambas_marcam";
  if (normalized.includes("escanteio") || normalized.includes("canto") || normalized.includes("corner")) return "escanteios";
  if (normalized.includes("yellow") || normalized.includes("booking")) return "cartoes";
  if (normalized.includes("cart") || normalized.includes("card")) return "cartoes";
  if (normalized.includes("foul") || normalized.includes("offside")) return "outros";
  if (normalized.includes("chute") || normalized.includes("finalizacao") || normalized.includes("shot")) return "chutes_gol";
  if (normalized.includes("mais") || normalized.includes("menos") || normalized.includes("gol") || normalized.includes("over") || normalized.includes("under") || normalized.includes("total")) return "mais_menos_gols";
  if (normalized.includes("time marca") || normalized.includes("team to score") || normalized.includes("clean sheet")) return "time_marca";
  if (normalized.includes("resultado") || normalized.includes("vitoria") || normalized.includes("vence") || normalized.includes("winner") || normalized.includes("1x2")) return "resultado_final";
  return "outros";
}

function requestedMarketCategories(markets: unknown) {
  const values = Array.isArray(markets)
    ? markets
    : typeof markets === "string"
      ? markets.split(",")
      : [];
  const categories = values
    .map((market) => marketCategory(String(market)))
    .filter((category): category is MarketCategory => category !== "outros");
  return [...new Set(categories)];
}

function applyMarketFilter<T extends { market?: string; selection?: string }>(items: T[], requestedMarkets: MarketCategory[]) {
  if (!requestedMarkets.length) return items;
  const allowed = new Set(requestedMarkets);
  return items.filter((item) => allowed.has(marketCategory(String(item.market || ""), String(item.selection || ""))));
}

function fixtureName(fixture: ApiFootballFixture) {
  return `${fixture.teams.home.name} x ${fixture.teams.away.name}`;
}

const TEAM_NAME_ALIASES: Record<string, string> = {
  "africa do sul": "South Africa",
  alemanha: "Germany",
  argelia: "Algeria",
  argentina: "Argentina",
  arabia: "Saudi Arabia",
  "arabia saudita": "Saudi Arabia",
  australia: "Australia",
  austria: "Austria",
  belgica: "Belgium",
  bosnia: "Bosnia and Herzegovina",
  "bosnia e herzegovina": "Bosnia and Herzegovina",
  brasil: "Brazil",
  "cabo verde": "Cape Verde",
  canada: "Canada",
  "costa do marfim": "Ivory Coast",
  colombia: "Colombia",
  "congo dr": "Congo DR",
  "dr congo": "Congo DR",
  "rd congo": "Congo DR",
  "coreia do sul": "Korea Republic",
  "coreia republica": "Korea Republic",
  croacia: "Croatia",
  curacao: "Curacao",
  egito: "Egypt",
  escocia: "Scotland",
  espanha: "Spain",
  "estados unidos": "USA",
  eua: "USA",
  franca: "France",
  gana: "Ghana",
  haiti: "Haiti",
  holanda: "Netherlands",
  inglaterra: "England",
  ira: "IR Iran",
  iraque: "Iraq",
  japao: "Japan",
  jordania: "Jordan",
  marrocos: "Morocco",
  mexico: "Mexico",
  noruega: "Norway",
  "nova zelandia": "New Zealand",
  panama: "Panama",
  paraguai: "Paraguay",
  qatar: "Qatar",
  "republica tcheca": "Czechia",
  senegal: "Senegal",
  suecia: "Sweden",
  suica: "Switzerland",
  tchequia: "Czechia",
  tunisia: "Tunisia",
  turquia: "Turkey",
  uruguai: "Uruguay",
  uzbequistao: "Uzbekistan",
};

function canonicalTeamText(value: string) {
  const normalized = normalizeText(value);
  return normalizeText(TEAM_NAME_ALIASES[normalized] || value);
}

function apiTeamSearchTerm(value: string) {
  const normalized = normalizeText(value);
  return TEAM_NAME_ALIASES[normalized] || value;
}

function dateWithOffset(date: string, offsetDays: number) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function uniqueFixtures(fixtures: ApiFootballFixture[]) {
  const byId = new Map<number, ApiFootballFixture>();
  for (const fixture of fixtures) {
    byId.set(fixture.fixture.id, fixture);
  }
  return [...byId.values()];
}

function splitGameSides(value: string) {
  const parts = normalizeText(value)
    .split(/\s+x\s+|\s+vs\s+|\s+v\s+|\s+contra\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length >= 2 ? [parts[0], parts.slice(1).join(" ")] : null;
}

function teamMatchScore(requestedTeam: string, actualTeam: string) {
  const requested = canonicalTeamText(requestedTeam);
  const actual = canonicalTeamText(actualTeam);
  if (!requested || !actual) return 0;
  if (requested === actual) return 8;
  if (actual.includes(requested) || requested.includes(actual)) return 5;

  const requestedTokens = requested.split(" ").filter((token) => token.length > 2);
  const actualTokens = new Set(actual.split(" ").filter((token) => token.length > 2));
  return requestedTokens.reduce((score, token) => score + (actualTokens.has(token) ? 2 : 0), 0);
}

function matchFixture(requested: string, fixtures: ApiFootballFixture[]) {
  const sides = splitGameSides(requested);

  if (sides) {
    let best: { fixture: ApiFootballFixture; score: number } | null = null;

    for (const fixture of fixtures) {
      const directHome = teamMatchScore(sides[0], fixture.teams.home.name);
      const directAway = teamMatchScore(sides[1], fixture.teams.away.name);
      const reverseHome = teamMatchScore(sides[1], fixture.teams.home.name);
      const reverseAway = teamMatchScore(sides[0], fixture.teams.away.name);
      const directScore = directHome + directAway;
      const reverseScore = reverseHome + reverseAway;
      const bothDirect = directHome >= 2 && directAway >= 2;
      const bothReverse = reverseHome >= 2 && reverseAway >= 2;
      const score = Math.max(directScore, reverseScore);

      if ((!best || score > best.score) && (bothDirect || bothReverse)) {
        best = { fixture, score };
      }
    }

    return best && best.score >= 6 ? best.fixture : null;
  }

  const normalized = normalizeText(requested);
  const tokens = normalized.split(" ").filter((token) => token.length > 2);

  let best: { fixture: ApiFootballFixture; score: number } | null = null;
  for (const fixture of fixtures) {
    const name = normalizeText(fixtureName(fixture));
    const home = normalizeText(fixture.teams.home.name);
    const away = normalizeText(fixture.teams.away.name);
    const score = tokens.reduce((sum, token) => {
      if (name.includes(token)) return sum + 2;
      if (home.includes(token) || away.includes(token)) return sum + 1;
      return sum;
    }, 0);

    if (!best || score > best.score) {
      best = { fixture, score };
    }
  }

  return best && best.score >= Math.max(4, tokens.length * 2) ? best.fixture : null;
}

async function apiFootball(path: string, params: Record<string, string | number | undefined>) {
  const key = getEnv("API_FOOTBALL_KEY");
  if (!key) return [];

  const url = new URL(path, API_FOOTBALL_BASE);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(name, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      "x-apisports-key": key,
    },
  });

  if (!response.ok) return [];

  const data = await response.json();
  const apiErrors = data.errors && typeof data.errors === "object"
    ? Object.values(data.errors).flat().filter(Boolean)
    : [];
  if (apiErrors.length) {
    throw new Error(`API-Football: ${apiErrors.join(" | ")}`);
  }
  return data.response || [];
}

function uniqueItems<T>(items: T[]) {
  return [...new Set(items)];
}

function isUnsupportedMarket(market: string) {
  const normalized = normalizeText(market);
  return [
    "correct score",
    "exact score",
    "first goal scorer",
    "last goal scorer",
    "anytime goal scorer",
    "player",
    "minute",
    "outright",
    "winning margin",
    "method",
    "penalty",
    "handicap",
    "asian",
    "spread",
    "goal line",
  ].some((fragment) => normalized.includes(fragment));
}

function displaySelection(selection: string, fixture: ApiFootballFixture, market: string) {
  const normalized = normalizeText(selection);
  const normalizedMarket = normalizeText(market);
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;

  if (normalizedMarket.includes("double chance")) {
    if (normalized.includes("home") && normalized.includes("draw")) return `${home} ou empate`;
    if (normalized.includes("away") && normalized.includes("draw")) return `Empate ou ${away}`;
    if (normalized.includes("home") && normalized.includes("away")) return `${home} ou ${away}`;
    if (normalized.includes("1x")) return `${home} ou empate`;
    if (normalized.includes("x2")) return `Empate ou ${away}`;
    if (normalized.includes("12")) return `${home} ou ${away}`;
  }

  if (normalizedMarket.includes("winner") || normalizedMarket.includes("1x2") || normalizedMarket.includes("home away")) {
    if (normalized === "home" || normalized === "1") return home;
    if (normalized === "away" || normalized === "2") return away;
    if (normalized === "draw" || normalized === "x") return "Empate";
  }

  if (normalized === "yes") return "Sim";
  if (normalized === "no") return "Nao";
  if (normalized === "none") return "Nenhum";
  if (normalized.startsWith("over ")) return selection.replace(/^over/i, "Mais de");
  if (normalized.startsWith("under ")) return selection.replace(/^under/i, "Menos de");
  if (normalized.startsWith("home ")) return selection.replace(/^home/i, home);
  if (normalized.startsWith("away ")) return selection.replace(/^away/i, away);

  return selection;
}

function displayMarket(market: string, fixture: ApiFootballFixture) {
  const raw = String(market || "").trim();
  const normalized = normalizeText(raw);
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;
  const hasOverUnder = normalized.includes("over under") || normalized.includes("overunder") || normalized.includes("total");

  const sideLabel = (base: string) => {
    if (normalized.includes("home")) return `${base} do ${home}`;
    if (normalized.includes("away")) return `${base} do ${away}`;
    return `${base} totais`;
  };

  if (normalized.includes("double chance") || normalized.includes("dupla chance")) return "Dupla chance";
  if (normalized.includes("both teams") || normalized.includes("btts") || normalized.includes("ambas")) return "Ambas marcam";

  if (normalized.includes("corner") || normalized.includes("escanteio") || normalized.includes("canto")) {
    const base = sideLabel("Escanteios");
    if (normalized.includes("handicap")) return `${base} - handicap`;
    if (normalized.includes("1x2") || normalized.includes("winner")) return "Resultado em escanteios";
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized.includes("yellow") || normalized.includes("booking") || normalized.includes("card") || normalized.includes("cartao")) {
    const base = sideLabel(normalized.includes("yellow") ? "Cartoes amarelos" : "Cartoes");
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized.includes("shot") || normalized.includes("chute") || normalized.includes("finalizacao")) {
    const base = sideLabel("Chutes ao gol");
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized.includes("goal") || normalized.includes("gol")) {
    const base = sideLabel("Gols");
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized.includes("asian handicap")) return "Handicap asiatico";
  if (normalized.includes("handicap")) return "Handicap";
  if (normalized.includes("team to score")) return "Time marca gol";
  if (normalized.includes("clean sheet")) return "Clean sheet";
  if (normalized.includes("winner") || normalized.includes("1x2") || normalized.includes("home away")) return "Resultado final";

  return raw.replace(/_/g, " ");
}

function collectApiOddsSelections(fixture: ApiFootballFixture, oddsResponse: any[], requestedMarkets: MarketCategory[]) {
  const requestedSet = new Set(requestedMarkets);
  const byKey = new Map<string, EnrichedSelection>();
  const bookmakers = oddsResponse?.[0]?.bookmakers || [];

  for (const bookmaker of bookmakers || []) {
    if (!isBetanoBookmaker(bookmaker.name)) continue;

    for (const bet of bookmaker.bets || []) {
      const market = String(bet.name || "");
      if (!market || isUnsupportedMarket(market)) continue;

      for (const value of bet.values || []) {
        const rawSelection = String(value.value || "");
        if (hasDifficultLine(`${market} ${rawSelection}`)) continue;

        const odd = Number.parseFloat(String(value.odd || "0"));
        const category = marketCategory(market, rawSelection);
        if (category === "outros") continue;
        if (requestedSet.size && !requestedSet.has(category)) continue;
        if (!Number.isFinite(odd) || odd < 1.12 || odd > 4.5) continue;

        const selection = displaySelection(rawSelection, fixture, market);
        const key = normalizeText(`${fixture.fixture.id}|${category}|${market}|${selection}`);
        const current = byKey.get(key);
        const priority = bookmakerPriority(bookmaker.name);
        const currentPriority = bookmakerPriority(current?.bookmaker);
        if (!current || priority > currentPriority || (priority === currentPriority && odd > Number(current.odd || 0))) {
          byKey.set(key, {
            game: fixtureName(fixture),
            homeTeam: fixture.teams.home.name,
            awayTeam: fixture.teams.away.name,
            competition: fixture.league.name,
            startsAt: fixture.fixture.date,
            market: displayMarket(market, fixture),
            selection,
            odd,
            confidence: 0.9,
            fixtureId: fixture.fixture.id,
            apiGame: fixtureName(fixture),
            apiLeague: fixture.league.name,
            apiStartsAt: fixture.fixture.date,
            impliedProbability: Number((100 / odd).toFixed(2)),
            category,
            bookmaker: bookmaker.name,
            source: "api_odds",
          });
        }
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => {
      const categoryPriority = requestedMarkets.indexOf(a.category || "outros") - requestedMarkets.indexOf(b.category || "outros");
      if (categoryPriority !== 0) return categoryPriority;
      return Math.abs(Number(a.odd || 0) - 1.7) - Math.abs(Number(b.odd || 0) - 1.7);
    })
    .slice(0, 8);
}

async function searchFixturesByTeams(requested: string) {
  const sides = splitGameSides(requested);
  if (!sides) return [];

  const safe = async (path: string, params: Record<string, string | number | undefined>) => {
    try {
      return await apiFootball(path, params);
    } catch {
      return [];
    }
  };

  const [leftTeams, rightTeams] = await Promise.all([
    safe("/teams", { search: apiTeamSearchTerm(sides[0]) }),
    safe("/teams", { search: apiTeamSearchTerm(sides[1]) }),
  ]);
  const teamIds = uniqueItems([
    ...leftTeams.slice(0, 1).map((item: any) => item.team?.id).filter(Boolean),
    ...rightTeams.slice(0, 1).map((item: any) => item.team?.id).filter(Boolean),
  ]).slice(0, 2);
  const fixtureGroups = await Promise.all(teamIds.flatMap((teamId: number) => [
    safe("/fixtures", { team: teamId, next: 10, timezone: DEFAULT_TIMEZONE }),
    safe("/fixtures", { team: teamId, last: 5, timezone: DEFAULT_TIMEZONE }),
  ]));

  return uniqueFixtures(fixtureGroups.flat());
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

async function fileToDataUrl(file: File) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function normalizeExtractedSelection(item: any, screenshotIndex: number): ExtractedSelection | null {
  const game = String(item.game || item.match || item.event || "").trim();
  const homeTeam = item.homeTeam ? String(item.homeTeam).trim() : "";
  const awayTeam = item.awayTeam ? String(item.awayTeam).trim() : "";
  const market = String(item.market || item.betMarket || "").trim();
  const selection = String(item.selection || item.pick || item.value || "").trim();
  const odd = Number.parseFloat(String(item.odd || item.odds || "").replace(",", "."));
  const category = marketCategory(market, selection);

  if (!game && !(homeTeam && awayTeam)) return null;
  if (category === "outros" || hasDifficultLine(`${market} ${selection}`)) return null;

  const normalizedGame = homeTeam && awayTeam && (!game || isGenericGameText(game))
    ? `${homeTeam} x ${awayTeam}`
    : game || `${homeTeam} x ${awayTeam}`;
  return {
    game: normalizedGame,
    homeTeam: homeTeam || undefined,
    awayTeam: awayTeam || undefined,
    competition: item.competition ? String(item.competition) : undefined,
    startsAt: item.startsAt || item.time ? String(item.startsAt || item.time) : undefined,
    market: market || "Mercado nao identificado",
    selection: selection || "Selecao nao identificada",
    odd: Number.isFinite(odd) && odd > 1 ? odd : null,
    rawText: item.rawText ? String(item.rawText) : undefined,
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : undefined,
    screenshotIndex,
    bookmaker: item.bookmaker || item.sportsbook || item.book ? String(item.bookmaker || item.sportsbook || item.book) : "Betano",
  };
}

function isGenericGameText(value: string) {
  const normalized = normalizeText(value);
  return !normalized || normalized === "jogo" || normalized === "partida" || normalized === "evento" || normalized === "match" || normalized === "fixture";
}

function parseOdd(value: any) {
  const odd = Number.parseFloat(String(value || "").replace(",", "."));
  return Number.isFinite(odd) && odd > 1 ? odd : null;
}

function normalizeEventSelections(item: any, screenshotIndex: number): ExtractedSelection[] {
  const game = String(item.game || item.match || item.event || "").trim();
  const homeTeam = item.homeTeam ? String(item.homeTeam).trim() : "";
  const awayTeam = item.awayTeam ? String(item.awayTeam).trim() : "";
  const normalizedGame = homeTeam && awayTeam && (!game || isGenericGameText(game))
    ? `${homeTeam} x ${awayTeam}`
    : game || (homeTeam && awayTeam ? `${homeTeam} x ${awayTeam}` : "");
  if (!normalizedGame) return [];

  const base = {
    game: normalizedGame,
    homeTeam: homeTeam || undefined,
    awayTeam: awayTeam || undefined,
    competition: item.competition ? String(item.competition) : undefined,
    startsAt: item.startsAt || item.time ? String(item.startsAt || item.time) : undefined,
    rawText: item.rawText ? String(item.rawText) : undefined,
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : undefined,
    screenshotIndex,
    bookmaker: item.bookmaker || item.sportsbook || item.book ? String(item.bookmaker || item.sportsbook || item.book) : "Betano",
  };
  const selections: ExtractedSelection[] = [];
  const odds = item.odds || {};

  const homeOdd = parseOdd(odds.home ?? odds["1"] ?? item.homeOdd ?? item.oddHome);
  const drawOdd = parseOdd(odds.draw ?? odds.x ?? odds.X ?? item.drawOdd ?? item.oddDraw);
  const awayOdd = parseOdd(odds.away ?? odds["2"] ?? item.awayOdd ?? item.oddAway);

  if (homeOdd) {
    selections.push({ ...base, market: "Resultado final", selection: homeTeam || "Casa", odd: homeOdd });
  }
  if (drawOdd) {
    selections.push({ ...base, market: "Resultado final", selection: "Empate", odd: drawOdd });
  }
  if (awayOdd) {
    selections.push({ ...base, market: "Resultado final", selection: awayTeam || "Fora", odd: awayOdd });
  }

  const markets = Array.isArray(item.markets) ? item.markets : [];
  for (const market of markets) {
    const marketName = String(market.market || market.name || "Mercado do print");
    const options = Array.isArray(market.options) ? market.options : Array.isArray(market.values) ? market.values : [];

    for (const option of options) {
      const odd = parseOdd(option.odd ?? option.odds ?? option.price);
      const selection = String(option.selection || option.value || option.name || "").trim();
      if (!odd || !selection) continue;
      if (marketCategory(marketName, selection) === "outros" || hasDifficultLine(`${marketName} ${selection}`)) continue;

      selections.push({
        ...base,
        market: marketName,
        selection,
        odd,
      });
    }
  }

  return selections;
}

function dedupeSelections(selections: ExtractedSelection[]) {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    const key = [
      normalizeText(selection.game),
      normalizeText(selection.market),
      normalizeText(selection.selection),
      selection.odd || "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferDateFromSelections(selections: ExtractedSelection[], fallbackDate: string) {
  for (const selection of selections) {
    const parsed = parseDateLike(selection.startsAt, fallbackDate);
    if (parsed) return parsed;
  }
  return fallbackDate;
}

function parseDateLike(value: string | undefined, fallbackDate: string) {
  if (!value) return null;
  const text = String(value).trim();
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const br = text.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (br) {
    const day = br[1].padStart(2, "0");
    const month = br[2].padStart(2, "0");
    const fallbackYear = fallbackDate.slice(0, 4);
    const rawYear = br[3] || fallbackYear;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month}-${day}`;
  }

  return null;
}

async function extractSelectionsFromImages(files: File[]) {
  const openai = new OpenAI();
  const model = getEnv("OPENAI_VISION_MODEL") || DEFAULT_VISION_MODEL;
  const imageParts = [];

  for (let index = 0; index < files.length; index += 1) {
    imageParts.push({
      type: "text",
      text: `Print ${index + 1}: faca OCR da tela inteira e extraia todos os jogos, ligas, horarios, mercados e odds visiveis.`
    });
    imageParts.push({
      type: "image_url",
      image_url: {
        url: await fileToDataUrl(files[index]),
        detail: "high",
      },
    });
  }

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Voce extrai dados de prints de casas de aposta.",
          "Leia a tela inteira com cuidado, como OCR, e organize a informacao por evento antes de responder. Devolva somente JSON valido.",
          "Nao invente jogos, odds, horarios ou mercados que nao estejam visiveis.",
          "Nao confunda horario, placar, ranking, rodada ou handicap visual com odd. Odd normalmente e numero decimal entre 1.01 e 30.",
          "Em lista de futebol, cada linha/card com dois times deve virar um item em events, mesmo que nenhuma selecao esteja marcada.",
          "Se houver data ou horario visivel no card, cupom ou tela, preencha startsAt com esse texto.",
          "Se houver data no topo da tela ou filtro do app, use essa data para os eventos visiveis.",
          "Se a tela mostrar lista de jogos com colunas 1 X 2, extraia o evento em events com odds.home, odds.draw e odds.away.",
          "Nas colunas 1 X 2: 1 pertence ao time da casa, X ao empate, 2 ao time visitante.",
          "Se aparecerem mercados como ambas marcam, total de gols, escanteios ou cartoes, extraia em markets[].options[]. Nao extraia handicap, spread, asian handicap ou linhas quebradas como 0.25/0.75.",
          "Se ja houver uma selecao marcada no bilhete, coloque tambem em selections.",
          "Mantenha os nomes dos times como aparecem no print e preencha homeTeam e awayTeam sempre que conseguir.",
          "Agrupe mercados e odds dentro do jogo correto; nao devolva uma lista solta de odds sem evento.",
          "Preserve virgula/ponto decimal corretamente: 1.72 ou 1,72 deve virar numero 1.72.",
          "Formato obrigatorio: { events: [{ game, homeTeam, awayTeam, competition, startsAt, odds: { home, draw, away }, markets: [{ market, options: [{ selection, odd }] }], rawText, confidence }], selections: [{ game, homeTeam, awayTeam, competition, startsAt, market, selection, odd, rawText, confidence }], notes: [] }.",
          "confidence deve ir de 0 a 1."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extraia todos os jogos, mercados, selecoes e odds dos prints. Se for uma tela de lista da Bet, primeiro organize por jogo/horario e depois extraia as odds visiveis para o motor decidir depois."
          },
          ...imageParts,
        ],
      },
    ],
  });

  const parsed = parseJsonObject(completion.choices[0]?.message?.content || "{}");
  const selections = Array.isArray(parsed.selections) ? parsed.selections : [];
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const directSelections = selections
    .map((item: any, index: number) => normalizeExtractedSelection(item, Number(item.screenshotIndex || 1) || Math.floor(index / 6) + 1))
    .filter(Boolean) as ExtractedSelection[];
  const eventSelections = events.flatMap((item: any, index: number) => normalizeEventSelections(item, Number(item.screenshotIndex || 1) || index + 1));

  return {
    selections: dedupeSelections([...directSelections, ...eventSelections]),
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
  };
}

function dedupeEnrichedSelections(selections: EnrichedSelection[]) {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    const key = [
      selection.fixtureId || normalizeText(selection.apiGame || selection.game),
      selection.category || marketCategory(selection.market, selection.selection),
      normalizeText(selection.market),
      normalizeText(selection.selection),
      selection.odd || "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enrichSelections(selections: ExtractedSelection[], date: string, requestedMarkets: MarketCategory[] = []) {
  let searchedDates = [date];
  let usedTeamSearchFallback = false;
  let fixtures: ApiFootballFixture[] = await apiFootball("/fixtures", {
    date,
    timezone: DEFAULT_TIMEZONE,
  });

  const selectionMatchText = (selection: ExtractedSelection) => {
    if (selection.homeTeam && selection.awayTeam) return `${selection.homeTeam} x ${selection.awayTeam}`;
    return selection.game;
  };

  let preliminary = selections.map((selection): EnrichedSelection => {
    const fixture = matchFixture(selectionMatchText(selection), fixtures);
    return {
      ...selection,
      fixtureId: fixture?.fixture.id,
      apiGame: fixture ? fixtureName(fixture) : undefined,
      apiLeague: fixture?.league.name,
      apiStartsAt: fixture?.fixture.date,
      impliedProbability: selection.odd ? Number((100 / selection.odd).toFixed(2)) : null,
    };
  });

  if (preliminary.some((selection) => !selection.fixtureId)) {
    const nearbyDates = [-1, 1, -2, 2].map((offset) => dateWithOffset(date, offset));
    const nearbyGroups = await Promise.all(
      nearbyDates.map(async (nearbyDate) => {
        try {
          return await apiFootball("/fixtures", {
            date: nearbyDate,
            timezone: DEFAULT_TIMEZONE,
          });
        } catch {
          return [];
        }
      })
    );

    searchedDates = [...searchedDates, ...nearbyDates];
    fixtures = uniqueFixtures([...fixtures, ...nearbyGroups.flat()]);
    preliminary = selections.map((selection): EnrichedSelection => {
      const fixture = matchFixture(selectionMatchText(selection), fixtures);
      return {
        ...selection,
        fixtureId: fixture?.fixture.id,
        apiGame: fixture ? fixtureName(fixture) : undefined,
        apiLeague: fixture?.league.name,
        apiStartsAt: fixture?.fixture.date,
        impliedProbability: selection.odd ? Number((100 / selection.odd).toFixed(2)) : null,
      };
    });
  }

  if (preliminary.some((selection) => !selection.fixtureId)) {
    const unmatchedSearches = uniqueItems(preliminary
      .filter((selection) => !selection.fixtureId)
      .map((selection) => selectionMatchText(selection))
      .filter(Boolean))
      .slice(0, 5);
    const teamSearchGroups = await Promise.all(unmatchedSearches.map((game) => searchFixturesByTeams(game)));
    const teamSearchFixtures = uniqueFixtures(teamSearchGroups.flat());

    if (teamSearchFixtures.length) {
      usedTeamSearchFallback = true;
      fixtures = uniqueFixtures([...fixtures, ...teamSearchFixtures]);
      preliminary = selections.map((selection): EnrichedSelection => {
        const fixture = matchFixture(selectionMatchText(selection), fixtures);
        return {
          ...selection,
          fixtureId: fixture?.fixture.id,
          apiGame: fixture ? fixtureName(fixture) : undefined,
          apiLeague: fixture?.league.name,
          apiStartsAt: fixture?.fixture.date,
          impliedProbability: selection.odd ? Number((100 / selection.odd).toFixed(2)) : null,
        };
      });
    }
  }

  const matchedFixtures = new Map<number, ApiFootballFixture>();
  for (const selection of preliminary) {
    if (!selection.fixtureId) continue;
    const fixture = fixtures.find((item) => item.fixture.id === selection.fixtureId);
    if (fixture) matchedFixtures.set(selection.fixtureId, fixture);
  }

  const contextEntries = await Promise.all(
    Array.from(matchedFixtures.values()).slice(0, 8).map(async (fixture) => {
      const context = await fetchFixtureContext(fixture, requestedMarkets);
      return [fixture.fixture.id, context] as const;
    })
  );
  const contextByFixture = new Map(contextEntries);
  const apiSelections = contextEntries.flatMap(([, context]) => {
    const picks = Array.isArray((context as any).apiMarketPicks) ? (context as any).apiMarketPicks : [];
    return picks.map((selection: EnrichedSelection) => ({
      ...selection,
      apiContext: context,
    }));
  });

  return {
    selections: preliminary.map((selection) => ({
      ...selection,
      source: "print" as const,
      apiContext: selection.fixtureId ? contextByFixture.get(selection.fixtureId) : undefined,
    })),
    apiSelections,
    searchedDates,
    usedTeamSearchFallback,
  };
}

async function fetchFixtureContext(fixture: ApiFootballFixture, requestedMarkets: MarketCategory[] = []) {
  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;
  const season = new Date(fixture.fixture.date).getFullYear();
  const fixtureId = fixture.fixture.id;

  const safe = async (path: string, params: Record<string, string | number | undefined>) => {
    try {
      return await apiFootball(path, params);
    } catch {
      return [];
    }
  };

  const [homeRecent, awayRecent, h2h, injuries, lineups, fixtureOdds] = await Promise.all([
    safe("/fixtures", { team: homeId, last: 6, timezone: DEFAULT_TIMEZONE }),
    safe("/fixtures", { team: awayId, last: 6, timezone: DEFAULT_TIMEZONE }),
    safe("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 6, timezone: DEFAULT_TIMEZONE }),
    safe("/injuries", { fixture: fixtureId }),
    safe("/fixtures/lineups", { fixture: fixtureId }),
    safe("/odds", { fixture: fixtureId, timezone: DEFAULT_TIMEZONE }),
  ]);

  return {
    fixture: {
      id: fixtureId,
      game: fixtureName(fixture),
      league: fixture.league.name,
      country: fixture.league.country,
      startsAt: fixture.fixture.date,
      venue: fixture.fixture.venue,
      status: fixture.fixture.status,
      season,
    },
    recentForm: {
      homeTeam: fixture.teams.home.name,
      awayTeam: fixture.teams.away.name,
      homeLastFixtures: summarizeFixtures(homeRecent),
      awayLastFixtures: summarizeFixtures(awayRecent),
    },
    h2h: summarizeFixtures(h2h),
    injuries: summarizeInjuries(injuries),
    lineups: summarizeLineups(lineups),
    apiOddsSample: summarizeOdds(fixtureOdds),
    apiMarketPicks: requestedMarkets.length ? collectApiOddsSelections(fixture, fixtureOdds, requestedMarkets) : [],
  };
}

function summarizeFixtures(items: any[]) {
  return (items || []).slice(0, 6).map((item) => ({
    date: item.fixture?.date,
    league: item.league?.name,
    home: item.teams?.home?.name,
    away: item.teams?.away?.name,
    goals: item.goals,
    status: item.fixture?.status?.short,
  }));
}

function summarizeInjuries(items: any[]) {
  return (items || []).slice(0, 12).map((item) => ({
    player: item.player?.name,
    team: item.team?.name,
    type: item.player?.type,
    reason: item.player?.reason,
  }));
}

function summarizeLineups(items: any[]) {
  return (items || []).slice(0, 2).map((item) => ({
    team: item.team?.name,
    formation: item.formation,
    startXI: (item.startXI || []).slice(0, 11).map((entry: any) => entry.player?.name),
  }));
}

function summarizeOdds(items: any[]) {
  const bookmakers = items?.[0]?.bookmakers || [];
  return bookmakers.filter((bookmaker: any) => isBetanoBookmaker(bookmaker.name)).slice(0, 2).flatMap((bookmaker: any) => {
    return (bookmaker.bets || []).slice(0, 4).map((bet: any) => ({
      bookmaker: bookmaker.name,
      market: bet.name,
      values: (bet.values || []).slice(0, 6),
    }));
  });
}

function selectionFixtureKey(selection: any) {
  const fixtureId = Number(selection?.fixtureId || selection?.fixture_id || 0);
  if (fixtureId) return `fixture:${fixtureId}`;
  const game = normalizeText(selectionGameName(selection));
  return game && !isGenericGameName(game) ? `game:${game}` : "";
}

function dedupeTicketSelections<T extends { odd?: number }>(selections: T[], targetOdd?: number) {
  const byFixture = new Map<string, { selection: T; score: number; index: number }>();

  selections.forEach((selection, index) => {
    const key = selectionFixtureKey(selection) || `pick:${normalizeText(`${(selection as any).fixtureId || ""}|${(selection as any).market || ""}|${(selection as any).selection || (selection as any).pick || (selection as any).value || ""}`)}`;
    const odd = Number(selection.odd);
    const score = Number.isFinite(odd) && targetOdd
      ? -Math.abs(odd - targetOdd)
      : Number.isFinite(odd) ? odd : -1000;
    const current = byFixture.get(key);
    if (!current || score > current.score) {
      byFixture.set(key, { selection, score, index });
    }
  });

  return [...byFixture.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.selection);
}

function buildTicket(selections: EnrichedSelection[], kind: "conservative" | "balanced" | "bold", maxSelections: number, stake: number) {
  const sorted = selections
    .filter((selection) => selection.odd && selection.odd > 1)
    .slice()
    .sort((a, b) => {
  const targets = { conservative: 1.45, balanced: 1.7, bold: 2.05 };
  return Math.abs((a.odd || 1) - targets[kind]) - Math.abs((b.odd || 1) - targets[kind]);
    });
  const limits = { conservative: Math.min(3, maxSelections), balanced: Math.min(4, maxSelections), bold: maxSelections };
  const targets = { conservative: 1.45, balanced: 1.7, bold: 2.05 };
  const chosen = dedupeTicketSelections(sorted, targets[kind]).slice(0, limits[kind]);
  if (!chosen.length) {
    return { selections: [] };
  }
  const totalOdd = chosen.reduce((total, selection) => total * (selection.odd || 1), 1);

  return {
    selections: chosen,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * stake).toFixed(2)),
  };
}

function fallbackAnalysis(selections: EnrichedSelection[], stake: number, maxSelections: number, requestedMarkets: MarketCategory[] = []) {
  return {
    summary: selections.length
      ? `Foram extraidas ${selections.length} selecoes dos prints${requestedMarkets.length ? " dentro dos mercados marcados" : ""}. A analise usa o print como Betano e so aceita cruzamento de odds Betano na API.`
      : "O print foi lido, mas nenhuma selecao ficou dentro dos mercados marcados. Marque outros mercados ou envie um print com esses mercados visiveis.",
    gameByGame: selections.map((selection) => ({
      game: selection.apiGame || selection.game,
      market: selection.market,
      selection: selection.selection,
      odd: selection.odd,
      impliedProbability: selection.impliedProbability,
      reason: selection.fixtureId ? "Jogo encontrado na API-Football. Confirmar mercado na casa de aposta antes de montar." : "Jogo nao foi casado com a API-Football; usar como leitura do print.",
      risk: selection.odd && selection.odd >= 2.2 ? "alto" : "medio",
      picks: [selection],
    })),
    traps: selections
      .filter((selection) => !selection.odd || selection.odd < 1.2 || selection.odd > 2.8 || (selection.confidence !== undefined && selection.confidence < 0.65))
      .map((selection) => ({
        game: selection.game,
        reason: !selection.odd ? "Odd nao foi lida com seguranca." : selection.odd < 1.2 ? "Odd muito baixa para retorno pequeno." : selection.odd > 2.8 ? "Odd alta, variancia alta." : "Baixa confianca na leitura do print.",
      })),
    conservativeTicket: buildTicket(selections, "conservative", maxSelections, stake),
    balancedTicket: buildTicket(selections, "balanced", maxSelections, stake),
    boldTicket: buildTicket(selections, "bold", maxSelections, stake),
    mainRecommendation: selections.length ? buildTicket(selections, "balanced", maxSelections, stake) : { selections: [] },
  };
}

async function aiAnalysis(payload: unknown, stake: number, maxSelections: number) {
  const openai = new OpenAI();
  const model = getEnv("OPENAI_MODEL") || DEFAULT_MODEL;
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Voce e um analista de apostas esportivas que recebe odds extraidas de prints e dados de API.",
          "Use somente o JSON recebido. Nao invente estatisticas, lesoes ou escalacoes ausentes.",
          "A odd extraida do print e a fonte principal para montar o bilhete; a API e contexto recente auxiliar.",
          "Se apiContext existir, use recentForm, h2h, injuries, lineups e apiOddsSample para justificar.",
          "Se apiContext nao existir, ainda analise usando game, market, selection, odd e impliedProbability do print; marque confianca menor, mas nao descarte automaticamente.",
          "Escreva no mesmo estilo: analise jogo a jogo, probabilidade implicita, valor ou armadilha, e bilhete pronto.",
          "Priorize mercados exatamente como aparecem no print. Se a tela for 1X2, escolha entre Casa/Empate/Fora apenas quando houver valor; nao use todos os favoritos cegamente.",
          "Se requestedMarkets vier preenchido, use somente selecoes dessas categorias.",
          "Nao use handicap, spread, asian handicap, linhas 0.25/0.75 ou mercados que nao parecam disponiveis na Betano.",
          "Devolva JSON valido com: summary, gameByGame, traps, conservativeTicket, balancedTicket, boldTicket, mainRecommendation.",
          "Cada ticket deve ter selections, totalOdd e possibleReturn.",
          "Cada selecao deve preservar apiGame/game, market, selection, odd, fixtureId e impliedProbability das selecoes recebidas.",
          "Nunca use nomes genericos como Jogo, Match ou Fixture; use sempre o nome real dos times ou apiGame.",
          "Nunca use requestedMarkets como texto de market; market deve vir da selecao original extraida do print.",
          "Nunca coloque duas selecoes do mesmo jogo no mesmo bilhete. Em escanteios, cartoes, gols ou chutes, escolha uma linha por jogo.",
          `Stake=${stake}; maxSelections=${maxSelections}.`
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ],
  });

  return parseJsonObject(completion.choices[0]?.message?.content || "{}");
}

function isSelectionLike(value: any) {
  return value && typeof value === "object" && (
    value.game ||
    value.fixture ||
    value.match ||
    value.market ||
    value.selection ||
    value.pick ||
    value.value ||
    value.odd
  );
}

function ticketSelections(ticket: any) {
  if (!ticket) return [];
  if (Array.isArray(ticket)) return ticket.filter(isSelectionLike);
  if (Array.isArray(ticket.selections)) return ticket.selections.filter(isSelectionLike);
  if (Array.isArray(ticket.picks)) return ticket.picks.filter(isSelectionLike);
  return isSelectionLike(ticket) ? [ticket] : [];
}

function selectionGameName(selection: any) {
  if (!selection || typeof selection !== "object") return "";
  if (selection.apiGame) return selection.apiGame;
  if (selection.game) return selection.game;
  if (selection.fixture) return selection.fixture;
  if (selection.match) return selection.match;
  if (selection.event) return selection.event;
  if (selection.matchName) return selection.matchName;
  if (selection.homeTeam && selection.awayTeam) return `${selection.homeTeam} x ${selection.awayTeam}`;
  if (selection.home && selection.away) return `${selection.home} x ${selection.away}`;
  return "";
}

function isGenericGameName(value: unknown) {
  const normalized = normalizeText(String(value || ""));
  return !normalized || normalized === "jogo" || normalized === "jogo nao informado" || normalized === "jogo nao identificado" || normalized === "match" || normalized === "fixture";
}

function isInternalMarketName(value: unknown) {
  const normalized = normalizeText(String(value || "")).replace(/\s+/g, "_");
  return [
    "resultado_final",
    "dupla_chance",
    "mais_menos_gols",
    "ambas_marcam",
    "escanteios",
    "cartoes",
    "chutes_gol",
    "time_marca",
    "outros",
  ].includes(normalized);
}

function findMatchingSelection(selection: any, fallbackSelections: any[]) {
  if (!selection || !fallbackSelections.length) return null;
  const fixtureId = Number(selection.fixtureId || selection.fixture_id || 0);
  const odd = Number(selection.odd);
  const category = marketCategory(String(selection.market || selection.category || ""), String(selection.selection || selection.pick || selection.value || ""));
  const selectionText = normalizeText(String(selection.selection || selection.pick || selection.value || ""));
  const gameText = normalizeText(String(selectionGameName(selection)));

  let best: { selection: any; score: number } | null = null;
  for (const fallback of fallbackSelections) {
    let score = 0;
    if (fixtureId && Number(fallback.fixtureId) === fixtureId) score += 10;
    if (Number.isFinite(odd) && Math.abs(Number(fallback.odd) - odd) <= 0.03) score += 6;
    const fallbackCategory = marketCategory(String(fallback.market || ""), String(fallback.selection || ""));
    if (category !== "outros" && fallbackCategory === category) score += 5;
    const fallbackSelectionText = normalizeText(String(fallback.selection || fallback.pick || fallback.value || ""));
    if (selectionText && (fallbackSelectionText.includes(selectionText) || selectionText.includes(fallbackSelectionText))) score += 4;
    const fallbackGame = normalizeText(String(selectionGameName(fallback)));
    if (gameText && !isGenericGameName(gameText) && (fallbackGame.includes(gameText) || gameText.includes(fallbackGame))) score += 8;
    if (!best || score > best.score) best = { selection: fallback, score };
  }

  return best && best.score >= 6 ? best.selection : null;
}

function repairSelection(selection: any, fallbackSelections: any[]) {
  const match = findMatchingSelection(selection, fallbackSelections);
  if (!match) return selection;

  const currentGame = selectionGameName(selection);
  const currentMarket = selection.market || selection.category || "";
  return {
    ...match,
    ...selection,
    fixtureId: Number(selection.fixtureId || match.fixtureId || 0) || match.fixtureId,
    apiGame: selection.apiGame || match.apiGame,
    game: isGenericGameName(currentGame) ? selectionGameName(match) : currentGame,
    market: isInternalMarketName(currentMarket) ? match.market : (selection.market || match.market),
    category: selection.category || match.category,
    selection: selection.selection || selection.pick || selection.value || match.selection,
    odd: Number(selection.odd || match.odd),
    impliedProbability: selection.impliedProbability || match.impliedProbability,
  };
}

function normalizeTicketShape(ticket: any, stake: number, fallbackSelections: any[] = []) {
  if (!ticket) return ticket;
  const repairedSelections = ticketSelections(ticket).map((selection) => repairSelection(selection, fallbackSelections));
  const selections = dedupeTicketSelections(repairedSelections);
  if (fallbackSelections.length && selections.some((selection: any) => isGenericGameName(selectionGameName(selection)))) {
    return {
      ...(Array.isArray(ticket) ? {} : ticket),
      selections: [],
    };
  }
  const computedOdd = selections.reduce((total: number, selection: any) => {
    const odd = Number(selection.odd);
    return Number.isFinite(odd) && odd > 1 ? total * odd : total;
  }, 1);
  const totalOdd = selections.length ? computedOdd : undefined;
  const possibleReturn = totalOdd ? Number((totalOdd * stake).toFixed(2)) : undefined;

  return {
    ...(Array.isArray(ticket) ? {} : ticket),
    selections,
    ...(totalOdd ? { totalOdd: Number(totalOdd.toFixed(2)) } : {}),
    ...(possibleReturn ? { possibleReturn } : {}),
  };
}

function fallbackTicketFromSelections(selections: any[], targetOdd: number, maxSelections: number, stake: number) {
  const ranked = selections
    .filter((selection) => Number(selection.odd) > 1)
    .slice()
    .sort((a, b) => Math.abs(Number(a.odd) - targetOdd) - Math.abs(Number(b.odd) - targetOdd))
  const chosen = dedupeTicketSelections(ranked, targetOdd).slice(0, maxSelections);
  return normalizeTicketShape(chosen, stake, chosen);
}

function normalizeAnalysisShape(analysis: any, stake: number, fallbackSelections: any[] = [], maxSelections = 4) {
  if (!analysis || typeof analysis !== "object") return analysis;
  const normalized = { ...analysis };

  for (const key of ["conservativeTicket", "balancedTicket", "boldTicket", "recommendedTicket"]) {
    if (normalized[key]) normalized[key] = normalizeTicketShape(normalized[key], stake, fallbackSelections);
  }

  const ticketDefaults = [
    ["conservativeTicket", 1.45, Math.min(3, maxSelections)],
    ["balancedTicket", 1.65, Math.min(4, maxSelections)],
    ["boldTicket", 1.9, maxSelections],
  ] as const;

  for (const [key, targetOdd, limit] of ticketDefaults) {
    if (!normalized[key]?.selections?.length && fallbackSelections.length) {
      normalized[key] = fallbackTicketFromSelections(fallbackSelections, targetOdd, limit, stake);
    }
  }

  if (normalized.mainRecommendation && typeof normalized.mainRecommendation === "object") {
    normalized.mainRecommendation = normalizeTicketShape(normalized.mainRecommendation, stake, fallbackSelections);
  }
  if (!normalized.mainRecommendation?.selections?.length && normalized.balancedTicket?.selections?.length) {
    normalized.mainRecommendation = normalized.balancedTicket;
  }

  return normalized;
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Use POST" }, { status: 405 });
  }

  if (!getEnv("OPENAI_BASE_URL") && !getEnv("OPENAI_API_KEY")) {
    return json({
      error: "IA de visao nao configurada",
      setup: [
        "Habilite o Netlify AI Gateway ou configure OPENAI_API_KEY.",
        "A leitura de print precisa de um modelo com visao.",
      ],
    }, { status: 501 });
  }

  const form = await req.formData();
  const files = form
    .getAll("screenshots")
    .filter((item): item is File => item instanceof File && item.size > 0);
  const fallbackDate = String(form.get("date") || new Date().toISOString().slice(0, 10));
  const stake = Number(form.get("stake") || 5);
  const riskProfile = String(form.get("riskProfile") || "moderado");
  const maxSelections = Math.max(1, Math.min(8, Number(form.get("maxSelections") || 4)));
  const requestedMarkets = requestedMarketCategories(form.getAll("markets").map(String).join(","));

  if (!files.length) {
    return json({ error: "Envie pelo menos um print" }, { status: 400 });
  }

  if (files.length > 5) {
    return json({ error: "Envie no maximo 5 prints por analise" }, { status: 400 });
  }

  let extracted;
  try {
    extracted = await extractSelectionsFromImages(files);
  } catch (error) {
    return json({
      error: "Nao consegui ler o print enviado",
      setup: [
        "Use PNG ou JPG legivel.",
        "Evite imagem cortada demais, muito escura ou sem odds visiveis.",
        "Se o print vier do iPhone, tente enviar o screenshot original da galeria."
      ],
    }, { status: 422 });
  }

  const date = inferDateFromSelections(extracted.selections, fallbackDate);
  let enrichedResult;
  try {
    enrichedResult = await enrichSelections(extracted.selections, date, requestedMarkets);
  } catch (error: any) {
    return json({
      error: "API-Football falhou ao cruzar os jogos do print",
      detail: error?.message || "Erro desconhecido na API-Football.",
      setup: [
        "A leitura do print funcionou, mas a busca esportiva falhou.",
        "Confira quota/permissao da API_FOOTBALL_KEY no provedor.",
        "Tente novamente em alguns minutos se a API estiver limitando requisicoes."
      ],
    }, { status: 502 });
  }
  const allEnriched = enrichedResult.selections;
  const printSelectionsForMarkets = applyMarketFilter(allEnriched, requestedMarkets);
  const apiSelectionsForMarkets = Array.isArray(enrichedResult.apiSelections) ? enrichedResult.apiSelections : [];
  const enriched = requestedMarkets.length
    ? dedupeEnrichedSelections([...apiSelectionsForMarkets, ...printSelectionsForMarkets])
    : allEnriched;
  const payload = {
    generatedAt: new Date().toISOString(),
    date,
    riskProfile,
    stake,
    maxSelections,
    requestedMarkets,
    extractedNotes: extracted.notes,
    selections: enriched,
    providerNotes: {
      screenshots: "Odds extraidas diretamente dos prints enviados.",
      apiFootball: getEnv("API_FOOTBALL_KEY") ? "Tentativa de cruzamento por fixture do dia." : "API_FOOTBALL_KEY ausente; sem cruzamento esportivo.",
    },
  };

  let analysis;
  try {
    analysis = await aiAnalysis(payload, stake, maxSelections);
  } catch {
    analysis = fallbackAnalysis(enriched, stake, maxSelections, requestedMarkets);
  }
  analysis = normalizeAnalysisShape(analysis, stake, enriched, maxSelections);

  return json({
    source: {
      provider: "Print Betano + OpenAI Vision + API-Football Betano",
      date,
      searchedDates: enrichedResult.searchedDates,
      usedTeamSearchFallback: enrichedResult.usedTeamSearchFallback,
      timezone: DEFAULT_TIMEZONE,
      screenshotCount: files.length,
      matched: allEnriched.filter((selection) => selection.fixtureId).length,
      matchedAfterFilter: enriched.filter((selection) => selection.fixtureId).length,
      unmatchedGames: enriched.filter((selection) => !selection.fixtureId).map((selection) => selection.game),
      picksFound: allEnriched.length,
      apiMarketPicks: apiSelectionsForMarkets.length,
      picksUsed: enriched.length,
      requestedMarkets,
      marketFilterApplied: requestedMarkets.length > 0,
      filteredOut: Math.max(allEnriched.length - printSelectionsForMarkets.length, 0),
    },
    extracted: enriched,
    analysis,
  });
};

export const config = {
  path: "/api/analyze-screenshot",
  method: ["POST"],
};
