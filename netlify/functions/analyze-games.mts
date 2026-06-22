import OpenAI from "openai";
import { externalServiceError, fetchWithTimeout, friendlyErrorPayload, missingConfig } from "./_shared/http.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_MODEL = "gpt-4o-mini";

type SearchRequest = {
  query?: string;
  date?: string;
  riskProfile?: string;
  stake?: number;
  maxSelections?: number;
  markets?: string[] | string;
};

type ApiFootballFixture = {
  fixture: {
    id: number;
    date: string;
    timezone?: string;
    venue?: { name?: string; city?: string };
    status?: { long?: string; short?: string; elapsed?: number | null };
  };
  league: {
    id: number;
    name: string;
    country?: string;
    season?: number;
  };
  teams: {
    home: { id: number; name: string; winner?: boolean | null };
    away: { id: number; name: string; winner?: boolean | null };
  };
  goals?: {
    home?: number | null;
    away?: number | null;
  };
};

type NormalizedPick = {
  fixtureId: number;
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category?: MarketCategory;
  selection: string;
  odd: number;
  bookmaker?: string;
  impliedProbability: number;
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
  if (normalized.includes("betano")) return 18;
  if (normalized.includes("superbet")) return 17;
  if (normalized.includes("pinnacle")) return 16;
  if (normalized.includes("bet365")) return 15;
  if (normalized.includes("betfair")) return 14;
  if (normalized.includes("1xbet")) return 12;
  if (normalized.includes("william hill")) return 10;
  return 0;
}

function hasDifficultLine(value: string) {
  return /(^|[^\d])\d+[,.](25|75)([^\d]|$)/.test(String(value || ""));
}

