export class FriendlyError extends Error {
  code: string;
  status: number;
  detail?: string;

  constructor(code: string, message: string, status = 500, detail?: string) {
    super(message);
    this.name = "FriendlyError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function isFriendlyError(error: unknown): error is FriendlyError {
  return error instanceof FriendlyError || Boolean(error && typeof error === "object" && "code" in error && "status" in error);
}

export function missingConfig(key: string, service = "Servico") {
  return new FriendlyError(
    "misconfigured",
    `${service} temporariamente indisponivel.`,
    503,
    `Configuracao incompleta: ${key} nao encontrada.`
  );
}

export function timeoutError(service = "Servico externo") {
  return new FriendlyError(
    "timeout",
    `${service} demorou demais para responder. Tente novamente em alguns segundos.`,
    504
  );
}

export function externalServiceError(service: string, detail: string, status = 502) {
  if (status === 429) {
    return new FriendlyError(
      "rate_limited",
      `${service} atingiu limite de uso. Tente novamente mais tarde.`,
      status,
      detail
    );
  }

  return new FriendlyError(
    "external_service_error",
    `${service} nao respondeu como esperado. Tente novamente em alguns instantes.`,
    status,
    detail
  );
}

export async function fetchWithTimeout(input: string | URL | Request, init: RequestInit = {}, timeoutMs = 8000, service = "Servico externo") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: init.signal || controller.signal,
    });
  } catch (error: any) {
    if (error && error.name === "AbortError") {
      throw timeoutError(service);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function friendlyErrorPayload(error: unknown, fallbackMessage = "Erro inesperado. Tente novamente.") {
  if (isFriendlyError(error)) {
    return {
      status: Number((error as any).status || 500),
      body: {
        error: (error as any).code || "error",
        message: (error as any).message || fallbackMessage,
        detail: (error as any).detail || undefined,
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error || "");
  if (/abort|timeout|timed out|demorou/i.test(message)) {
    return {
      status: 504,
      body: {
        error: "timeout",
        message: "Servidor demorou demais. Tente novamente em alguns segundos.",
        detail: message || undefined,
      },
    };
  }

  if (/missing_key|ausente|api[_ -]?key|configura/i.test(message)) {
    return {
      status: 503,
      body: {
        error: "misconfigured",
        message: "Servico temporariamente indisponivel.",
        detail: message || undefined,
      },
    };
  }

  if (/quota|rate limit|too many|limit/i.test(message)) {
    return {
      status: 429,
      body: {
        error: "rate_limited",
        message: "Limite do provedor atingido. Tente novamente mais tarde.",
        detail: message || undefined,
      },
    };
  }

  if (/not found|nenhum|sem dados|no data|empty|vazio/i.test(message)) {
    return {
      status: 404,
      body: {
        error: "no_data",
        message: "Nao encontrei dados suficientes para essa consulta.",
        detail: message || undefined,
      },
    };
  }

  return {
    status: 500,
    body: {
      error: "unexpected",
      message: fallbackMessage,
      detail: message || undefined,
    },
  };
}
