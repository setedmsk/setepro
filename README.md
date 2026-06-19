# Tipster PRO

Painel web para analisar jogos, ler prints de bilhetes e gerar palpites sob demanda com Netlify Functions.

## O que tem no app

- Analise manual de jogos digitados.
- Leitura de prints da casa de aposta com IA.
- Palpites sob demanda para futebol, basquete, volei e e-sports.
- Filtros de Brasileirao: Serie A, A+B+C e Serie B/C.
- Backend em Netlify Functions com chaves protegidas por variaveis de ambiente.
- Cache por data, botao e mercados para reduzir consumo de API.

## Stack

- Frontend estatico em `index.html`.
- Netlify Functions em `netlify/functions`.
- Netlify Blobs para cache de relatorios/palpites.
- API-Football/API-Sports para jogos e odds.
- OpenAI para leitura/análise de prints.
- OddsPapi para e-sports.

## Estrutura

```text
.
├── index.html
├── netlify.toml
├── package.json
├── package-lock.json
├── .env.example
└── netlify/
    └── functions/
        ├── analyze-games.mts
        ├── analyze-screenshot.mts
        ├── analyze-ticket.mts
        ├── daily-picks.mts
        ├── daily-basketball-picks.mts
        ├── daily-volleyball-picks.mts
        ├── daily-esports-picks.mts
        └── health.mts
```

## Variaveis de ambiente

Configure no Netlify em **Site configuration > Environment variables**.

Obrigatorias para o fluxo principal:

- `API_FOOTBALL_KEY`
- `OPENAI_API_KEY` ou `OPENAI_BASE_URL`

Opcionais por esporte/recurso:

- `API_BASKETBALL_KEY`
- `API_VOLLEYBALL_KEY`
- `API_SPORTS_KEY`
- `ODDSPAPI_KEY` ou `ODDS_PAPI_KEY`
- `OPENAI_MODEL`
- `OPENAI_VISION_MODEL`
- `DAILY_PICKS_AI=1`

Use `.env.example` como referencia. Nunca commite chaves reais.

## Comandos

```bash
npm install
npm run check
npx netlify build
npx netlify dev
```

## Deploy

O projeto esta preparado para Netlify.

- Publish directory: `.`
- Functions directory: `netlify/functions`
- Config: `netlify.toml`

Para publicar manualmente:

```bash
npx netlify deploy
npx netlify deploy --prod
```

## Endpoints

- `GET /api/health`
- `POST /api/analyze-games`
- `POST /api/analyze-screenshot`
- `POST /api/analyze-ticket`
- `GET|POST /api/daily-picks`
- `GET|POST /api/daily-basketball-picks`
- `GET|POST /api/daily-volleyball-picks`
- `GET|POST /api/daily-esports-picks`

## Observacoes

- O app foi ajustado para nao rodar relatorio pesado automaticamente as 07h.
- Palpites de futebol sao gerados somente sob demanda, quando o usuario clica nos botoes.
- Arquivos pessoais e artefatos locais ficam fora do Git por `.gitignore`.
