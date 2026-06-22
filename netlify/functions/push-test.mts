import { sendPushToAll } from "./_shared/push.mts";

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

  const result = await sendPushToAll({
    title: "Sete PRO",
    body: "Alertas ativados. Quando houver fechamento salvo, voce pode receber aviso aqui.",
    tag: "sete-pro-teste",
    url: "/?acao=acertos",
  });

  return json({ ok: true, ...result });
};

export const config = {
  path: "/api/push-test",
  method: ["POST"],
};
