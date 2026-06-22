import OpenAI from "openai";
import { fetchWithTimeout, friendlyErrorPayload } from "./_shared/http.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_MODEL = "gpt-4o-mini";

type ManualRequest = {
  text?: string;
  date?: string;
  riskProfile?: string;
  stake?: number;
  maxSelections?: number;
  markets?: string[] | string;
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

type Selection = {
  game: string;
  market: string;
  selection: string;
  odd: number | null;
  note?: string;
  impliedProbability?: number | null;
  fixtureId?: number;
  apiGame?: string;
  apiLeague?: string;
  apiContext?: Record<string, unknown>;
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

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isBetanoBookmaker(name?: string) {
  return normalizeText(String(name || "")).includes("betano");
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

function hasDifficultLine(value: string) {
  return /(^|[^\d])\d+[,.](25|75)([^\d]|$)/.test(String(value || ""));
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

function parseOdd(value: string) {
  const matches = value.match(/\b\d+(?:[,.]\d{1,2})\b/g) || [];
  const odds = matches
    .map((item) => Number.parseFloat(item.replace(",", ".")))
    .filter((odd) => odd > 1 && odd < 50);
  return odds.length ? odds[odds.length - 1] : null;
}

function parseSelections(text: string): Selection[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+\|\s+|\s+—\s+|\s+-\s+/).map((part) => part.trim()).filter(Boolean);
      const odd = parseOdd(line);
      const cleanOdd = odd ? new RegExp("\\b" + String(odd).replace(".", "[,.]") + "\\b") : null;
      const cleaned = parts.map((part) => cleanOdd ? part.replace(cleanOdd, "").trim() : part).filter(Boolean);
      const game = cleaned[0] || line;
      const market = cleaned[1] || "Mercado informado no texto";
      const selection = cleaned[2] || market;
      const note = cleaned.slice(3).join(" | ");

      const category = marketCategory(market, selection);
      if (category === "outros" || hasDifficultLine(`${market} ${selection}`)) return null;

      return {
        game,
        market,
        selection,
        odd,
        note,
        impliedProbability: odd ? Number((100 / odd).toFixed(2)) : null,
      };
    })
    .filter(Boolean) as Selection[];
}

function fixtureName(fixture: any) {
  return `${fixture.teams?.home?.name} x ${fixture.teams?.away?.name}`;
}

function splitGameSides(value: string) {
  const parts = normalizeText(value)
    .split(/\s+x\s+|\s+vs\s+|\s+v\s+|\s+contra\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join(" ")] : null;
}

function teamMatchScore(requestedTeam: string, actualTeam: string) {
  const requested = normalizeText(requestedTeam);
  const actual = normalizeText(actualTeam);
  if (!requested || !actual) return 0;
  if (requested === actual) return 8;
  if (actual.includes(requested) || requested.includes(actual)) return 5;
  const requestedTokens = requested.split(" ").filter((token) => token.length > 2);
  const actualTokens = new Set(actual.split(" ").filter((token) => token.length > 2));
  return requestedTokens.reduce((score, token) => score + (actualTokens.has(token) ? 2 : 0), 0);
}

function matchFixture(requested: string, fixtures: any[]) {
  const sides = splitGameSides(requested);
  if (!sides) return null;
  let best: { fixture: any; score: number } | null = null;

  for (const fixture of fixtures) {
    const direct = teamMatchScore(sides[0], fixture.teams?.home?.name || "") + teamMatchScore(sides[1], fixture.teams?.away?.name || "");
    const reverse = teamMatchScore(sides[1], fixture.teams?.home?.name || "") + teamMatchScore(sides[0], fixture.teams?.away?.name || "");
    const score = Math.max(direct, reverse);
    if (!best || score > best.score) best = { fixture, score };
  }

  return best && best.score >= 6 ? best.fixture : null;
}

async function apiFootball(path: string, params: Record<string, string | number | undefined>) {
  const key = getEnv("API_FOOTBALL_KEY");
  if (!key) return [];
  const url = new URL(path, API_FOOTBALL_BASE);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  });
  const response = await fetchWithTimeout(url, {
    headers: { "x-apisports-key": key },
  }, 8000, "API-Football");
  if (!response.ok) return [];
  const data = await response.json();
  return data.response || [];
}

