import { getStore } from "@netlify/blobs";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const DEFAULT_TIMEZONE = "America/Sao_Paulo";

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

async function readLatestDailyReport() {
  try {
    const store = getStore({ name: "daily-picks", consistency: "strong" });
    return await store.get("latest.json", { type: "json" }) as any;
  } catch {
    return null;
  }
}

async function readLatestDailyError() {
  try {
    const store = getStore({ name: "daily-picks", consistency: "strong" });
    return await store.get("latest-error.json", { type: "json" }) as any;
  } catch {
    return null;
  }
}

export default async () => {
  const latest = await readLatestDailyReport();
  const latestError = await readLatestDailyError();
  const apiFootballConfigured = Boolean(getEnv("API_FOOTBALL_KEY"));
  const oddsPapiConfigured = Boolean(getEnv("ODDSPAPI_KEY") || getEnv("ODDS_PAPI_KEY") || getEnv("ESPORTS_ODDS_API_KEY"));
  const openAiConfigured = Boolean(getEnv("OPENAI_BASE_URL") || getEnv("OPENAI_API_KEY"));
  const visionConfigured = openAiConfigured;
  const latestPicks = Number(latest?.source?.picksFound || 0);
  const hasUsableDailyReport = latestPicks > 0;
  const ok = apiFootballConfigured && openAiConfigured;

  return json({
    status: ok ? "ok" : "degraded",
    generatedAt: new Date().toISOString(),
    timezone: DEFAULT_TIMEZONE,
    checks: {
      backend: {
        ok: true,
        detail: "Netlify Functions publicadas.",
      },
      apiFootball: {
        ok: apiFootballConfigured,
        detail: apiFootballConfigured
          ? "API_FOOTBALL_KEY configurada. Quota/plano sao validados na chamada real."
          : "API_FOOTBALL_KEY ausente.",
      },
      visionAi: {
        ok: visionConfigured,
        detail: visionConfigured
          ? "IA configurada para leitura de print."
          : "OPENAI_API_KEY ou Netlify AI Gateway ausente.",
      },
      esportsOdds: {
        ok: oddsPapiConfigured,
        optional: true,
        detail: oddsPapiConfigured
          ? "OddsPapi configurada para palpites de e-sports com casas disponiveis."
          : "ODDSPAPI_KEY ou ODDS_PAPI_KEY ausente. Necessaria somente para palpites de e-sports.",
      },
      dailyReport: {
        ok: true,
        schedule: "Sob demanda",
        cronUtc: null,
        detail: hasUsableDailyReport
          ? "Relatorio pesado das 07h desativado; palpites sao gerados somente ao clicar nos botoes."
          : "Relatorio pesado das 07h desativado para economizar API. Use os botoes para gerar sob demanda.",
        latest: hasUsableDailyReport ? {
          date: latest.source?.date,
          generatedAt: latest.source?.generatedAt,
          gamesAnalyzed: latest.source?.gamesAnalyzed,
          picksFound: latest.source?.picksFound,
        } : null,
        latestIgnored: latest && !hasUsableDailyReport ? {
          date: latest.source?.date,
          generatedAt: latest.source?.generatedAt,
          reason: "Cache antigo sem picks foi ignorado pelo modo de palpites.",
        } : null,
        latestError: latestError ? {
          date: latestError.date,
          generatedAt: latestError.generatedAt,
          message: latestError.message,
        } : null,
      },
    },
  });
};

export const config = {
  path: "/api/health",
  method: ["GET"],
};
