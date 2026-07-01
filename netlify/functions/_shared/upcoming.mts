const DEFAULT_START_BUFFER_MS = 5 * 60 * 1000;

function normalizeText(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function entityId(value: any) {
  return String(
    value?.fixtureId ||
    value?.fixture_id ||
    value?.fixture?.id ||
    value?.eventId ||
    value?.event_id ||
    value?.id ||
    ""
  );
}

function entityGame(value: any) {
  if (value?.game) return normalizeText(value.game);
  if (value?.apiGame) return normalizeText(value.apiGame);
  if (value?.name) return normalizeText(value.name);

  const home = value?.teams?.home?.name || value?.homeTeam || value?.home;
  const away = value?.teams?.away?.name || value?.awayTeam || value?.away;
  return home && away ? normalizeText(`${home} x ${away}`) : "";
}

function entityStartsAt(value: any) {
  return String(
    value?.startsAt ||
    value?.apiStartsAt ||
    value?.startTime ||
    value?.start ||
    value?.fixture?.date ||
    value?.date ||
    ""
  );
}

export function isUpcomingStart(
  value: unknown,
  now = Date.now(),
  bufferMs = DEFAULT_START_BUFFER_MS
) {
  const startsAt = new Date(String(value || "")).getTime();
  return Number.isFinite(startsAt) && startsAt > now + bufferMs;
}

function product(values: number[]) {
  return values.reduce((total, value) => total * value, 1);
}

function pruneTicket(ticket: any, isUpcoming: (selection: any) => boolean, defaultStake: number) {
  if (!ticket || typeof ticket !== "object") return ticket;
  const originalSelections = Array.isArray(ticket.selections) ? ticket.selections : [];
  const selections = originalSelections.filter(isUpcoming);
  if (!originalSelections.length) return ticket;
  if (!selections.length) return { ...ticket, selections: [] };

  const originalOdd = Number(ticket.totalOdd || 0);
  const originalReturn = Number(ticket.possibleReturn || 0);
  const inferredStake = originalOdd > 1 && originalReturn > 0
    ? originalReturn / originalOdd
    : defaultStake;
  const totalOdd = product(selections.map((selection: any) => Number(selection.odd || 1)));

  return {
    ...ticket,
    selections,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * inferredStake).toFixed(2)),
  };
}

export function pruneUpcomingReport<T>(report: T, defaultStake = 5, now = Date.now()): T {
  if (!report || typeof report !== "object") return report;
  const copy: any = structuredClone(report);
  const fixtures = Array.isArray(copy?.raw?.fixtures) ? copy.raw.fixtures : [];
  const startById = new Map<string, string>();
  const startByGame = new Map<string, string>();

  for (const fixture of fixtures) {
    const startsAt = entityStartsAt(fixture);
    const id = entityId(fixture);
    const game = entityGame(fixture);
    if (id && startsAt) startById.set(id, startsAt);
    if (game && startsAt) startByGame.set(game, startsAt);
  }

  const startsAtFor = (value: any) => {
    const direct = entityStartsAt(value);
    if (direct) return direct;
    const id = entityId(value);
    if (id && startById.has(id)) return startById.get(id) || "";
    const game = entityGame(value);
    return game ? startByGame.get(game) || "" : "";
  };
  const isUpcoming = (value: any) => {
    const startsAt = startsAtFor(value);
    return !startsAt || isUpcomingStart(startsAt, now);
  };

  const originalPicks = Array.isArray(copy?.raw?.picks) ? copy.raw.picks : [];
  const upcomingPicks = originalPicks.filter(isUpcoming);
  if (copy.raw) {
    copy.raw.picks = upcomingPicks;
    copy.raw.fixtures = fixtures.filter(isUpcoming);
  }

  if (copy.analysis && typeof copy.analysis === "object") {
    for (const key of [
      "conservativeTicket",
      "balancedTicket",
      "boldTicket",
      "recommendedTicket",
      "mainRecommendation",
    ]) {
      if (copy.analysis[key]) {
        copy.analysis[key] = pruneTicket(copy.analysis[key], isUpcoming, defaultStake);
      }
    }
    if (Array.isArray(copy.analysis.gameByGame)) {
      copy.analysis.gameByGame = copy.analysis.gameByGame.filter(isUpcoming);
    }
  }

  if (copy.source && typeof copy.source === "object") {
    copy.source.picksFound = upcomingPicks.length;
    copy.source.gamesAnalyzed = new Set(upcomingPicks.map((pick: any) => entityId(pick) || entityGame(pick))).size;
    copy.source.matched = copy.source.gamesAnalyzed;
    copy.source.prunedPastSelections = Math.max(0, originalPicks.length - upcomingPicks.length);

    if (copy.source.prunedPastSelections > 0 && typeof copy?.analysis?.summary === "string") {
      copy.analysis.summary = copy.analysis.summary.replace(
        /\b\d+\s+jogos\b/i,
        `${copy.source.gamesAnalyzed} ${copy.source.gamesAnalyzed === 1 ? "jogo" : "jogos"}`
      );
      copy.analysis.summary += ` Removi ${copy.source.prunedPastSelections} ${copy.source.prunedPastSelections === 1 ? "mercado" : "mercados"} de partidas que ja comecaram.`;
    }
  }

  return copy as T;
}