async function fetchFixtureContext(fixture: any) {
  const homeId = fixture.teams?.home?.id;
  const awayId = fixture.teams?.away?.id;
  const fixtureId = fixture.fixture?.id;
  const safe = async (path: string, params: Record<string, string | number | undefined>) => {
    try { return await apiFootball(path, params); } catch { return []; }
  };
  const [homeRecent, awayRecent, h2h, injuries, lineups, odds] = await Promise.all([
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
      league: fixture.league?.name,
      country: fixture.league?.country,
      startsAt: fixture.fixture?.date,
      status: fixture.fixture?.status,
    },
    recentForm: {
      homeLastFixtures: summarizeFixtures(homeRecent),
      awayLastFixtures: summarizeFixtures(awayRecent),
    },
    h2h: summarizeFixtures(h2h),
    injuries: summarizeInjuries(injuries),
    lineups: summarizeLineups(lineups),
    apiOddsSample: summarizeOdds(odds),
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

async function enrichSelections(selections: Selection[], date: string) {
  const fixtures = await apiFootball("/fixtures", { date, timezone: DEFAULT_TIMEZONE });
  const preliminary = selections.map((selection) => {
    const fixture = matchFixture(selection.game, fixtures);
    return {
      ...selection,
      fixtureId: fixture?.fixture?.id,
      apiGame: fixture ? fixtureName(fixture) : undefined,
      apiLeague: fixture?.league?.name,
    };
  });
  const uniqueFixtures = new Map<number, any>();
  for (const selection of preliminary) {
    if (!selection.fixtureId) continue;
    const fixture = fixtures.find((item: any) => item.fixture?.id === selection.fixtureId);
    if (fixture) uniqueFixtures.set(selection.fixtureId, fixture);
  }
  const contexts = await Promise.all(Array.from(uniqueFixtures.values()).slice(0, 8).map(async (fixture) => {
    return [fixture.fixture.id, await fetchFixtureContext(fixture)] as const;
  }));
  const contextById = new Map(contexts);
  return preliminary.map((selection) => ({
    ...selection,
    apiContext: selection.fixtureId ? contextById.get(selection.fixtureId) : undefined,
  }));
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

function buildTicket(selections: Selection[], target: number, maxSelections: number, stake: number) {
  const chosen = selections
    .filter((selection) => selection.odd)
    .slice()
    .sort((a, b) => Math.abs((a.odd || 1) - target) - Math.abs((b.odd || 1) - target))
    .reduce<Selection[]>((acc, selection) => {
      if (acc.length >= maxSelections) return acc;
      const fixtureKey = selectionFixtureKey(selection);
      if (fixtureKey && acc.some((item) => selectionFixtureKey(item) === fixtureKey)) return acc;
      acc.push(selection);
      return acc;
    }, []);
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

function fallbackAnalysis(selections: Selection[], stake: number, maxSelections: number, requestedMarkets: MarketCategory[] = []) {
  return {
    summary: selections.length
      ? `Foram analisadas ${selections.length} selecoes${requestedMarkets.length ? " dentro dos mercados marcados" : ""} com odds informadas e dados recentes quando encontrados.`
      : "Nenhuma selecao ficou dentro dos mercados marcados. Ajuste os mercados ou envie novas selecoes.",
    gameByGame: selections.map((selection) => ({
      game: selection.apiGame || selection.game,
      market: selection.market,
      selection: selection.selection,
      odd: selection.odd,
      impliedProbability: selection.impliedProbability,
      reason: selection.apiContext ? "Jogo cruzado com API-Football e contexto recente disponivel." : "Jogo sem cruzamento na API; analise baseada no texto/odd informada.",
      risk: selection.odd && selection.odd >= 2.2 ? "alto" : "medio",
      picks: [selection],
    })),
    traps: selections
      .filter((selection) => !selection.odd || selection.odd < 1.2 || selection.odd > 2.8)
      .map((selection) => ({ game: selection.game, reason: "Odd fora da faixa ideal para bilhete principal." })),
    conservativeTicket: buildTicket(selections, 1.45, Math.min(3, maxSelections), stake),
    balancedTicket: buildTicket(selections, 1.75, Math.min(4, maxSelections), stake),
    boldTicket: buildTicket(selections, 2.1, maxSelections, stake),
    mainRecommendation: selections.length ? buildTicket(selections, 1.75, Math.min(4, maxSelections), stake) : { selections: [] },
  };
}

async function aiAnalysis(payload: unknown, stake: number, maxSelections: number) {
  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: getEnv("OPENAI_MODEL") || DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Voce recebe selecoes digitadas pelo usuario e dados recentes da API-Football.",
          "Use odds e mercados informados pelo usuario como fonte principal.",
          "Se requestedMarkets vier preenchido, use somente selecoes dessas categorias.",
          "Use apiContext para forma recente, h2h, lesoes, lineups e amostra de odds.",
          "Nao invente dado ausente.",
          "Devolva JSON valido com summary, gameByGame, traps, conservativeTicket, balancedTicket, boldTicket, mainRecommendation.",
          "Cada ticket deve ter selections, totalOdd e possibleReturn.",
          "Cada selecao deve preservar apiGame/game, market, selection, odd, fixtureId e impliedProbability das selecoes recebidas.",
          "Nunca use nomes genericos como Jogo, Match ou Fixture; use sempre o nome real dos times ou apiGame.",
          "Nunca use requestedMarkets como texto de market; market deve vir da selecao original.",
          "Nunca coloque duas selecoes do mesmo jogo no mesmo bilhete. Em escanteios, cartoes, gols ou chutes, escolha uma linha por jogo.",
          `Stake=${stake}; maxSelections=${maxSelections}.`
        ].join(" "),
      },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });
  return JSON.parse(completion.choices[0]?.message?.content || "{}");
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
  if (req.method !== "POST") return json({ error: "Use POST" }, { status: 405 });

  let body: ManualRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON invalido" }, { status: 400 });
  }

  const text = (body.text || "").trim();
  const date = body.date || new Date().toISOString().slice(0, 10);
  const stake = Number(body.stake || 5);
  const maxSelections = Math.max(1, Math.min(8, Number(body.maxSelections || 4)));
  const riskProfile = body.riskProfile || "moderado";
  const requestedMarkets = requestedMarketCategories(body.markets);

  if (!text) return json({ error: "Informe selecoes para analisar" }, { status: 400 });

  const selections = parseSelections(text);
  let allEnriched;
  try {
    allEnriched = await enrichSelections(selections, date);
  } catch (error: any) {
    const friendly = friendlyErrorPayload(error, "API-Football falhou ao cruzar os jogos do bilhete");
    return json({
      ...friendly.body,
      setup: [
        "O texto do bilhete foi recebido, mas a busca esportiva falhou.",
        "Confira quota/permissao da API_FOOTBALL_KEY no provedor.",
        "Tente novamente em alguns minutos se a API estiver limitando requisicoes.",
      ],
    }, { status: friendly.status === 500 ? 502 : friendly.status });
  }
  const enriched = applyMarketFilter(allEnriched, requestedMarkets);
  const payload = {
    generatedAt: new Date().toISOString(),
    date,
    riskProfile,
    stake,
    maxSelections,
    requestedMarkets,
    selections: enriched,
    providerNotes: {
      userOdds: "Odds e mercados informados pelo usuario.",
      apiFootball: getEnv("API_FOOTBALL_KEY") ? "Cruzamento por fixtures do dia e contexto recente." : "API_FOOTBALL_KEY ausente.",
    },
  };

  let analysis;
  try {
    analysis = getEnv("OPENAI_BASE_URL") || getEnv("OPENAI_API_KEY")
      ? await aiAnalysis(payload, stake, maxSelections)
      : fallbackAnalysis(enriched, stake, maxSelections, requestedMarkets);
  } catch {
    analysis = fallbackAnalysis(enriched, stake, maxSelections, requestedMarkets);
  }
  analysis = normalizeAnalysisShape(analysis, stake, enriched, maxSelections);

  return json({
    source: {
      provider: "Texto manual Betano + API-Football",
      date,
      timezone: DEFAULT_TIMEZONE,
      matched: enriched.filter((selection) => selection.fixtureId).length,
      unmatchedGames: enriched.filter((selection) => !selection.fixtureId).map((selection) => selection.game),
      picksFound: enriched.length,
      requestedMarkets,
      marketFilterApplied: requestedMarkets.length > 0,
      filteredOut: Math.max(allEnriched.length - enriched.length, 0),
    },
    analysis,
    extracted: enriched,
  });
};

export const config = {
  path: "/api/analyze-ticket",
  method: ["POST"],
};
