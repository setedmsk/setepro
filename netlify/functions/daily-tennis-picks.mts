import { getStore } from "@netlify/blobs";
import { externalServiceError, fetchWithTimeout, friendlyErrorPayload } from "./_shared/http.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const ODDSPAPI_BASE = "https://api.oddspapi.io/v4/";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_STAKE = 5;
const DEFAULT_MAX_SELECTIONS = 5;
const TENNIS_GAME_LIMIT = 5;
const TENNIS_CANDIDATE_LIMIT = 16;
const TOURNAMENT_LIMIT = 18;
const MAX_ODDS_REQUESTS = 10;
const BOOKMAKER_CANDIDATES = [
  { slug: "pinnacle", label: "Pinnacle", priority: 14 },
  { slug: "bet365", label: "Bet365", priority: 13 },
  { slug: "betfair-spb", label: "Betfair", priority: 12 },
  { slug: "1xbet", label: "1xBet", priority: 10 },
  { slug: "sbobet", label: "SBOBET", priority: 9 },
  { slug: "stake", label: "Stake", priority: 8 },
  { slug: "unibet", label: "Unibet", priority: 7 },
  { slug: "betway", label: "Betway", priority: 6 },
  { slug: "bwin", label: "Bwin", priority: 5 },
  { slug: "williamhill", label: "William Hill", priority: 4 },
];

type TennisSport = {
  id: string | number;
  name: string;
  slug?: string;
};

type TennisCategory = "vencedor" | "total_games" | "primeiro_set" | "outros";

type TennisPick = {
  fixtureId: string;
  sport: string;
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category: TennisCategory;
  selection: string;
  odd: number;
  bookmaker: string;
  impliedProbability: number;
  score: number;
  reason?: string;
};

type TennisReport = {
  source: {
    provider: string;
    date: string;
    generatedAt: string;
    timezone: string;
    schedule: string;
    sportsFound: number;
    gamesFound: number;
    searchedDates: string[];
    searchMode: string;
    gameLimit: number;
    candidateLimit: number;
    dateEligibleFound: number;
    nextAvailableDate?: string;
    oddsRequests: number;
    gamesAnalyzed: number;
    matched: number;
    picksFound: number;
    bookmakerFilter: string;
    errors?: string[];
    cached?: boolean;
  };
  analysis: Record<string, unknown>;
  raw: {
    fixtures: any[];
    picks: TennisPick[];
  };
};

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

function oddsPapiKey() {
  return getEnv("TENNIS_ODDS_API_KEY") || getEnv("ODDSPAPI_KEY") || getEnv("ODDS_PAPI_KEY");
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function todayInSaoPaulo() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {} as Record<string, string>);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function searchedDatesFor(date: string) {
  return [date, addDays(date, 1), addDays(date, 2)];
}

function localDateFromIso(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {} as Record<string, string>);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function bookmakerLabel(slug?: string) {
  const normalized = String(slug || "").toLowerCase();
  const candidate = BOOKMAKER_CANDIDATES.find((item) => item.slug === normalized);
  if (candidate) return candidate.label;
  return String(slug || "Casa nao informada").replace(/[-_]+/g, " ");
}

function bookmakerPriority(slug?: string) {
  const normalized = String(slug || "").toLowerCase();
  return BOOKMAKER_CANDIDATES.find((item) => item.slug === normalized)?.priority || 0;
}

function arrayFromResponse(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  for (const key of ["data", "response", "results", "fixtures", "events", "sports", "tournaments"]) {
    if (Array.isArray(data[key])) return data[key];
  }

  return Object.values(data).flatMap((value) => Array.isArray(value) ? value : []);
}

