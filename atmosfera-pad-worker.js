/*  Atmosfera PAD · serviço de busca de tons (Cloudflare Worker + IA do Google)
 *  ---------------------------------------------------------------------------
 *  O app pergunta aqui "qual o tom de <música ou trecho da letra>?". Este serviço
 *  pergunta à IA do Google (Gemini, pela API oficial) e devolve as versões com o tom.
 *
 *  Dois modos (o app usa os dois):
 *   ?q=...              IA responde do que já sabe (rápido, grátis, pode ser guardado em cache)
 *   ?q=...&conferir=1   IA pesquisa no Google na hora e confere o tom nas cifras (Cifra Club etc.), em duas etapas:
 *                       1) pesquisa e relatório em texto; 2) um modelo rápido converte o relatório em JSON.
 *                       Pelos termos do Google, esse resultado é mostrado só a quem perguntou, não é
 *                       guardado em cache, e vem com as "Sugestões de pesquisa" que o app exibe.
 *
 *  Publicar (uma vez, no computador):
 *   1. dash.cloudflare.com → Workers & Pages → abra o worker (ou Create Worker) → Edit code →
 *      apague tudo, cole este arquivo → Deploy.
 *   2. Chave da IA: aistudio.google.com → Get API key → Create API key (gratuita).
 *      No worker: Settings → Variables and Secrets → Add → tipo Secret → nome GEMINI_KEY → cole a chave → Deploy.
 *   3. Opcional, recomendado (cache compartilhado do modo rápido): Storage & Databases → KV → Create →
 *      nome "atmosfera pad"; no worker: Settings → Bindings → Add → KV namespace → variável TONS → Deploy.
 *   Variáveis opcionais (Settings → Variables): MODELOS, MODELOS_BUSCA (listas separadas por vírgula),
 *      MODO=conferir (todas as buscas já saem conferidas no Google).
 *
 *  Teste no navegador:  SEU_ENDERECO/?q=galileu
 *  Diagnóstico:         SEU_ENDERECO/?q=galileu&debug=1   (mostra modelo, tentativas e resposta crua)
 */

const LIMITE_POR_MINUTO = 20;          // buscas rápidas por IP por minuto
const LIMITE_CONFERIR_MINUTO = 6;      // conferências (pesquisa Google) por IP por minuto
const CACHE_SEGUNDOS = 30 * 24 * 3600; // cache do modo rápido (KV); o modo conferir nunca é guardado
const MAX_VERSOES = 6;
// Modelos, em ordem de preferência. Se um falhar (limite diário, indisponível no plano), tenta o seguinte.
const MODELOS_PADRAO = 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash';
// Pesquisa Google (modo conferir): só existe no plano pago do AI Studio (5.000 pesquisas/mês grátis, depois cobradas).
// Nos testes reais o Flash-Lite respondeu de memória, sem pesquisar, em todas as tentativas; o Flash (maior, ~20-30 s)
// pesquisou de fato. Por isso o maior vem primeiro; o lite fica de reserva para quando o maior estiver fora do ar.
const MODELOS_BUSCA_PADRAO = 'gemini-3.8-flash,gemini-3.5-flash-lite';
const MAX_TENTATIVAS_BUSCA = 2;        // respostas sem pesquisa toleradas antes de desistir de conferir
// Origens (sites) autorizadas. Sem Origin (teste direto no navegador) também passa.
const ORIGENS = [
  'https://sentinelapushoficial-prog.github.io'
  // acrescente aqui o domínio próprio do app quando existir, ex.: 'https://atmosfera.sentinelapush.com.br'
];

const memCache = new Map();
const hits = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ ok: false, error: 'só GET' }, 405, cors);
    if (origin && !origemOk(origin)) return json({ ok: false, error: 'origem não autorizada' }, 403, cors);
    if (url.pathname !== '/' && url.pathname !== '/tom') return json({ ok: false, error: 'use /?q=nome da música' }, 404, cors);

    const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim();
    const debug = url.searchParams.get('debug') === '1';
    const conferir = url.searchParams.get('conferir') === '1' || String(env && env.MODO || '').toLowerCase() === 'conferir';
    if (!q) return json({ ok: true, results: [], hint: 'use ?q=nome da música ou trecho da letra' }, 200, cors);
    if (q.length > 120) return json({ ok: false, error: 'texto muito longo' }, 400, cors);
    if (!env || !env.GEMINI_KEY) return json({ ok: false, code: 'sem-chave', error: 'o serviço ainda não tem a chave da IA (GEMINI_KEY) configurada' }, 503, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'x';
    if (!dentroDoLimite(ip, conferir ? 'c' : 'r', conferir ? LIMITE_CONFERIR_MINUTO : LIMITE_POR_MINUTO)) {
      return json({ ok: false, code: 'ritmo', error: 'muitas buscas em um minuto; espere um pouco' }, 429, cors);
    }
    try {
      const out = conferir ? await buscarConferindo(q, env, debug) : await buscarRapido(q, env, ctx, debug);
      return json(out, out.ok ? 200 : (out.status || 502), cors);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500, cors);
    }
  }
};

