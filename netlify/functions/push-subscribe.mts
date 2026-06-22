import { deletePushSubscription, savePushSubscription } from "./_shared/push.mts";

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export default async (req: Request) => {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return json({ error: "Metodo nao permitido" }, { status: 405 });
  }

  try {
    const body = await req.json();
    const subscription = body?.subscription || body;

    if (req.method === "DELETE") {
      await deletePushSubscription(subscription);
      return json({ ok: true, removed: true });
    }

    const id = await savePushSubscription(subscription);
    return json({ ok: true, id });
  } catch (error: any) {
    return json({
      error: "Nao consegui salvar a inscricao de notificacao.",
      detail: error?.message || "Erro desconhecido.",
    }, { status: 400 });
  }
};

export const config = {
  path: "/api/push-subscribe",
  method: ["POST", "DELETE"],
};