async function apiOddsPapi(path: string, params: Record<string, string | number | undefined> = {}) {
  const key = oddsPapiKey();
  const url = new URL(path.replace(/^\/+/, ""), ODDSPAPI_BASE);
  url.searchParams.set("apiKey", key);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  const response = await fetchWithTimeout(url, {}, 8000, "OddsPapi");
  if (!response.ok) {
    let detail = response.statusText || "Erro sem detalhe";
    try {
      const errorData = await response.json();
      const error = errorData?.error || errorData;
      const code = error?.code ? ` ${error.code}` : "";
      const message = error?.message || errorData?.message || detail;
      const details = error?.details || errorData?.details || "";
      detail = `${message}${code}${details ? ` - ${details}` : ""}`;
    } catch {
      // Keep the HTTP status when the API does not return JSON.
    }
    throw externalServiceError("OddsPapi", `HTTP ${response.status}: ${detail}`, response.status === 429 ? 429 : 502);
  }

  const data = await response.json();
  if (data?.error) throw externalServiceError("OddsPapi", String(data.error));
  if (Array.isArray(data?.errors) && data.errors.length) {
    const detail = data.errors.join(" | ");
    throw externalServiceError("OddsPapi", detail, /quota|rate|limit|too many/i.test(detail) ? 429 : 502);
  }
  return data?.data ?? data?.response ?? data?.results ?? data;
}

function looksLikeTennis(value: string) {
  const normalized = normalizeText(value);
  return normalized.includes("tennis") || normalized.includes("atp") || normalized.includes("wta");
}

function sportPriority(sport: TennisSport) {
  const normalized = normalizeText(`${sport.name} ${sport.slug || ""}`);
  if (normalized.includes("tennis")) return 14;
  if (normalized.includes("atp") || normalized.includes("wta")) return 12;
  return 0;
}

async function loadTennisSports() {
  const sports = arrayFromResponse(await apiOddsPapi("/sports", { language: "en" }))
    .map((item) => ({
      id: item.sportId ?? item.id ?? item.key ?? item.slug,
      name: String(item.sportName || item.name || item.title || item.slug || item.id || ""),
      slug: item.slug || item.key,
    }))
    .filter((sport) => sport.id && looksLikeTennis(`${sport.name} ${sport.slug || ""}`))
    .sort((a, b) => sportPriority(b) - sportPriority(a));

  return sports.slice(0, 4);
}

function tournamentId(item: any) {
  return item?.tournamentId ?? item?.id ?? item?.leagueId ?? item?.competitionId;
}

function tournamentPriority(item: any) {
  const name = normalizeText(`${item?.tournamentName || item?.name || ""} ${item?.categoryName || ""}`);
  const count = Number(item?.upcomingFixtures || 0) + Number(item?.futureFixtures || 0) + Number(item?.liveFixtures || 0);
  let score = count > 0 ? Math.min(20, count) : 0;
  if (name.includes("grand slam") || name.includes("wimbledon") || name.includes("roland") || name.includes("us open") || name.includes("australian")) score += 14;
  if (name.includes("atp") || name.includes("wta")) score += 10;
  if (name.includes("challenger")) score += 5;
  if (name.includes("itf")) score -= 3;
  return score;
}