/* ---------- HTTP ---------- */
function origemOk(origin) { return ORIGENS.indexOf(origin) >= 0; }
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin && origemOk(origin) ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(obj, status, cors) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors);
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}
function dentroDoLimite(ip, tipo, limite) {
  const minuto = Math.floor(Date.now() / 60000);
  const k = tipo + ':' + ip + ':' + minuto;
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (hits.size > 5000) { for (const key of hits.keys()) { if (!key.endsWith(':' + minuto)) hits.delete(key); } }
  return n <= limite;
}

/* ---------- modo rápido: a IA responde do que sabe; resultado pode ser guardado ---------- */
async function buscarRapido(q, env, ctx, debug) {
  const chave = 'ia:2:' + normaliza(q);
  if (!debug) {
    const m = memCache.get(chave);
    if (m && Date.now() - m.ts < CACHE_SEGUNDOS * 1000) return Object.assign({}, m.out, { cached: true });
    if (env.TONS) { try { const kv = await env.TONS.get(chave, 'json'); if (kv) { memCache.set(chave, { ts: Date.now(), out: kv }); return Object.assign({}, kv, { cached: true }); } } catch (e) {} }
  }
  const log = [];
  const r = await perguntar(env, listaModelos(env.MODELOS, MODELOS_PADRAO), promptRapido(q), { schema: true }, log);
  if (!r.ok) return Object.assign({ ok: false, q, modo: 'ia' }, r, debug ? { log } : {});
  const results = extrairMusicas(r.texto).slice(0, MAX_VERSOES).map(m => Object.assign(m, { src: 'IA' }));
  const out = { ok: true, q, modo: 'ia', grounded: false, model: r.model, results };
  if (debug) { out.log = log; out.bruto = r.texto; }
  else {
    memCache.set(chave, { ts: Date.now(), out });
    if (memCache.size > 3000) memCache.delete(memCache.keys().next().value);
    if (env.TONS && ctx) ctx.waitUntil(env.TONS.put(chave, JSON.stringify(out), { expirationTtl: CACHE_SEGUNDOS }).catch(() => {}));
  }
  return out;
}

/* ---------- modo conferir: a IA pesquisa no Google agora; nada é guardado ---------- */
async function buscarConferindo(q, env, debug) {
  const log = [];
  // Etapa 1 — pesquisar: a IA busca no Google e escreve um relatório em texto (sem JSON, que inibe a pesquisa
  // nos modelos pequenos). Fica com o primeiro modelo que realmente pesquisou (groundingMetadata presente).
  const modelos = listaModelos(env.MODELOS_BUSCA, MODELOS_BUSCA_PADRAO);
  let pesq = null, falha = null, tentativas = 0;
  for (const model of modelos) {
    if (tentativas >= MAX_TENTATIVAS_BUSCA) break;
    const t = await perguntar(env, [model], promptPesquisa(q), { busca: true }, log);
    if (!t.ok) { falha = t; continue; }
    tentativas++;
    const gm = t.grounding || {};
    const fontes = [];
    (gm.groundingChunks || []).forEach(c => { const ti = c && c.web && c.web.title; if (ti && fontes.indexOf(ti) < 0) fontes.push(ti); });
    const grounded = !!(gm.webSearchQueries && gm.webSearchQueries.length) || fontes.length > 0;
    if (!pesq || grounded) pesq = { texto: t.texto, model: t.model, gm, fontes, grounded };
    if (grounded) break;
  }
  if (!pesq) return Object.assign({ ok: false, q, modo: 'conferir' }, falha || { code: 'falha', error: 'nenhum modelo respondeu', status: 502 }, debug ? { log } : {});

  // Etapa 2 — estruturar: um modelo rápido converte o relatório em JSON (aqui o esquema JSON pode ser usado).
  let results = [];
  const semNada = /NADA ENCONTRADO/i.test(pesq.texto) && pesq.texto.length < 200;
  let estr = null;
  if (!semNada) {
    estr = await perguntar(env, listaModelos(env.MODELOS, MODELOS_PADRAO), promptEstruturar(q, pesq.texto, pesq.fontes), { schema: true }, log);
    results = extrairMusicas(estr.ok ? estr.texto : pesq.texto);
  }
  results = results.slice(0, MAX_VERSOES).map(m => {
    if (pesq.grounded) { if (!m.src || m.src === 'IA') m.src = pesq.fontes[0] || 'Google'; }
    else { m.src = 'IA'; if (m.c === 'alta') m.c = 'media'; }   // não pesquisou: é palpite, não conferido
    return m;
  });
  const out = { ok: true, q, modo: 'conferir', grounded: pesq.grounded, model: pesq.model, results, fontes: pesq.fontes,
    sugestoes: (pesq.gm.searchEntryPoint && pesq.gm.searchEntryPoint.renderedContent) || '',
    pesquisas: pesq.gm.webSearchQueries || [] };
  if (debug) { out.log = log; out.pesquisa = pesq.texto; out.bruto = estr && estr.ok ? estr.texto : ''; }
  return out;
}