function splitRequestedGames(query: string) {
  return query
    .split(/\n|,|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const TEAM_NAME_ALIASES: Record<string, string> = {
  "africa do sul": "South Africa",
  alemanha: "Germany",
  algeria: "Algeria",
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
  "cape verde": "Cape Verde",
  canada: "Canada",
  "costa do marfim": "Ivory Coast",
  "cote d ivoire": "Ivory Coast",
  "ivory coast": "Ivory Coast",
  colombia: "Colombia",
  "congo dr": "Congo DR",
  "dr congo": "Congo DR",
  "rd congo": "Congo DR",
  "coreia do sul": "Korea Republic",
  "coreia republica": "Korea Republic",
  "korea republic": "Korea Republic",
  "south korea": "Korea Republic",
  croacia: "Croatia",
  curacao: "Curacao",
  dinamarca: "Denmark",
  egito: "Egypt",
  escocia: "Scotland",
  espanha: "Spain",
  "estados unidos": "USA",
  eua: "USA",
  franca: "France",
  georgia: "Georgia",
  gana: "Ghana",
  ghana: "Ghana",
  haiti: "Haiti",
  holanda: "Netherlands",
  hungria: "Hungary",
  inglaterra: "England",
  irlanda: "Rep. Of Ireland",
  ira: "IR Iran",
  "ir iran": "IR Iran",
  iraque: "Iraq",
  japao: "Japan",
  jordania: "Jordan",
  mexico: "Mexico",
  montenegro: "Montenegro",
  marrocos: "Morocco",
  noruega: "Norway",
  "nova zelandia": "New Zealand",
  panama: "Panama",
  paraguai: "Paraguay",
  polonia: "Poland",
  qatar: "Qatar",
  czechia: "Czechia",
  "czech republic": "Czechia",
  "republica tcheca": "Czechia",
  servia: "Serbia",
  senegal: "Senegal",
  suecia: "Sweden",
  suica: "Switzerland",
  tchequia: "Czechia",
  tunisia: "Tunisia",
  turquia: "Turkey",
  turkey: "Turkey",
  turkiye: "Turkey",
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

function fixtureName(fixture: ApiFootballFixture) {
  return `${fixture.teams.home.name} x ${fixture.teams.away.name}`;
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
    let best: { fixture: ApiFootballFixture; score: number; bothSidesMatched: boolean } | null = null;

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
      const bothSidesMatched = bothDirect || bothReverse;

      if ((!best || score > best.score) && bothSidesMatched) {
        best = { fixture, score, bothSidesMatched };
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
  if (!key) {
    throw missingConfig("API_FOOTBALL_KEY", "API-Football");
  }

  const url = new URL(path, API_FOOTBALL_BASE);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(name, String(value));
    }
  });

  const response = await fetchWithTimeout(url, {
    headers: {
      "x-apisports-key": key,
    },
  }, 8000, "API-Football");

  if (!response.ok) {
    throw externalServiceError("API-Football", `HTTP ${response.status} em ${path}`, response.status === 429 ? 429 : 502);
  }

  const data = await response.json();
  const apiErrors = data.errors && typeof data.errors === "object"
    ? Object.values(data.errors).flat().filter(Boolean)
    : [];
  if (apiErrors.length) {
    const detail = apiErrors.join(" | ");
    throw externalServiceError("API-Football", detail, /quota|rate|limit|too many/i.test(detail) ? 429 : 502);
  }
  return data.response || [];
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

function uniqueItems<T>(items: T[]) {
  return [...new Set(items)];
}

const CATEGORY_BASE_SCORE: Record<MarketCategory, number> = {
  mais_menos_gols: 43,
  dupla_chance: 39,
  cartoes: 36,
  escanteios: 35,
  ambas_marcam: 31,
  chutes_gol: 27,
  handicap: 18,
  time_marca: 17,
  resultado_final: 8,
  outros: -100,
};

const CATEGORY_TARGET_ODD: Record<MarketCategory, number> = {
  dupla_chance: 1.35,
  mais_menos_gols: 1.6,
  ambas_marcam: 1.72,
  handicap: 1.72,
  escanteios: 1.68,
  cartoes: 1.72,
  chutes_gol: 1.75,
  time_marca: 1.7,
  resultado_final: 1.62,
  outros: 1.65,
};

function marketCategory(market: string, selection = ""): MarketCategory {
  const normalized = normalizeText(`${market} ${selection}`);

  if (normalized.includes("double chance") || normalized.includes("dupla chance")) return "dupla_chance";
  if (
    normalized.includes("both teams score") ||
    normalized.includes("both teams to score") ||
    normalized.includes("btts") ||
    normalized.includes("ambas marcam")
  ) return "ambas_marcam";
  if (normalized.includes("corner") || normalized.includes("escanteio") || normalized.includes("canto")) return "escanteios";
  if (normalized.includes("yellow") || normalized.includes("booking")) return "cartoes";
  if (normalized.includes("card") || normalized.includes("cartao") || normalized.includes("cartoes")) return "cartoes";
  if (normalized.includes("foul") || normalized.includes("offside")) return "outros";
  if (normalized.includes("shot") || normalized.includes("chute") || normalized.includes("finalizacao")) return "chutes_gol";
  if (normalized.includes("handicap") || normalized.includes("asian") || normalized.includes("spread")) return "outros";
  if (
    normalized.includes("team to score") ||
    normalized.includes("home team score") ||
    normalized.includes("away team score") ||
    normalized.includes("clean sheet")
  ) return "time_marca";
  if (
    normalized.includes("goals") ||
    normalized.includes("gol") ||
    normalized.includes("gols") ||
    normalized.includes("goal line") ||
    normalized.includes("over under") ||
    normalized.includes("over") ||
    normalized.includes("under") ||
    normalized.includes("mais") ||
    normalized.includes("menos") ||
    normalized.includes("total")
  ) return "mais_menos_gols";
  if (
    normalized.includes("match winner") ||
    normalized.includes("winner") ||
    normalized.includes("resultado final") ||
    normalized.includes("vitoria") ||
    normalized.includes("vence") ||
    normalized.includes("1x2") ||
    normalized.includes("match result") ||
    normalized.includes("fulltime result") ||
    normalized === "home away home" ||
    normalized === "home away away"
  ) return "resultado_final";

  return "outros";
}

function userMarketCategory(market: string): MarketCategory {
  const normalized = normalizeText(market);
  if (!normalized) return "outros";
  if (normalized.includes("dupla")) return "dupla_chance";
  if (normalized.includes("ambas") || normalized.includes("btts")) return "ambas_marcam";
  if (normalized.includes("escanteio") || normalized.includes("canto")) return "escanteios";
  if (normalized.includes("cart")) return "cartoes";
  if (normalized.includes("chute") || normalized.includes("finalizacao")) return "chutes_gol";
  if (normalized.includes("handicap") || normalized.includes("asian") || normalized.includes("spread")) return "outros";
  if (normalized.includes("mais") || normalized.includes("menos") || normalized.includes("gol")) return "mais_menos_gols";
  if (normalized.includes("resultado") || normalized.includes("vitoria") || normalized.includes("vence")) return "resultado_final";
  return marketCategory(market);
}

function requestedMarketCategories(markets: unknown) {
  const values = Array.isArray(markets)
    ? markets
    : typeof markets === "string"
      ? markets.split(",")
      : [];
  const categories = values
    .map((market) => userMarketCategory(String(market)))
    .filter((category): category is MarketCategory => category !== "outros");
  return [...new Set(categories)];
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
    "odd even",
    "odd/even",
    "first half",
    "second half",
    "1st half",
    "2nd half",
    "first period",
    "second period",
    "result/both teams",
    "corner winner",
    "corners winner",
    "card winner",
  ].some((fragment) => normalized.includes(fragment));
}

function pickKey(pick: Pick<NormalizedPick, "fixtureId" | "market" | "selection">) {
  return normalizeText(`${pick.fixtureId}|${pick.market}|${pick.selection}`);
}

function collectOddsValues(bookmakers: any[]) {
  const byKey = new Map<string, {
    selection: string;
    odd: number;
    bookmaker?: string;
    market: string;
    category: MarketCategory;
  }>();

  for (const bookmaker of bookmakers || []) {
    for (const bet of bookmaker.bets || []) {
      const market = String(bet.name || "");
      if (!market || isUnsupportedMarket(market)) continue;

      for (const value of bet.values || []) {
        const selection = String(value.value || "");
        if (hasDifficultLine(`${market} ${selection}`)) continue;

        const odd = Number.parseFloat(String(value.odd || "0"));
        const category = marketCategory(market, selection);

        if (category === "outros") continue;
        if (!Number.isFinite(odd) || odd < 1.12 || odd > 2.35) continue;

        const key = normalizeText(`${category}|${market}|${selection}`);
        const current = byKey.get(key);
        const priority = bookmakerPriority(bookmaker.name);
        const currentPriority = bookmakerPriority(current?.bookmaker);
        if (!current || odd > current.odd + 0.04 || (Math.abs(odd - current.odd) <= 0.04 && priority > currentPriority)) {
          byKey.set(key, {
            selection,
            odd,
            bookmaker: bookmaker.name,
            market,
            category,
          });
        }
      }
    }
  }

  return [...byKey.values()];
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

  if (normalized === "home" || normalized === "1") return home;
  if (normalized === "away" || normalized === "2") return away;
  if (normalized === "draw" || normalized === "x") return "Empate";

  if (normalizedMarket.includes("handicap")) {
    return selection
      .replace(/^home/i, home)
      .replace(/^away/i, away)
      .replace(/^draw/i, "Empate");
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

function pickScore(pick: NormalizedPick, targetOdd?: number) {
  const category = pick.category || marketCategory(pick.market, pick.selection);
  const target = targetOdd || CATEGORY_TARGET_ODD[category];
  const oddDistancePenalty = Math.abs(pick.odd - target) * 7;
  const shortPricePenalty = pick.odd < 1.18 ? 10 : 0;
  const longPricePenalty = pick.odd > 2.8 ? (pick.odd - 2.8) * 3.5 : 0;
  const drawPenalty = category === "resultado_final" && normalizeText(pick.selection) === "empate" ? 6 : 0;
  const bookmakerBoost = Math.min(8, bookmakerPriority(pick.bookmaker) * 0.28);

  return CATEGORY_BASE_SCORE[category] + bookmakerBoost - oddDistancePenalty - shortPricePenalty - longPricePenalty - drawPenalty;
}

function bestPrematchPicks(fixture: ApiFootballFixture, oddsResponse: any[], requestedCategories: MarketCategory[] = []) {
  const oddsData = oddsResponse[0];
  const bookmakers = oddsData?.bookmakers || [];
  const candidates: NormalizedPick[] = [];
  const requestedSet = new Set(requestedCategories);

  for (const value of collectOddsValues(bookmakers)) {
    const odd = value.odd;
    if (odd < 1.18 || odd > 2.35) continue;
    if (requestedSet.size && !requestedSet.has(value.category)) continue;

    candidates.push({
      fixtureId: fixture.fixture.id,
      game: fixtureName(fixture),
      league: fixture.league.name,
      startsAt: fixture.fixture.date,
      market: displayMarket(value.market, fixture),
      category: value.category,
      selection: displaySelection(value.selection, fixture, value.market),
      odd,
      bookmaker: value.bookmaker,
      impliedProbability: Number((100 / odd).toFixed(2)),
    });
  }

  const ranked = candidates
    .slice()
    .sort((a, b) => pickScore(b) - pickScore(a));
  const selected: NormalizedPick[] = [];
  const usedKeys = new Set<string>();
  const defaultPreferredCategories: MarketCategory[] = [
    "mais_menos_gols",
    "ambas_marcam",
    "dupla_chance",
    "escanteios",
    "cartoes",
    "chutes_gol",
    "time_marca",
  ];
  const preferredCategories = requestedCategories.length ? requestedCategories : defaultPreferredCategories;

  const addPick = (pick?: NormalizedPick) => {
    if (!pick) return;
    const key = pickKey(pick);
    if (usedKeys.has(key)) return;
    selected.push(pick);
    usedKeys.add(key);
  };

  for (const category of preferredCategories) {
    addPick(ranked.find((pick) => pick.category === category));
  }

  if (!requestedCategories.length || requestedCategories.includes("resultado_final")) {
    addPick(ranked.find((pick) => pick.category === "resultado_final"));
  }

  for (const pick of ranked) {
    if (selected.length >= 10) break;
    const categoryCount = selected.filter((item) => item.category === pick.category).length;
    const maxPerCategory = pick.category === "resultado_final" ? 1 : 2;
    if (categoryCount >= maxPerCategory) continue;
    addPick(pick);
  }

  return selected.slice(0, 10);
}

async function fetchFixtureContext(fixture: ApiFootballFixture) {
  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;
  const fixtureId = fixture.fixture.id;
  const safe = async (path: string, params: Record<string, string | number | undefined>) => {
    try {
      return await apiFootball(path, params);
    } catch {
      return [];
    }
  };
  const [homeRecent, awayRecent, h2h, injuries, lineups] = await Promise.all([
    safe("/fixtures", { team: homeId, last: 6, timezone: DEFAULT_TIMEZONE }),
    safe("/fixtures", { team: awayId, last: 6, timezone: DEFAULT_TIMEZONE }),
    safe("/fixtures/headtohead", { h2h: `${homeId}-${awayId}`, last: 6, timezone: DEFAULT_TIMEZONE }),
    safe("/injuries", { fixture: fixtureId }),
    safe("/fixtures/lineups", { fixture: fixtureId }),
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

function deterministicAnalysis(input: {
  requestedGames: string[];
  matchedFixtures: ApiFootballFixture[];
  picks: NormalizedPick[];
  riskProfile: string;
  stake: number;
  maxSelections: number;
  requestedMarkets: MarketCategory[];
  fixtureContexts?: Record<string, unknown>;
}) {
  const recommendedTicket = fallbackTicketFromSelections(
    input.picks,
    input.riskProfile === "conservador" ? 1.45 : input.riskProfile === "ousado" ? 1.9 : 1.65,
    Math.min(input.maxSelections, input.riskProfile === "conservador" ? 3 : 4),
    input.stake
  );

  return {
    mode: "deterministic",
    summary: input.picks.length
      ? `Analise estatistica inicial com odds de casas disponiveis na API${input.requestedMarkets.length ? " respeitando os mercados marcados no painel" : ""}. Priorizei mercados simples de maior probabilidade.`
      : input.matchedFixtures.length
        ? input.requestedMarkets.length
          ? "Jogo encontrado na API, mas nenhum dos mercados marcados apareceu com odds pre-jogo validas nas casas disponiveis."
          : "Jogo encontrado na API, mas sem odds pre-jogo disponiveis para montar bilhete com dados reais."
        : "Nao encontrei cruzamento confiavel para esse jogo na API. Revise o nome dos times ou tente enviar o print com data e horario visiveis.",
    gameByGame: input.matchedFixtures.map((fixture) => ({
      fixtureId: fixture.fixture.id,
      game: fixtureName(fixture),
      league: fixture.league.name,
      startsAt: fixture.fixture.date,
      status: fixture.fixture.status?.long || "Agendado",
      apiContext: input.fixtureContexts?.[String(fixture.fixture.id)],
      picks: input.picks.filter((pick) => pick.fixtureId === fixture.fixture.id),
    })),
    traps: input.picks
      .filter((pick) => pick.odd < 1.2 || pick.odd > 2.8)
      .map((pick) => `${pick.game} | ${pick.market} | ${pick.selection} (${pick.odd})`),
    recommendedTicket: {
      title: "Bilhete pronto",
      ...recommendedTicket,
    },
  };
}

async function aiAnalysis(payload: unknown) {
  const model = getEnv("OPENAI_MODEL") || DEFAULT_MODEL;
  const openai = new OpenAI();

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.25,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Voce e um analista profissional de apostas esportivas.",
          "Use somente os dados fornecidos no JSON. Nao invente lesoes, escalacoes, odds ou estatisticas ausentes.",
          "Escreva em portugues do Brasil, direto, frio e no formato de decisao.",
          "Use fixtureContexts para forma recente, H2H, lesoes e lineups quando houver.",
          "Devolva JSON valido com: summary, gameByGame, traps, conservativeTicket, balancedTicket, boldTicket, mainRecommendation.",
          "Cada selecao deve conter game, market, selection, odd, impliedProbability, reason, risk.",
          "Preserve fixtureId, game, market, category, selection, odd e impliedProbability dos picks originais.",
          "Nunca use nomes genericos como Jogo, Match ou Fixture; use sempre o nome real dos times.",
          "Nunca use requestedMarkets como texto de market; market deve vir do pick original.",
          "Nao monte bilhetes apenas com resultado final ou vitoria seca quando existirem mercados alternativos no JSON.",
          "Nunca coloque duas selecoes do mesmo jogo no mesmo bilhete. Em escanteios, cartoes, gols ou chutes, escolha uma linha por jogo.",
          "Se requestedMarkets vier preenchido, use somente picks dessas categorias.",
          "Use somente picks recebidos no JSON. Nao use handicap, spread, asian handicap, linhas 0.25/0.75 ou mercados dificeis.",
          "Priorize mercados simples e provaveis: mais/menos gols, mais/menos escanteios, mais/menos cartoes, dupla chance e ambas marcam.",
          "Use no maximo 1 selecao de resultado final por bilhete, exceto se os picks nao tiverem nenhuma alternativa.",
          "mainRecommendation deve ser um bilhete pronto com selections, totalOdd e possibleReturn, nunca texto solto ou JSON serializado em string.",
          "Respeite maxSelections para o tamanho dos bilhetes.",
          "Quando nao houver dados suficientes, marque como baixa confianca e diga quais dados faltam."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ],
  });

  const content = completion.choices[0]?.message?.content || "{}";
  return JSON.parse(content);
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
  ticket = parseJsonLike(ticket);
  if (!ticket) return [];
  if (Array.isArray(ticket)) return ticket.filter(isSelectionLike);
  if (Array.isArray(ticket.selections)) return ticket.selections.filter(isSelectionLike);
  if (Array.isArray(ticket.picks)) return ticket.picks.filter(isSelectionLike);
  return isSelectionLike(ticket) ? [ticket] : [];
}

function parseJsonLike(value: any) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
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
    const fallbackCategory = fallback.category || marketCategory(String(fallback.market || ""), String(fallback.selection || ""));
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

function selectionFixtureKey(selection: any) {
  const fixtureId = Number(selection?.fixtureId || selection?.fixture_id || 0);
  if (fixtureId) return `fixture:${fixtureId}`;
  const game = normalizeText(selectionGameName(selection));
  return game && !isGenericGameName(game) ? `game:${game}` : "";
}

function dedupeTicketSelections(selections: any[], targetOdd?: number) {
  const byFixture = new Map<string, { selection: any; score: number; index: number }>();

  selections.forEach((selection, index) => {
    const category = marketCategory(String(selection.market || selection.category || ""), String(selection.selection || selection.pick || selection.value || ""));
    const key = selectionFixtureKey(selection) || `pick:${pickKey({
      fixtureId: Number(selection.fixtureId || 0),
      market: String(selection.market || ""),
      selection: String(selection.selection || selection.pick || selection.value || ""),
    })}`;
    const odd = Number(selection.odd);
    const score = Number.isFinite(odd)
      ? pickScore({ ...selection, odd, category } as NormalizedPick, targetOdd)
      : -1000;
    const current = byFixture.get(key);
    if (!current || score > current.score) {
      byFixture.set(key, { selection, score, index });
    }
  });

  return [...byFixture.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.selection);
}

function normalizeTicketShape(ticket: any, stake: number, fallbackSelections: any[] = []) {
  ticket = parseJsonLike(ticket);
  if (!ticket) return ticket;
  if (typeof ticket === "string") return { text: ticket, selections: [] };

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
    .filter((selection) => Number(selection.odd) >= 1.18)
    .slice()
    .sort((a, b) => {
      const aCategory = marketCategory(String(a.market || ""), String(a.selection || ""));
      const bCategory = marketCategory(String(b.market || ""), String(b.selection || ""));
      const aScore = pickScore({ ...a, odd: Number(a.odd), category: a.category || aCategory } as NormalizedPick, targetOdd);
      const bScore = pickScore({ ...b, odd: Number(b.odd), category: b.category || bCategory } as NormalizedPick, targetOdd);
      return bScore - aScore;
    });
  const chosen: any[] = [];
  const usedKeys = new Set<string>();
  const usedFixtures = new Set<string>();
  const usedCategories = new Set<MarketCategory>();

  const canAdd = (selection: any, requireNewCategory: boolean, avoidResult: boolean) => {
    const category = marketCategory(String(selection.market || ""), String(selection.selection || ""));
    const key = pickKey({
      fixtureId: Number(selection.fixtureId || 0),
      market: String(selection.market || ""),
      selection: String(selection.selection || ""),
    });
    const fixtureKey = selectionFixtureKey(selection) || key;

    if (usedKeys.has(key)) return false;
    if (usedFixtures.has(fixtureKey)) return false;
    if (requireNewCategory && usedCategories.has(category)) return false;
    if (avoidResult && category === "resultado_final") return false;
    return true;
  };

  const addSelection = (selection: any) => {
    const category = marketCategory(String(selection.market || ""), String(selection.selection || ""));
    const key = pickKey({
      fixtureId: Number(selection.fixtureId || 0),
      market: String(selection.market || ""),
      selection: String(selection.selection || ""),
    });
    chosen.push(selection);
    usedKeys.add(key);
    usedFixtures.add(selectionFixtureKey(selection) || key);
    usedCategories.add(category);
  };

  const passes = [
    { requireNewCategory: true, avoidResult: true },
    { requireNewCategory: false, avoidResult: true },
    { requireNewCategory: true, avoidResult: false },
    { requireNewCategory: false, avoidResult: false },
  ];

  for (const pass of passes) {
    for (const selection of ranked) {
      if (chosen.length >= maxSelections) break;
      if (canAdd(selection, pass.requireNewCategory, pass.avoidResult)) addSelection(selection);
    }
  }

  return normalizeTicketShape(chosen, stake, chosen);
}

function rebalanceTicketMarkets(ticket: any, fallbackSelections: any[], stake: number) {
  const normalized = normalizeTicketShape(ticket, stake, fallbackSelections);
  const selections = ticketSelections(normalized);
  if (!selections.length || !fallbackSelections.length) return normalized;

  const resultIndexes = selections
    .map((selection, index) => ({
      index,
      category: marketCategory(String(selection.market || ""), String(selection.selection || "")),
    }))
    .filter((item) => item.category === "resultado_final")
    .map((item) => item.index);

  if (!resultIndexes.length) return normalized;

  const usedKeys = new Set(selections.map((selection) => pickKey({
    fixtureId: Number(selection.fixtureId || 0),
    market: String(selection.market || ""),
    selection: String(selection.selection || ""),
  })));
  const usedFixtures = new Set(selections.map(selectionFixtureKey).filter(Boolean));
  const rankedAlternatives = fallbackSelections
    .filter((selection) => marketCategory(String(selection.market || ""), String(selection.selection || "")) !== "resultado_final")
    .slice()
    .sort((a, b) => pickScore({ ...b, odd: Number(b.odd), category: b.category || marketCategory(String(b.market || ""), String(b.selection || "")) } as NormalizedPick) -
      pickScore({ ...a, odd: Number(a.odd), category: a.category || marketCategory(String(a.market || ""), String(a.selection || "")) } as NormalizedPick));
  if (!rankedAlternatives.length) return normalized;

  const nextSelections = selections.slice();
  const indexesToReplace = resultIndexes.length === selections.length ? resultIndexes : resultIndexes.slice(1);

  for (const index of indexesToReplace) {
    const replacement = rankedAlternatives.find((selection) => {
      const key = pickKey({
        fixtureId: Number(selection.fixtureId || 0),
        market: String(selection.market || ""),
        selection: String(selection.selection || ""),
      });
      const fixtureKey = selectionFixtureKey(selection);
      return !usedKeys.has(key) && (!fixtureKey || !usedFixtures.has(fixtureKey));
    });
    if (!replacement) break;

    const old = nextSelections[index];
    usedKeys.delete(pickKey({
      fixtureId: Number(old.fixtureId || 0),
      market: String(old.market || ""),
      selection: String(old.selection || ""),
    }));
    const oldFixtureKey = selectionFixtureKey(old);
    if (oldFixtureKey) usedFixtures.delete(oldFixtureKey);
    nextSelections[index] = replacement;
    usedKeys.add(pickKey({
      fixtureId: Number(replacement.fixtureId || 0),
      market: String(replacement.market || ""),
      selection: String(replacement.selection || ""),
    }));
    const replacementFixtureKey = selectionFixtureKey(replacement);
    if (replacementFixtureKey) usedFixtures.add(replacementFixtureKey);
  }

  return normalizeTicketShape({ ...normalized, selections: nextSelections }, stake, fallbackSelections);
}

function fallbackGameByGameFromSelections(fallbackSelections: any[]) {
  const byFixture = new Map<string, any[]>();

  for (const selection of fallbackSelections) {
    const key = selectionFixtureKey(selection) || normalizeText(selectionGameName(selection));
    if (!key) continue;
    const group = byFixture.get(key) || [];
    group.push(selection);
    byFixture.set(key, group);
  }

  return [...byFixture.values()].map((group) => {
    const best = group[0] || {};
    return {
      fixtureId: best.fixtureId,
      game: selectionGameName(best),
      league: best.league || "Competicao nao informada",
      startsAt: best.startsAt,
      bestMarket: best.market,
      reason: "Jogo cruzado com API-Football e odds disponiveis para os mercados filtrados.",
      risk: Number(best.odd) >= 2 ? "alto" : "medio",
      picks: group.slice(0, 5),
    };
  });
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
    if (normalized[key]?.selections?.length && fallbackSelections.length) {
      normalized[key] = rebalanceTicketMarkets(normalized[key], fallbackSelections, stake);
    }
  }

  normalized.mainRecommendation = parseJsonLike(normalized.mainRecommendation);
  if (normalized.mainRecommendation && typeof normalized.mainRecommendation === "object") {
    normalized.mainRecommendation = normalizeTicketShape(normalized.mainRecommendation, stake, fallbackSelections);
  }
  if (!normalized.mainRecommendation?.selections?.length && normalized.balancedTicket?.selections?.length) {
    normalized.mainRecommendation = normalized.balancedTicket;
  }
  if (normalized.mainRecommendation?.selections?.length && fallbackSelections.length) {
    normalized.mainRecommendation = rebalanceTicketMarkets(normalized.mainRecommendation, fallbackSelections, stake);
  }

  const hasUsefulGameByGame = Array.isArray(normalized.gameByGame) && normalized.gameByGame.some((item: any) => {
    const game = item?.game || item?.apiGame || item?.fixture || item?.match;
    return !isGenericGameName(game);
  });
  if (!hasUsefulGameByGame && fallbackSelections.length) {
    normalized.gameByGame = fallbackGameByGameFromSelections(fallbackSelections);
  }

  return normalized;
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Use POST" }, { status: 405 });
  }

  let body: SearchRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON invalido" }, { status: 400 });
  }

  const query = (body.query || "").trim();
  const date = body.date || new Date().toISOString().slice(0, 10);
  const riskProfile = body.riskProfile || "moderado";
  const stake = Number(body.stake || 5);
  const maxSelections = Math.max(1, Math.min(8, Number(body.maxSelections || 4)));
  const requestedGames = splitRequestedGames(query);
  const requestedMarkets = requestedMarketCategories(body.markets);

  if (!requestedGames.length) {
    return json({ error: "Informe pelo menos um jogo" }, { status: 400 });
  }

  if (!getEnv("API_FOOTBALL_KEY")) {
    return json({
      error: "API_FOOTBALL_KEY ausente",
      setup: [
        "Crie uma chave na API-Football/API-SPORTS.",
        "No Netlify: Site configuration > Environment variables.",
        "Adicione API_FOOTBALL_KEY com sua chave.",
        "Depois publique novamente o site."
      ],
    }, { status: 501 });
  }

  let searchedDates = [date];
  let usedTeamSearchFallback = false;
  let fixtures: ApiFootballFixture[];
  try {
    fixtures = await apiFootball("/fixtures", {
      date,
      timezone: DEFAULT_TIMEZONE,
    });
  } catch (error: any) {
    const friendly = friendlyErrorPayload(error, "API-Football falhou ao buscar fixtures");
    return json({
      ...friendly.body,
      setup: [
        "Confira se a API_FOOTBALL_KEY esta ativa e com quota.",
        "Confira se seu plano permite fixtures e odds da competicao.",
        "Tente novamente em alguns minutos se o provedor estiver limitando requisicoes."
      ],
    }, { status: friendly.status === 500 ? 502 : friendly.status });
  }

  let matchResults = requestedGames.map((game) => ({
    requested: game,
    fixture: matchFixture(game, fixtures),
  }));

  if (matchResults.some((result) => !result.fixture)) {
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
    matchResults = requestedGames.map((game) => {
      const previous = matchResults.find((result) => result.requested === game && result.fixture);
      return previous || {
        requested: game,
        fixture: matchFixture(game, fixtures),
      };
    });
  }

  if (matchResults.some((result) => !result.fixture)) {
    const teamSearchGroups = await Promise.all(
      matchResults
        .filter((result) => !result.fixture)
        .map((result) => searchFixturesByTeams(result.requested))
    );
    const teamSearchFixtures = uniqueFixtures(teamSearchGroups.flat());

    if (teamSearchFixtures.length) {
      usedTeamSearchFallback = true;
      fixtures = uniqueFixtures([...fixtures, ...teamSearchFixtures]);
      matchResults = requestedGames.map((game) => {
        const previous = matchResults.find((result) => result.requested === game && result.fixture);
        return previous || {
          requested: game,
          fixture: matchFixture(game, fixtures),
        };
      });
    }
  }

  const matchedFixtures = matchResults
    .map((result) => result.fixture)
    .filter((fixture): fixture is ApiFootballFixture => Boolean(fixture));
  const unmatchedGames = matchResults
    .filter((result) => !result.fixture)
    .map((result) => result.requested);

  const oddsGroups = await Promise.all(
    matchedFixtures.map(async (fixture) => {
      try {
        const odds = await apiFootball("/odds", {
          fixture: fixture.fixture.id,
          timezone: DEFAULT_TIMEZONE,
        });
        return bestPrematchPicks(fixture, odds, requestedMarkets);
      } catch {
        return [];
      }
    })
  );

  const picks = oddsGroups.flat();
  const contextEntries = await Promise.all(
    matchedFixtures.slice(0, 8).map(async (fixture) => {
      return [String(fixture.fixture.id), await fetchFixtureContext(fixture)] as const;
    })
  );
  const fixtureContexts = Object.fromEntries(contextEntries);
  const payload = {
    generatedAt: new Date().toISOString(),
    date,
    riskProfile,
    stake,
    maxSelections,
    requestedMarkets,
    requestedGames,
    unmatchedGames,
    fixtures: matchedFixtures,
    picks,
    fixtureContexts,
    providerNotes: {
      apiFootball: "Fixtures do dia e odds pre-jogo quando disponiveis. Odds pre-jogo podem atualizar em intervalo do provedor.",
      confidence: picks.length ? "media" : "baixa",
      marketFilter: requestedMarkets.length ? "Mercados marcados pelo usuario aplicados antes da montagem do bilhete." : "Sem filtro manual de mercado.",
    },
  };

  let analysis;
  try {
    const canUseAi = Boolean((getEnv("OPENAI_BASE_URL") || getEnv("OPENAI_API_KEY")) && matchedFixtures.length && picks.length);
    analysis = canUseAi
      ? await aiAnalysis(payload)
      : deterministicAnalysis({ requestedGames, matchedFixtures, picks, riskProfile, stake, maxSelections, requestedMarkets, fixtureContexts });
  } catch (error) {
    analysis = deterministicAnalysis({ requestedGames, matchedFixtures, picks, riskProfile, stake, maxSelections, requestedMarkets, fixtureContexts });
  }
  analysis = normalizeAnalysisShape(analysis, stake, picks, maxSelections);

  return json({
    source: {
      provider: "API-Football + casas disponiveis",
      date,
      searchedDates,
      usedTeamSearchFallback,
      timezone: DEFAULT_TIMEZONE,
      matched: matchedFixtures.length,
      unmatchedGames,
      picksFound: picks.length,
      requestedMarkets,
      marketFilterApplied: requestedMarkets.length > 0,
    },
    analysis,
    raw: {
      fixtures: matchedFixtures,
      picks,
    },
  });
};

export const config = {
  path: "/api/analyze-games",
  method: ["POST"],
};