async function loadTournamentsForSport(sport: TennisSport) {
  const tournaments = arrayFromResponse(await apiOddsPapi("/tournaments", {
    sportId: sport.id,
    language: "en",
  }));

  return tournaments
    .filter((item) => tournamentId(item))
    .sort((a, b) => tournamentPriority(b) - tournamentPriority(a))
    .slice(0, TOURNAMENT_LIMIT);
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function participantNames(fixture: any) {
  const participants = fixture?.participants || {};
  const home = participants.home?.name
    || participants[0]?.name
    || fixture?.home?.name
    || fixture?.teams?.home?.name
    || fixture?.participant1Name
    || fixture?.participant1ShortName
    || "Jogador 1";
  const away = participants.away?.name
    || participants[1]?.name
    || fixture?.away?.name
    || fixture?.teams?.away?.name
    || fixture?.participant2Name
    || fixture?.participant2ShortName
    || "Jogador 2";
  return { home: String(home), away: String(away) };
}

function fixtureName(fixture: any) {
  const direct = fixture?.name || fixture?.eventName || fixture?.matchName;
  if (direct && String(direct).trim()) return String(direct);
  const names = participantNames(fixture);
  return `${names.home} x ${names.away}`;
}

function fixtureLeague(fixture: any) {
  return String(
    fixture?.tournamentName
    || fixture?.league?.name
    || fixture?.competition?.name
    || fixture?.categoryName
    || fixture?.sportName
    || "Competicao nao informada"
  );
}

function fixtureStart(fixture: any) {
  return String(fixture?.startTime || fixture?.startsAt || fixture?.date || fixture?.commence_time || fixture?.fixture?.date || "");
}

function fixtureKey(fixture: any, sport: TennisSport) {
  return String(
    fixture?.fixtureId
    || fixture?.id
    || fixture?.eventId
    || `${sport.id}:${fixtureName(fixture)}:${fixtureStart(fixture)}`
  );
}

function mergeFixtureOdds(current: any, incoming: any) {
  const currentBookmakers = current?.bookmakerOdds || current?.bookmakers || {};
  const incomingBookmakers = incoming?.bookmakerOdds || incoming?.bookmakers || {};
  const bookmakerOdds = {
    ...currentBookmakers,
    ...incomingBookmakers,
  };

  return {
    ...current,
    ...incoming,
    bookmakerOdds,
    bookmakers: bookmakerOdds,
  };
}

function isPregameFixture(fixture: any) {
  const status = normalizeText(String(fixture?.statusName || fixture?.status?.long || fixture?.status || ""));
  if (["ended", "finished", "cancelled", "canceled", "postponed", "abandoned"].some((item) => status.includes(item))) return false;
  if (fixture?.statusId !== undefined && Number(fixture.statusId) > 1) return false;
  return true;
}

function isAllowedDateFixture(fixture: any, allowedDates: Set<string>) {
  const localDate = localDateFromIso(fixtureStart(fixture));
  return !localDate || allowedDates.has(localDate);
}

function countEligibleFixtures(fixtures: Iterable<any>, allowedDates: Set<string>) {
  let count = 0;
  for (const fixture of fixtures) {
    if (isPregameFixture(fixture) && isAllowedDateFixture(fixture, allowedDates)) count += 1;
  }
  return count;
}

function hasDifficultLine(value: string) {
  return /(^|[^\d])\d+[,.](25|75)([^\d]|$)/.test(String(value || ""));
}

function lineFromText(value: string) {
  const match = String(value || "").match(/\d+(?:[,.]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : null;
}

function isFirstSetText(value: string) {
  const normalized = normalizeText(value);
  return (
    normalized.includes("1st set") ||
    normalized.includes("first set") ||
    normalized.includes("set 1") ||
    normalized.includes("1 set")
  );
}

function isUnsupportedMarket(text: string) {
  const normalized = normalizeText(text);
  if (isFirstSetText(text) && (normalized.includes("winner") || normalized.includes("moneyline"))) return false;
  return [
    "handicap",
    "spread",
    "asian",
    "correct score",
    "exact score",
    "set betting",
    "sets handicap",
    "game handicap",
    "player props",
    "aces",
    "double fault",
    "break point",
    "tie break",
    "tiebreak",
    "race to",
    "odd even",
    "point",
    "retirement",
    "live",
  ].some((fragment) => normalized.includes(fragment)) || hasDifficultLine(text);
}

function outcomeSide(outcomeRef: string, names: { home: string; away: string }) {
  const text = normalizeText(outcomeRef);
  const home = normalizeText(names.home);
  const away = normalizeText(names.away);
  if (outcomeRef === "1" || text === "home" || text.includes(home)) return names.home;
  if (outcomeRef === "2" || outcomeRef === "3" || text === "away" || text.includes(away)) return names.away;
  if (text && home.includes(text)) return names.home;
  if (text && away.includes(text)) return names.away;
  return "";
}

function marketFromRaw(marketRef: string, outcomeRef: string, names: { home: string; away: string }) {
  const combined = `${marketRef} ${outcomeRef}`;
  const text = normalizeText(combined);
  if (isUnsupportedMarket(combined)) return null;

  const side = outcomeSide(outcomeRef, names);
  if (isFirstSetText(combined) && side && (text.includes("winner") || text.includes("moneyline") || text.includes("home away"))) {
    return {
      category: "primeiro_set" as TennisCategory,
      market: "Vencedor do 1o set",
      selection: side,
    };
  }

  if (text.includes("total") || text.includes("over") || text.includes("under")) {
    const line = lineFromText(outcomeRef) ?? lineFromText(marketRef);
    const looksLikeGames = text.includes("games") || (line !== null && line >= 16.5 && line <= 30.5);
    if (looksLikeGames && line !== null && line >= 16.5 && line <= 30.5) {
      if (text.includes("over") || text.includes("mais")) {
        return {
          category: "total_games" as TennisCategory,
          market: "Total de games - Mais/Menos",
          selection: `Mais de ${line.toFixed(1)} games`,
        };
      }
      if (text.includes("under") || text.includes("menos")) {
        return {
          category: "total_games" as TennisCategory,
          market: "Total de games - Mais/Menos",
          selection: `Menos de ${line.toFixed(1)} games`,
        };
      }
    }
  }

  if (side && (marketRef === "1" || text.includes("moneyline") || text.includes("match winner") || text.includes("winner") || text.includes("home away"))) {
    if (text.includes("draw")) return null;
    return {
      category: "vencedor" as TennisCategory,
      market: "Vencedor da partida",
      selection: side,
    };
  }

  return null;
}

function pickScore(pick: Pick<TennisPick, "odd" | "category" | "bookmaker">, fixture: any) {
  const base = pick.category === "vencedor" ? 56 : pick.category === "primeiro_set" ? 46 : pick.category === "total_games" ? 43 : 0;
  const target = pick.category === "vencedor" ? 1.55 : pick.category === "primeiro_set" ? 1.62 : 1.72;
  const oddPenalty = Math.abs(pick.odd - target) * 8;
  const lowPenalty = pick.odd < 1.18 ? 10 : 0;
  const highPenalty = pick.odd > 2.25 ? (pick.odd - 2.25) * 12 : 0;
  const league = normalizeText(fixtureLeague(fixture));
  const leagueBoost = league.includes("atp") || league.includes("wta") ? 8 : league.includes("challenger") ? 4 : league.includes("itf") ? -3 : 0;
  const bookmakerBoost = bookmakerPriority(pick.bookmaker) * 0.35;
  return base + leagueBoost + bookmakerBoost - oddPenalty - lowPenalty - highPenalty;
}

function reasonForPick(pick: TennisPick) {
  if (pick.category === "vencedor") return "Mercado direto de tenis: vencedor da partida, sem handicap.";
  if (pick.category === "primeiro_set") return "Vencedor do 1o set, mercado simples quando a odd compensa.";
  if (pick.category === "total_games") return "Total de games em linha comum, evitando handicap e placar exato.";
  return "Mercado filtrado por clareza, odd e disponibilidade na casa.";
}

function collectPicksFromFixture(fixture: any, sport: TennisSport) {
  const names = participantNames(fixture);
  const bookmakerOdds = fixture?.bookmakerOdds || fixture?.bookmakers || {};
  const picksByKey = new Map<string, TennisPick>();
  const fixtureId = String(fixture?.fixtureId || fixture?.id || fixture?.eventId || `${sport.id}:${fixtureName(fixture)}`);

  for (const [bookmakerSlug, bookmakerEntry] of Object.entries(bookmakerOdds || {}) as Array<[string, any]>) {
    const markets = bookmakerEntry?.markets || bookmakerEntry?.bets || {};
    const bookmaker = bookmakerLabel(bookmakerSlug);

    for (const [marketKey, market] of Object.entries(markets || {}) as Array<[string, any]>) {
      const marketRef = String(market?.bookmakerMarketId || market?.name || market?.marketName || marketKey || "");
      if (isUnsupportedMarket(marketRef)) continue;

      const outcomes = market?.outcomes || market?.values || market?.selections || {};
      for (const [outcomeKey, outcome] of Object.entries(outcomes || {}) as Array<[string, any]>) {
        const outcomeRef = String(outcome?.bookmakerOutcomeId || outcome?.name || outcome?.label || outcome?.value || outcomeKey || "");
        const players = outcome?.players && typeof outcome.players === "object" ? Object.values(outcome.players) : [outcome];

        for (const player of players as any[]) {
          const playerOutcomeRef = String(player?.bookmakerOutcomeId || outcomeRef);
          const combinedText = `${marketRef} ${outcomeRef} ${playerOutcomeRef} ${player?.playerName || ""}`;
          if (isUnsupportedMarket(combinedText)) continue;
          if (market?.marketActive === false || outcome?.active === false || player?.active === false) continue;

          const odd = Number(player?.price ?? player?.odd ?? player?.odds ?? outcome?.price ?? outcome?.odd ?? 0);
          if (!Number.isFinite(odd) || odd < 1.15 || odd > 2.35) continue;

          const parsedMarket = marketFromRaw(marketRef, playerOutcomeRef, names)
            || marketFromRaw(marketRef, outcomeRef, names);
          if (!parsedMarket || parsedMarket.category === "outros") continue;

          const pick: TennisPick = {
            fixtureId,
            sport: "Tenis",
            game: fixtureName(fixture),
            league: fixtureLeague(fixture),
            startsAt: fixtureStart(fixture),
            market: parsedMarket.market,
            category: parsedMarket.category,
            selection: parsedMarket.selection,
            odd: Number(odd.toFixed(2)),
            bookmaker,
            impliedProbability: Number((100 / odd).toFixed(2)),
            score: 0,
          };
          pick.score = pickScore(pick, fixture);
          pick.reason = reasonForPick(pick);

          const key = normalizeText(`${fixtureId}|${pick.category}|${pick.market}|${pick.selection}`);
          const current = picksByKey.get(key);
          if (!current || pick.score > current.score || (pick.score === current.score && pick.odd > current.odd)) {
            picksByKey.set(key, pick);
          }
        }
      }
    }
  }

  return [...picksByKey.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

function isIgnorableOddsError(value: unknown) {
  return /fixture_not_found|no fixtures found|restricted bookmaker|restricted_access|invalid bookmaker|not found|rate_limited|rate limited/i.test(String(value || ""));
}

async function fetchSportFixturesWithOdds(sport: TennisSport, maxRequests: number, allowedDates: Set<string>) {
  let oddsRequests = 0;
  const fixturesByKey = new Map<string, any>();
  const errors: string[] = [];
  const primaryBookmakers = BOOKMAKER_CANDIDATES.slice(0, 4);

  const addFixtures = (items: any[]) => {
    for (const fixture of items) {
      const key = fixtureKey(fixture, sport);
      const current = fixturesByKey.get(key);
      fixturesByKey.set(key, current ? mergeFixtureOdds(current, fixture) : fixture);
    }
  };
  const eligibleCount = () => countEligibleFixtures(fixturesByKey.values(), allowedDates);
  const hasEnoughEligibleFixtures = () => eligibleCount() >= TENNIS_CANDIDATE_LIMIT;

  let tournaments: any[] = [];
  try {
    tournaments = await loadTournamentsForSport(sport);
  } catch (error: any) {
    errors.push(error?.message || String(error || ""));
  }

  const tournamentIds = tournaments.map(tournamentId).filter(Boolean).map(String);
  for (const ids of chunk(tournamentIds, 4)) {
    if (!ids.length) continue;
    for (const bookmaker of primaryBookmakers) {
      if (oddsRequests >= maxRequests) break;
      oddsRequests += 1;
      try {
        const data = await apiOddsPapi("/odds-by-tournaments", {
          tournamentIds: ids.join(","),
          bookmaker: bookmaker.slug,
          oddsFormat: "decimal",
          language: "en",
          verbosity: 3,
        });
        addFixtures(arrayFromResponse(data));
      } catch (error: any) {
        const message = error?.message || String(error || "");
        if (!isIgnorableOddsError(message)) errors.push(message);
      }
      if (hasEnoughEligibleFixtures()) break;
    }
    if (hasEnoughEligibleFixtures()) break;
    if (oddsRequests >= maxRequests) break;
  }

  if (!hasEnoughEligibleFixtures() && oddsRequests < maxRequests) {
    for (const bookmaker of BOOKMAKER_CANDIDATES) {
      if (oddsRequests >= maxRequests) break;
      oddsRequests += 1;
      try {
        const data = await apiOddsPapi("/odds", {
          sportId: sport.id,
          bookmaker: bookmaker.slug,
          oddsFormat: "decimal",
          language: "en",
          verbosity: 3,
        });
        addFixtures(arrayFromResponse(data));
      } catch (error: any) {
        const message = error?.message || String(error || "");
        if (!isIgnorableOddsError(message)) errors.push(message);
      }
      if (hasEnoughEligibleFixtures()) break;
    }
  }

  return { fixtures: [...fixturesByKey.values()], oddsRequests, errors };
}

async function collectTennisPicks(date: string) {
  const sports = await loadTennisSports();
  const allowedDates = new Set(searchedDatesFor(date));
  const fixturesWithPicks: Array<{ fixture: any; picks: TennisPick[] }> = [];
  const usedFixtureKeys = new Set<string>();
  let oddsRequests = 0;
  let gamesFound = 0;
  let dateEligibleFound = 0;
  let nextAvailableDate = "";
  const errors: string[] = [];

  for (const sport of sports) {
    const remainingRequests = Math.max(0, MAX_ODDS_REQUESTS - oddsRequests);
    if (!remainingRequests) break;
    const result = await fetchSportFixturesWithOdds(sport, remainingRequests, allowedDates);
    oddsRequests += result.oddsRequests;
    gamesFound += result.fixtures.length;
    errors.push(...result.errors);

    for (const fixture of result.fixtures) {
      const localDate = localDateFromIso(fixtureStart(fixture));
      if (isPregameFixture(fixture) && isAllowedDateFixture(fixture, allowedDates)) {
        dateEligibleFound += 1;
      } else if (isPregameFixture(fixture) && localDate && !allowedDates.has(localDate)) {
        if (!nextAvailableDate || localDate < nextAvailableDate) nextAvailableDate = localDate;
      }
    }

    const candidates = result.fixtures
      .filter(isPregameFixture)
      .filter((fixture) => {
        const localDate = localDateFromIso(fixtureStart(fixture));
        return !localDate || allowedDates.has(localDate);
      })
      .sort((a, b) => {
        const aDate = fixtureStart(a) || "";
        const bDate = fixtureStart(b) || "";
        return aDate.localeCompare(bDate);
      })
      .slice(0, TENNIS_CANDIDATE_LIMIT);

    for (const fixture of candidates) {
      const key = fixtureKey(fixture, sport);
      if (usedFixtureKeys.has(key)) continue;
      const picks = collectPicksFromFixture(fixture, sport);
      if (picks.length) {
        fixturesWithPicks.push({ fixture, picks });
        usedFixtureKeys.add(key);
      }
      if (fixturesWithPicks.length >= TENNIS_GAME_LIMIT) break;
    }

    if (fixturesWithPicks.length >= TENNIS_GAME_LIMIT) break;
    if (oddsRequests >= MAX_ODDS_REQUESTS) break;
  }

  fixturesWithPicks.sort((a, b) => (b.picks[0]?.score || 0) - (a.picks[0]?.score || 0));

  return {
    sports,
    gamesFound,
    dateEligibleFound,
    nextAvailableDate,
    oddsRequests,
    errors,
    fixtures: fixturesWithPicks.map((item) => item.fixture).slice(0, TENNIS_GAME_LIMIT),
    picks: fixturesWithPicks.flatMap((item) => item.picks).sort((a, b) => b.score - a.score),
  };
}

function chooseTicketSelections(picks: TennisPick[], maxSelections: number, mode: "conservative" | "balanced" | "bold") {
  const ranges = {
    conservative: { min: 1.18, max: 1.68, limit: Math.min(2, maxSelections) },
    balanced: { min: 1.22, max: 1.95, limit: Math.min(3, maxSelections) },
    bold: { min: 1.35, max: 2.25, limit: Math.min(4, maxSelections) },
  };
  const range = ranges[mode];
  const chosen: TennisPick[] = [];
  const usedEvents = new Set<string>();
  const ranked = picks
    .filter((pick) => pick.odd >= range.min && pick.odd <= range.max)
    .slice()
    .sort((a, b) => b.score - a.score);

  for (const pick of ranked) {
    if (chosen.length >= range.limit) break;
    if (usedEvents.has(pick.fixtureId)) continue;
    chosen.push(pick);
    usedEvents.add(pick.fixtureId);
  }

  return chosen;
}

function buildTicket(picks: TennisPick[], maxSelections: number, stake: number, mode: "conservative" | "balanced" | "bold") {
  const selections = chooseTicketSelections(picks, maxSelections, mode);
  if (!selections.length) return { selections: [] };
  const totalOdd = selections.reduce((total, selection) => total * selection.odd, 1);
  return {
    selections,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * stake).toFixed(2)),
    reason: mode === "conservative"
      ? "Bilhete curto com mercados mais diretos de tenis."
      : mode === "balanced"
        ? "Melhor equilibrio entre vencedor, total de games e odd."
        : "Retorno maior sem usar handicap ou placar exato.",
  };
}

function deterministicAnalysis(fixtures: any[], picks: TennisPick[], stake: number, maxSelections: number, date: string) {
  const topPicksByEvent = new Map<string, TennisPick[]>();
  for (const pick of picks) {
    const list = topPicksByEvent.get(pick.fixtureId) || [];
    list.push(pick);
    topPicksByEvent.set(pick.fixtureId, list);
  }

  const gameByGame = fixtures.map((fixture) => {
    const fixtureId = String(fixture?.fixtureId || fixture?.id || fixture?.eventId || fixtureName(fixture));
    const eventPicks = (topPicksByEvent.get(fixtureId) || []).slice(0, 3);
    const best = eventPicks[0];
    return {
      game: fixtureName(fixture),
      apiGame: fixtureName(fixture),
      league: fixtureLeague(fixture),
      startsAt: fixtureStart(fixture),
      bestMarket: best?.market || "",
      reason: best
        ? `${best.selection} foi a melhor entrada encontrada. ${best.reason || ""}`
        : "Evento encontrado, mas sem vencedor/total de games/1o set dentro dos filtros.",
      risk: best?.odd && best.odd >= 1.9 ? "alto" : "medio",
      picks: eventPicks,
    };
  });

  return {
    summary: picks.length
      ? `Palpites de tenis gerados para ${date}. Usei OddsPapi e mercados simples: vencedor da partida, total de games e vencedor do 1o set. Handicap ficou fora.`
      : "Nao achei odds aproveitaveis em tenis nos mercados simples. O painel ficou vazio de proposito para nao trazer mercados ruins.",
    gameByGame,
    traps: picks
      .filter((pick) => pick.odd < 1.18 || pick.odd > 2.25)
      .slice(0, 5)
      .map((pick) => ({
        game: pick.game,
        market: pick.market,
        selection: pick.selection,
        odd: pick.odd,
        reason: pick.odd < 1.18 ? "Odd baixa demais para retorno pequeno." : "Odd alta para priorizar no bilhete principal.",
      })),
    conservativeTicket: buildTicket(picks, maxSelections, stake, "conservative"),
    balancedTicket: buildTicket(picks, maxSelections, stake, "balanced"),
    boldTicket: buildTicket(picks, maxSelections, stake, "bold"),
    mainRecommendation: buildTicket(picks, maxSelections, stake, "balanced"),
  };
}

async function computeReport(date: string, stake: number, maxSelections: number): Promise<TennisReport> {
  const collected = await collectTennisPicks(date);
  const selectionLimit = Math.max(1, Math.min(TENNIS_GAME_LIMIT, maxSelections));
  const fixtures = collected.fixtures;
  const picks = collected.picks;

  const analysis = deterministicAnalysis(fixtures, picks, stake, selectionLimit, date);
  if (!picks.length && !collected.dateEligibleFound && collected.nextAvailableDate) {
    analysis.summary = `A OddsPapi respondeu e trouxe odds de tenis, mas nao encontrei eventos entre ${searchedDatesFor(date).join(", ")}. O primeiro jogo com odds encontrado na varredura esta em ${collected.nextAvailableDate}.`;
  } else if (!picks.length && collected.dateEligibleFound) {
    analysis.summary = `Encontrei ${collected.dateEligibleFound} jogo(s) de tenis no recorte, mas nenhum com mercado simples aproveitavel dentro dos filtros.`;
  }

  return {
    source: {
      provider: "OddsPapi + casas disponiveis + Palpites Tenis",
      date,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      schedule: "On-demand",
      sportsFound: collected.sports.length,
      gamesFound: collected.gamesFound,
      searchedDates: searchedDatesFor(date),
      searchMode: "hoje + proximos dias",
      gameLimit: TENNIS_GAME_LIMIT,
      candidateLimit: TENNIS_CANDIDATE_LIMIT,
      dateEligibleFound: collected.dateEligibleFound,
      ...(collected.nextAvailableDate ? { nextAvailableDate: collected.nextAvailableDate } : {}),
      oddsRequests: collected.oddsRequests,
      gamesAnalyzed: fixtures.length,
      matched: fixtures.length,
      picksFound: picks.length,
      bookmakerFilter: "Casas disponiveis na OddsPapi",
      errors: collected.errors.slice(0, 4),
    },
    analysis,
    raw: {
      fixtures,
      picks,
    },
  };
}

function reportStore() {
  return getStore({ name: "daily-tennis-picks", consistency: "strong" });
}

function isUsableReport(report: TennisReport | null) {
  const picks = Array.isArray(report?.raw?.picks) ? report.raw.picks : [];
  return Boolean(
    report?.source?.picksFound &&
    report.source.picksFound > 0 &&
    String(report.source.provider || "").includes("OddsPapi") &&
    picks.length &&
    picks.every((pick) => pick.bookmaker && !isUnsupportedMarket(`${pick.market} ${pick.selection}`))
  );
}

async function readCachedReport(date: string) {
  try {
    const report = await reportStore().get(`reports/${date}.json`, { type: "json" }) as TennisReport | null;
    return isUsableReport(report) ? report : null;
  } catch {
    return null;
  }
}

async function saveReport(report: TennisReport) {
  if (!isUsableReport(report)) return;

  try {
    const store = reportStore();
    await store.setJSON(`reports/${report.source.date}.json`, report);
    await store.setJSON("latest.json", report);
  } catch {
    // The response remains useful even if blob storage is unavailable locally.
  }
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInSaoPaulo();
  const stake = Number(url.searchParams.get("stake") || DEFAULT_STAKE);
  const maxSelections = Math.max(1, Math.min(TENNIS_GAME_LIMIT, Number(url.searchParams.get("maxSelections") || DEFAULT_MAX_SELECTIONS)));
  const refresh = url.searchParams.get("refresh") === "1" || req.method === "POST";

  if (!oddsPapiKey()) {
    return json({
      error: "Chave OddsPapi ausente",
      setup: [
        "Configure ODDSPAPI_KEY ou ODDS_PAPI_KEY no Netlify.",
        "Se quiser separar tenis, use TENNIS_ODDS_API_KEY.",
        "Confirme que sua conta OddsPapi libera mercados de tenis.",
      ],
    }, { status: 501 });
  }

  if (!refresh) {
    const cached = await readCachedReport(date);
    if (cached) {
      return json({
        ...cached,
        source: {
          ...cached.source,
          cached: true,
        },
      });
    }
  }

  try {
    const report = await computeReport(date, stake, maxSelections);
    await saveReport(report);
    return json(report);
  } catch (error: any) {
    const friendly = friendlyErrorPayload(error, "Nao consegui gerar os palpites de Tenis");
    return json({
      ...friendly.body,
      setup: [
        "Confira se ODDSPAPI_KEY ou ODDS_PAPI_KEY esta configurada no Netlify.",
        "Confirme que o plano da OddsPapi libera mercados de tenis.",
        "Tente novamente mais tarde se a OddsPapi estiver limitando chamadas.",
      ],
    }, { status: friendly.status === 500 ? 502 : friendly.status });
  }
};

export const config = {
  path: "/api/daily-tennis-picks",
  method: ["GET", "POST"],
};