/* ---------- a conversa com a IA ---------- */
function listaModelos(valor, padrao) { return String(valor || padrao).split(',').map(s => s.trim()).filter(Boolean); }

const INSTRUCOES = [
  'Você ajuda músicos de louvor a descobrir o TOM (tonalidade) de músicas.',
  'O usuário digita o nome da música, parte do nome, o artista ou um trecho da letra, muitas vezes sem acento ou com erro de digitação.',
  'Identifique a(s) música(s) correspondente(s) — foco em louvor/gospel brasileiro, mas aceite qualquer gênero — e liste até ' + MAX_VERSOES + ' gravações/versões conhecidas (artistas ou ministérios diferentes), cada uma com o tom em que foi gravada.',
  'O tom é o que aparece em "Tom:" na cifra do Cifra Club (o tom real que soa, não a forma dos acordes com capotraste).',
  'Formato do tom: letra A–G, opcional # ou b, e "m" para menor. Exemplos: D, F#m, Bb, C#m, Em.',
  '"confianca": alta só quando tem certeza do tom daquela versão; media quando lembra mas pode variar; baixa quando é palpite. Na dúvida, deixe tom null em vez de inventar.',
  '"trecho": até 8 palavras da letra que confirmam a identificação, ou null.',
  'Responda SOMENTE com JSON válido, sem markdown e sem texto fora do JSON, exatamente neste formato:',
  '{"musicas":[{"titulo":"Nome da Música","artista":"Artista","tom":"D","confianca":"alta","trecho":"palavras da letra","fonte":"cifraclub.com.br"}]}',
  'Se não reconhecer nenhuma música, responda {"musicas":[]}.'
].join('\n');

