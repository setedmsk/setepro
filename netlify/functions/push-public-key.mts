import { pushConfig } from "./_shared/push.mts";

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export default async () => {
  const config = pushConfig();
  return json({
    configured: config.configured,
    publicKey: config.publicKey || "",
  });
};

export const config = {
  path: "/api/push-public-key",
  method: ["GET"],
};
