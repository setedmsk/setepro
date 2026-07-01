import { sendPushToSubscription } from "./_shared/push.mts";

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
  if (req.method !== "POST") {
    return json({ error: "Metodo nao permitido" }, { status: 405 });
  }

  try {
    const body = await req.json();
    const subscription = body?.subscription || body;
    const result = await sendPushToSubscription(subscription, {
      title: "Sete PRO",
      body: "Alertas ativados. Quando houver fechamento salvo, voce pode receber aviso aqui.",
      tag: "sete-pro-teste",
      url: "/?acao=acertos",
    });

    return json({ ok: true, ...result });
  } catch (error: any) {
    return json({
      error: "Nao consegui enviar o teste de notificacao.",
      detail: error?.message || "Inscricao invalida.",
    }, { status: 400 });
  }
};

export const config = {
  path: "/api/push-test",
  method: ["POST"],
};