function promptRapido(q) { return INSTRUCOES + '\n\nBusca do usuário: "' + q.replace(/"/g, '\'') + '"'; }
function promptPesquisa(q) {
  const qq = q.replace(/"/g, '\'');
  return [
    'Pesquise no Google agora. Não responda de memória: só vale o que estiver nas páginas encontradas.',
    'Pergunta do músico: qual é o tom (tonalidade) da música "' + qq + '"? Isso pode ser o nome, parte do nome, o artista ou um trecho da letra, às vezes com erro de digitação; quase sempre é louvor/gospel brasileiro.',
    'Faça ao menos estas pesquisas: "' + qq + ' cifra" e "' + qq + ' cifra club tom". Se houver mais de uma gravação (artistas ou ministérios diferentes), pesquise o tom de cada uma, até ' + MAX_VERSOES + ' versões.',
    'Para cada versão encontrada escreva UMA linha, neste formato:',
    'Título | Artista | Tom: <o que aparece em "Tom:" na cifra, ex. D, F#m, Bb> | Site: <domínio da página> | Letra: <até 8 palavras da letra>',
    'O tom é o indicado na cifra (o tom real), não a forma dos acordes com capotraste. Se a página não mostrar o tom, escreva "Tom: ?".',
    'Se não encontrar a música nas páginas, escreva apenas: NADA ENCONTRADO.'
  ].join('\n');
}
function promptEstruturar(q, relatorio, fontes) {
  return [
    'Converta o relatório de pesquisa abaixo em JSON. Não acrescente músicas que não estejam no relatório e não altere os tons.',
    'Formato do tom: letra A–G, opcional # ou b, e "m" para menor (ex.: D, F#m, Bb). "Tom: ?" ou tom ausente → null.',
    '"confianca": "alta" quando o relatório traz o tom e o site da cifra; "media" quando traz o tom sem o site; "baixa" quando é dúvida.',
    '"fonte": o site informado na linha (ou null). "trecho": a letra informada na linha (ou null).',
    'Responda SOMENTE com JSON válido, sem markdown, exatamente neste formato:',
    '{"musicas":[{"titulo":"Nome da Música","artista":"Artista","tom":"D","confianca":"alta","trecho":"palavras da letra","fonte":"cifraclub.com.br"}]}',
    'Se o relatório disser NADA ENCONTRADO ou não tiver nenhuma música, responda {"musicas":[]}.',
    '',
    'Busca do usuário: "' + q.replace(/"/g, '\'') + '"',
    'Sites consultados na pesquisa: ' + (fontes && fontes.length ? fontes.join(', ') : '(nenhum)'),
    'Relatório:',
    '<<<',
    String(relatorio || '').slice(0, 6000),
    '>>>'
  ].join('\n');
}

const SCHEMA = {
  type: 'object',
  properties: {
    musicas: { type: 'array', items: {
      type: 'object',
      properties: {
        titulo: { type: 'string' }, artista: { type: 'string' },
        tom: { type: ['string', 'null'] }, confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
        trecho: { type: ['string', 'null'] }, fonte: { type: ['string', 'null'] }
      },
      required: ['titulo', 'artista', 'tom', 'confianca']
    } }
  },
  required: ['musicas']
};

/* Tenta os modelos em ordem. Devolve {ok, texto, model, grounding} ou {ok:false, code, error, status}. */
async function perguntar(env, modelos, prompt, opts, log) {
  let ultimo = null;
  for (const model of modelos) {
    const variantes = opts.schema ? [{ schema: true }, { schema: false }] : [{}];
    for (const v of variantes) {
      const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } };
      if (opts.busca) body.tools = [{ google_search: {} }];
      if (v.schema) { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseJsonSchema = SCHEMA; }
      const r = await chamarGemini(env.GEMINI_KEY, model, body, opts.busca ? 55000 : 25000);
      const gmk = r.status === 200 && opts.busca ? ' · metadata: ' + Object.keys(candidato(r.data).groundingMetadata || {}).join(',') : '';
      log.push(model + (v.schema ? ' (json)' : '') + (opts.busca ? ' (pesquisa)' : '') + ': HTTP ' + r.status + (r.erro ? ' · ' + r.erro.slice(0, 160) : '') + gmk);
      if (r.status === 200) {
        const texto = textoDe(r.data);
        if (!texto) { ultimo = { code: 'vazio', error: 'a IA não respondeu nada', status: 502 }; continue; }
        return { ok: true, texto, model, grounding: candidato(r.data).groundingMetadata || null };
      }
      ultimo = classificaErro(r);
      // 400 por causa do formato JSON: tenta o mesmo modelo sem o esquema; outros erros: próximo modelo
      if (r.status === 400 && v.schema && /json|schema|mime|controlled|structured/i.test(r.erro || '')) continue;
      break;
    }
  }
  return Object.assign({ ok: false }, ultimo || { code: 'falha', error: 'nenhum modelo respondeu', status: 502 });
}
function classificaErro(r) {
  const msg = r.erro || ('HTTP ' + r.status);
  if (r.status === 429) return { code: 'limite', error: 'limite diário da IA atingido; tente mais tarde (ou ative o plano pago no Google AI Studio)', status: 429, detalhe: msg };
  if (r.status === 401 || r.status === 403) return { code: 'chave', error: 'a chave da IA foi recusada pelo Google; confira GEMINI_KEY', status: 503, detalhe: msg };
  if (r.status === 404) return { code: 'modelo', error: 'modelo não encontrado; ajuste a variável MODELOS', status: 503, detalhe: msg };
  return { code: 'erro', error: 'a IA respondeu com erro: ' + msg.slice(0, 200), status: 502 };
}
async function chamarGemini(key, model, body, limiteMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), limiteMs || 25000);
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    const erro = r.status === 200 ? '' : ((data && data.error && (data.error.message || data.error.status)) || txt.slice(0, 200));
    return { status: r.status, data, erro };
  } catch (e) {
    return { status: 0, data: null, erro: e && e.name === 'AbortError' ? 'tempo esgotado' : String(e) };
  } finally { clearTimeout(timer); }
}
function candidato(data) { return (data && data.candidates && data.candidates[0]) || {}; }
function textoDe(data) {
  const parts = (candidato(data).content && candidato(data).content.parts) || [];
  return parts.filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text).join('\n').trim();
}

