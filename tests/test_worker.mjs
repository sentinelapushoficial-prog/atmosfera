// Testa o Worker sem internet: simula as respostas do Google.
import worker from '../atmosfera-pad-worker.js';

const calls = [];
let semGrounding = false; let plano = 'pago'; // 'pago' | 'gratis' (3.x com pesquisa dá 429) | 'semchave'
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
  const busca = !!body.tools; const schema = !!body.generationConfig.responseJsonSchema;
  calls.push({ model, busca, schema });
  const q = (body.contents[0].parts[0].text.match(/Busca do usuário: "([^"]*)"/) || [])[1] || '';
  const resp = (status, obj) => new Response(JSON.stringify(obj), { status });
  if (init.headers['x-goog-api-key'] !== 'KEY') return resp(403, { error: { message: 'API key not valid', status: 'PERMISSION_DENIED' } });
  if (busca && plano === 'gratis' && model.startsWith('gemini-3')) return resp(429, { error: { message: 'Grounding with Google Search is not available on the free tier', status: 'RESOURCE_EXHAUSTED' } });
  if (busca && schema) return resp(400, { error: { message: 'Controlled generation is not supported with google_search tool' } });
  if (schema && model === 'gemini-2.5-flash-lite' && q.includes('semesquema')) return resp(400, { error: { message: 'Invalid JSON schema' } });
  if (q.includes('quota')) return resp(429, { error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
  if (q.includes('nada')) return resp(200, { candidates: [{ content: { parts: [{ text: '{"musicas":[]}' }] } }] });
  const relatorio = body.contents[0].parts[0].text.indexOf('Relatório:') >= 0;
  if (relatorio) {
    calls[calls.length - 1].etapa2 = true;
    const txt = (body.contents[0].parts[0].text.split('<<<')[1] || '');   // só o relatório
    if (/NADA ENCONTRADO/.test(txt)) return resp(200, { candidates: [{ content: { parts: [{ text: '{"musicas":[]}' }] } }] });
    const lista = [];
    if (/Fernandinho/.test(txt)) lista.push({ titulo: 'Dançar na Chuva', artista: 'Fernandinho', tom: 'Ré maior', confianca: 'alta', trecho: 'eu vou dançar na chuva', fonte: 'https://www.cifraclub.com.br/fernandinho/dancar-na-chuva/' });
    if (/Banda VIP/.test(txt)) lista.push({ titulo: 'Dançar na Chuva', artista: 'Banda VIP', tom: null, confianca: 'baixa' });
    if (/\| Y \|/.test(txt)) lista.push({ titulo: 'X', artista: 'Y', tom: 'D', confianca: 'alta' });
    return resp(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ musicas: lista }) }] } }] });
  }
  if (busca && semGrounding) return resp(200, { candidates: [{ content: { parts: [{ text: 'X | Y | Tom: D | Site: cifraclub.com.br | Letra: la la' }] } }] });
  if (busca) {
    const texto = 'Encontrei:\nDançar na Chuva | Fernandinho | Tom: D | Site: cifraclub.com.br | Letra: eu vou dançar na chuva\nDançar na Chuva | Banda VIP | Tom: ? | Site: cifraclub.com.br | Letra: eu vou dançar na chuva';
    return resp(200, { candidates: [{ content: { parts: [{ text: texto }] }, groundingMetadata: {
      webSearchQueries: ['dançar na chuva fernandinho tom cifra'],
      searchEntryPoint: { renderedContent: '<style>.c{}</style><div class="container"><a href="https://www.google.com/search?q=x">dançar na chuva tom</a></div>' },
      groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/x', title: 'cifraclub.com.br' } }, { web: { uri: 'https://vertexaisearch.cloud.google.com/y', title: 'letras.mus.br' } }] } }] });
  }
  const texto = JSON.stringify({ musicas: [
    { titulo: 'Dançar na Chuva', artista: 'Fernandinho', tom: 'D', confianca: 'alta', trecho: 'eu vou dançar na chuva' },
    { titulo: 'Dançar na Chuva', artista: 'Fernandinho', tom: 'D', confianca: 'alta' },
    { titulo: 'Dançar na Chuva', artista: 'Ilmar Quintanilha', tom: 'F#m', confianca: 'média' },
    { titulo: 'Eu Vou Dançar na Chuva', artista: 'Banda VIP', tom: null, confianca: 'baixa' },
    { titulo: '', artista: 'x', tom: 'C', confianca: 'alta' },
    { titulo: 'Tom Esquisito', artista: 'y', tom: 'H', confianca: 'alta' } ] });
  return resp(200, { candidates: [{ content: { parts: [{ text: texto }] } }] });
};

const kv = new Map();
const env = { GEMINI_KEY: 'KEY', TONS: { get: async (k) => kv.has(k) ? JSON.parse(kv.get(k)) : null, put: async (k, v) => { kv.set(k, v); } } };
const ctx = { waitUntil: (p) => p };
async function call(qs, headers = {}, e = env) {
  const r = await worker.fetch(new Request('https://w.test/' + qs, { headers }), e, ctx);
  return { status: r.status, body: await r.json(), cors: r.headers.get('Access-Control-Allow-Origin') };
}
let fails = 0; const ok = (cond, msg) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + msg); if (!cond) fails++; };

let r = await call('?q=dan%C3%A7ar%20na%20chuva', { Origin: 'https://sentinelapushoficial-prog.github.io' });
ok(r.status === 200 && r.body.ok && r.body.modo === 'ia' && !r.body.grounded, 'modo rápido responde');
ok(r.body.results.length === 4 && r.body.results[3].t === 'Tom Esquisito' && r.body.results[3].k === null && r.body.results[3].c === 'baixa', 'dedup, título vazio descartado, tom ilegível vira null/baixa: ' + JSON.stringify(r.body.results.map(x => [x.t, x.a, x.k, x.c])));
ok(r.body.results[0].k === 'D' && r.body.results[0].c === 'alta' && r.body.results[0].trecho === 'eu vou dançar na chuva' && r.body.results[0].src === 'IA', 'primeiro resultado D alta com trecho');
ok(r.body.results[1].k === 'F#m' && r.body.results[1].c === 'media', 'acento em "média" normalizado');
ok(r.body.results[2].k === null && r.body.results[2].c === 'baixa', 'sem tom vai pro fim');
ok(r.cors === 'https://sentinelapushoficial-prog.github.io', 'CORS devolve a origem');
ok(calls.length === 1 && calls[0].model === 'gemini-3.5-flash-lite' && calls[0].schema && !calls[0].busca, 'primeira chamada: 3.5 flash-lite com esquema JSON');

r = await call('?q=Dan%C3%A7ar%20na%20Chuva%20');
ok(r.body.cached === true && calls.length === 1, 'segunda busca (mesmo texto, outra caixa) sai do cache sem chamar a IA');
ok(kv.size === 1, 'guardou no KV');

r = await call('?q=xyz&debug=1');
ok(r.body.log && r.body.log.length && r.body.bruto, 'debug traz log e resposta crua');

r = await call('?q=nada%20disso');
ok(r.body.ok && r.body.results.length === 0, 'sem reconhecer: lista vazia, ok:true');

const antes = calls.length;
r = await call('?q=quota%20x');
ok(r.status === 429 && r.body.code === 'limite', 'limite diário em todos os modelos → 429 "limite"');
ok(calls.length - antes === 3, 'tentou os 3 modelos da lista rápida (' + (calls.length - antes) + ')');

const a2 = calls.length;
r = await call('?q=semesquema%20teste', {}, Object.assign({}, env, { MODELOS: 'gemini-2.5-flash-lite' }));
ok(r.body.ok && calls.length - a2 === 2 && calls[a2].schema && !calls[a2 + 1].schema, 'erro de esquema → repete o mesmo modelo sem esquema');

// conferir (pesquisa Google), plano pago
const a3 = calls.length, kvAntes = kv.size;
r = await call('?q=dan%C3%A7ar%20na%20chuva&conferir=1');
ok(r.body.ok && r.body.modo === 'conferir' && r.body.grounded === true, 'conferir responde com pesquisa');
ok(calls[a3].model === 'gemini-3.8-flash' && calls[a3].busca && !calls[a3].schema, 'pesquisa: modelo maior primeiro, sem esquema JSON (incompatível)');
ok(calls[a3 + 1] && calls[a3 + 1].etapa2 && calls[a3 + 1].schema && !calls[a3 + 1].busca && calls.length - a3 === 2, 'etapa 2: relatório vira JSON com esquema, sem pesquisa (' + (calls.length - a3) + ' chamadas)');
ok(r.body.results.length === 2 && r.body.results[0].k === 'D' && r.body.results[0].src === 'cifraclub.com.br', '"Ré maior" → D; fonte vira domínio: ' + JSON.stringify(r.body.results));
ok(r.body.results[1].k === null && r.body.results[1].src === 'cifraclub.com.br', 'sem fonte própria herda a primeira fonte da pesquisa');
ok(r.body.fontes.join(',') === 'cifraclub.com.br,letras.mus.br' && r.body.sugestoes.indexOf('<div') >= 0 && r.body.pesquisas.length === 1, 'fontes, sugestões de pesquisa e consultas presentes');
ok(!r.body.cached && kv.size === kvAntes, 'conferir não é guardado em cache');
r = await call('?q=dan%C3%A7ar%20na%20chuva&conferir=1');
ok(!r.body.cached, 'nem na segunda vez');

// conferir no plano gratuito: 3.x recusa com 429 → erro claro de limite
plano = 'gratis';
r = await call('?q=dan%C3%A7ar%20na%20chuva&conferir=1');
ok(!r.body.ok && r.body.code === 'limite', 'plano grátis: pesquisa recusada vira erro "limite" (' + r.body.code + ')');
plano = 'pago';

// modelo que não pesquisou (sem groundingMetadata): rebaixa "alta" e tenta o próximo
semGrounding = true; const a5 = calls.length;
r = await call('?q=dan%C3%A7ar%20na%20chuva&conferir=1');
ok(r.body.ok && r.body.grounded === false && r.body.results.length === 1 && r.body.results.every(x => x.c !== 'alta' && x.src === 'IA') && calls.length - a5 === 3, 'sem pesquisa: tenta 2 modelos (+1 para estruturar), marca como palpite e rebaixa a confiança (' + (calls.length - a5) + ' chamadas)');
semGrounding = false;

// MODO=conferir faz ?q= já pesquisar
r = await call('?q=dan%C3%A7ar%20na%20chuva', {}, Object.assign({}, env, { MODO: 'conferir' }));
ok(r.body.modo === 'conferir' && r.body.grounded, 'MODO=conferir pesquisa direto');

// erros de configuração e proteção
r = await call('?q=x', {}, { GEMINI_KEY: '' });
ok(r.status === 503 && r.body.code === 'sem-chave', 'sem chave → 503 sem-chave');
r = await call('?q=x%20chave', {}, { GEMINI_KEY: 'ERRADA' });
ok(r.status === 503 && r.body.code === 'chave', 'chave recusada → 503 chave');
r = await call('?q=x', { Origin: 'https://outro.site' });
ok(r.status === 403, 'origem estranha → 403');
r = await call('');
ok(r.body.ok && r.body.hint, 'sem q → dica');
r = await call('?q=' + 'a'.repeat(130));
ok(r.status === 400, 'texto longo → 400');
let ultimo;
for (let i = 0; i < 7; i++) ultimo = await call('?q=ritmo' + i + '&conferir=1', { 'CF-Connecting-IP': '1.2.3.4' });
ok(ultimo.status === 429 && ultimo.body.code === 'ritmo', '7ª conferência no minuto → 429 ritmo');

console.log(fails ? ('\nFALHAS: ' + fails) : '\nTUDO OK');
process.exit(fails ? 1 : 0);