/* ---------- leitura da resposta ---------- */
function extrairMusicas(texto) {
  const obj = lerJson(texto);
  let lista = [];
  if (obj && Array.isArray(obj.musicas)) lista = obj.musicas;
  else if (Array.isArray(obj)) lista = obj;
  else if (obj && Array.isArray(obj.results)) lista = obj.results;
  const vistos = new Set(), out = [];
  for (const m of lista) {
    if (!m || typeof m !== 'object') continue;
    const t = limpa(m.titulo || m.t || m.title || m.nome || '');
    const a = limpa(m.artista || m.a || m.artist || '');
    if (!t) continue;
    const tomBruto = m.tom || m.k || m.key || '';
    const k = normalizaTom(tomBruto);
    const conf = String(m.confianca || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let c = /^(alta|media|baixa)$/.test(conf) ? conf : (k ? 'media' : 'baixa');
    if (!k) c = 'baixa';                                   // tom ausente ou ilegível: nunca "alta"
    const chave = (t + '|' + a).toLowerCase();
    if (vistos.has(chave)) continue; vistos.add(chave);
    const item = { t: t.slice(0, 60), a: a.slice(0, 60), k: k || null, c };
    const trecho = limpa(m.trecho || ''); if (trecho) item.trecho = trecho.slice(0, 80);
    const fonte = limpa(m.fonte || m.src || ''); if (fonte) item.src = fonte.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].slice(0, 40);
    out.push(item);
  }
  // com tom primeiro; dentro disso, maior confiança primeiro
  const peso = { alta: 0, media: 1, baixa: 2 };
  out.sort((x, y) => (x.k ? 0 : 1) - (y.k ? 0 : 1) || peso[x.c] - peso[y.c]);
  return out;
}
function lerJson(texto) {
  if (!texto) return null;
  let s = String(texto).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  // pega o primeiro objeto/array equilibrado dentro do texto
  const ini = Math.min(...['{', '['].map(ch => { const i = s.indexOf(ch); return i < 0 ? Infinity : i; }));
  if (!isFinite(ini)) return null;
  const abre = s[ini], fecha = abre === '{' ? '}' : ']';
  let prof = 0, emStr = false, esc = false;
  for (let i = ini; i < s.length; i++) {
    const ch = s[i];
    if (emStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') emStr = false; continue; }
    if (ch === '"') emStr = true;
    else if (ch === '{' || ch === '[') prof++;
    else if (ch === '}' || ch === ']') { prof--; if (prof === 0) { try { return JSON.parse(s.slice(ini, i + 1)); } catch (e) { return null; } } }
  }
  // JSON cortado no fim: tenta fechar
  try { return JSON.parse(s.slice(ini) + (abre === '{' ? '}]}' : ']')); } catch (e) {}
  return null;
}
function normalizaTom(txt) {
  let s = String(txt || '').trim();
  if (!s) return '';
  s = s.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/\s+/g, ' ');
  const nomes = { do: 'C', 'dó': 'C', re: 'D', 'ré': 'D', mi: 'E', fa: 'F', 'fá': 'F', sol: 'G', la: 'A', 'lá': 'A', si: 'B' };
  // nome da nota (Ré, Fá…) ou letra; acidente (#, b, sustenido, bemol); modo (m, menor, minor, maior, major)
  const m = s.match(/^(d[oó]|r[eé]|mi|f[aá]|sol|l[aá]|si|[A-Ga-g])\s*(#|b(?![a-ln-z])|bemol|sustenido)?\s*(menor|minor|min(?![a-z])|maior|major|m(?![a-z]))?/i);
  if (!m) return '';
  // o que sobra depois do tom só pode ser extensão de acorde ("maj7", "7", "/F#") ou pontuação; "Dança" não é um tom
  const resto = s.slice(m[0].length);
  if (resto && !/^(\s|\d|[\/()+°º,.;:\-]|maj|sus|add|dim|aug)/i.test(resto)) return '';
  const nome = m[1].toLowerCase();
  const letra = nome.length === 1 ? nome.toUpperCase() : nomes[nome];
  if (!letra) return '';
  const ac = (m[2] || '').toLowerCase();
  const acid = ac === '#' || ac === 'sustenido' ? '#' : (ac ? 'b' : '');
  const modo = (m[3] || '').toLowerCase();
  const menor = modo === 'm' || modo === 'menor' || modo === 'minor' || modo === 'min';
  return letra + acid + (menor ? 'm' : '');
}
function limpa(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function normaliza(s) { return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
