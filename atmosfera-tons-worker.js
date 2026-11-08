/*  Atmosfera · serviço de busca de tons na internet (Cloudflare Worker)
 *  ---------------------------------------------------------------------
 *  O app (uma página no celular) não tem permissão para ler outros sites.
 *  Este serviço roda na Cloudflare e faz isso por ele: procura a música no
 *  Cifra Club, abre cada versão encontrada e lê o campo "Tom".
 *
 *  Como publicar (uma vez, no computador, plano gratuito):
 *   1. Crie a conta em https://dash.cloudflare.com (gratuita).
 *   2. Menu "Workers & Pages" → "Create" → "Create Worker" → nome: atmosfera-tons → "Deploy".
 *   3. "Edit code" → apague tudo, cole este arquivo inteiro → "Deploy".
 *   4. Copie o endereço (algo como https://atmosfera-tons.SEUNOME.workers.dev) e mande para embutir no app.
 *      Enquanto isso, dá para colar o endereço no app em Repertório → "Busca de tons na internet".
 *   Opcional (cache maior): Settings → Bindings → KV namespace, nome da variável TONS.
 *
 *  Teste no navegador:  SEU_ENDERECO/?q=galileu          (JSON)
 *  Diagnóstico:         SEU_ENDERECO/?q=galileu&debug=1  (mostra cada etapa)
 */

const MAX_VERSOES = 6;                 // quantas versões de uma música o serviço abre
const CACHE_SEGUNDOS = 6 * 3600;
const LIMITE_POR_MINUTO = 60;          // por endereço IP
const USER_AGENT = 'AtmosferaTons/1.0 (busca de tom para app de pad; contato via sentinelapush.com.br)';
// Origens (sites) autorizadas a usar o serviço. Sem Origin (teste direto no navegador) também passa.
const ORIGENS = [
  'https://sentinelapushoficial-prog.github.io'
  // acrescente aqui o domínio próprio do app quando existir, ex.: 'https://atmosfera.sentinelapush.com.br'
];

const memCache = new Map();            // cache em memória (dura enquanto a instância vive)
const hits = new Map();                // contagem por IP por minuto

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ ok: false, error: 'só GET' }, 405, cors);
    if (origin && !origemOk(origin)) return json({ ok: false, error: 'origem não autorizada' }, 403, cors);
    if (url.pathname !== '/' && url.pathname !== '/tom') return json({ ok: false, error: 'use /?q=nome da música' }, 404, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'x';
    if (!dentroDoLimite(ip)) return json({ ok: false, error: 'muitas buscas em um minuto; tente de novo daqui a pouco' }, 429, cors);

    const q = (url.searchParams.get('q') || '').trim();
    const debug = url.searchParams.get('debug') === '1';
    if (!q) return json({ ok: true, results: [], hint: 'use ?q=nome da música' }, 200, cors);
    if (q.length > 80) return json({ ok: false, error: 'nome muito longo' }, 400, cors);

    try {
      const out = await lookup(q, debug, env, ctx);
      return json(out, 200, cors, debug ? 0 : 3600);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500, cors);
    }
  }
};

/* ---------- utilidades HTTP ---------- */
function origemOk(origin) { return ORIGENS.indexOf(origin) >= 0; }
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin && origemOk(origin) ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(obj, status, cors, maxAge) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors);
  h['Cache-Control'] = maxAge ? 'public, max-age=' + maxAge : 'no-store';
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}
function dentroDoLimite(ip) {
  const minuto = Math.floor(Date.now() / 60000);
  const k = ip + ':' + minuto;
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (hits.size > 5000) { for (const key of hits.keys()) { if (!key.endsWith(':' + minuto)) hits.delete(key); } }
  return n <= LIMITE_POR_MINUTO;
}
async function fetchText(url, log, nome) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9', 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8' } });
    log.push(nome + ': HTTP ' + r.status);
    if (r.status !== 200) return null;
    return await r.text();
  } catch (e) {
    log.push(nome + ' erro: ' + (e && e.name === 'AbortError' ? 'tempo esgotado' : e));
    return null;
  } finally { clearTimeout(timer); }
}

/* ---------- busca ---------- */
async function lookup(q, debug, env, ctx) {
  const key = 'q:' + q.toLowerCase();
  if (!debug) {
    const m = memCache.get(key);
    if (m && Date.now() - m.ts < CACHE_SEGUNDOS * 1000) return m.out;
    if (env && env.TONS) { try { const kv = await env.TONS.get(key, 'json'); if (kv) { memCache.set(key, { ts: Date.now(), out: kv }); return kv; } } catch (e) {} }
  }
  const log = [];
  let songs = await searchSolr(q, log);
  if (!songs.length) songs = await searchBing(q, log);
  if (!songs.length) songs = await searchDuck(q, log);
  songs = songs.slice(0, MAX_VERSOES);
  const results = await fetchKeys(songs, log);
  const out = { ok: true, q, results };
  if (debug) out.log = log;
  else {
    memCache.set(key, { ts: Date.now(), out });
    if (memCache.size > 2000) memCache.delete(memCache.keys().next().value);
    if (env && env.TONS && results.length && ctx) { ctx.waitUntil(env.TONS.put(key, JSON.stringify(out), { expirationTtl: CACHE_SEGUNDOS }).catch(() => {})); }
  }
  return out;
}

/* 1. Encontrar as versões da música (busca do próprio Cifra Club) */
async function searchSolr(q, log) {
  let txt = await fetchText('https://solr.sscdn.co/cc/h2/?q=' + encodeURIComponent(q) + '&wt=json&rows=25', log, 'busca cifraclub');
  if (!txt) return [];
  try {
    const i = txt.indexOf('{'); if (i > 0) txt = txt.slice(i, txt.lastIndexOf('}') + 1);   // tira um eventual callback(...)
    const data = JSON.parse(txt);
    const docs = (data.response && data.response.docs) || data.docs || [];
    const songs = [];
    for (const d of docs) {
      const title = d.m || d.name || d.title || d.mn || '';
      const artist = d.a || d.artist || d.an || '';
      const artistSlug = d.d || d.ad || d.au || d.dns || '';
      let songSlug = d.u || d.su || d.url || '';
      if (!title || !artistSlug || !songSlug) continue;              // é artista, não música
      if (String(songSlug).indexOf('/') >= 0) songSlug = String(songSlug).split('/').filter(Boolean).pop();
      songs.push({ t: String(title), a: String(artist), url: 'https://www.cifraclub.com.br/' + artistSlug + '/' + songSlug + '/' });
    }
    log.push('busca cifraclub: ' + docs.length + ' itens, ' + songs.length + ' músicas');
    return songs;
  } catch (e) { log.push('busca cifraclub erro: ' + e); return []; }
}

/* 1b. Alternativas: achar os endereços do Cifra Club por um buscador */
async function searchBing(q, log) {
  const html = await fetchText('https://www.bing.com/search?setlang=pt-br&q=' + encodeURIComponent(q + ' cifra site:cifraclub.com.br'), log, 'bing');
  return html ? linksFromHtml(html, log, 'bing') : [];
}
async function searchDuck(q, log) {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q + ' cifra site:cifraclub.com.br'), log, 'duckduckgo');
  if (!html) return [];
  let dec = html; try { dec = decodeURIComponent(html); } catch (e) {}
  return linksFromHtml(dec, log, 'duckduckgo');
}
const PASTAS_NAO_ARTISTA = ['letra', 'letras', 'videoaulas', 'mais-acessadas', 'musicas', 'cifras', 'blog', 'gospel', 'mpb', 'rock', 'sertanejo', 'busca', 'artistas', 'estilos', 'lista', 'enviar', 'cursos', 'academy', 'app', 'static', 'tags', 'top-100'];
const PAGINAS_NAO_MUSICA = ['letra', 'simplificada', 'original', 'videoaula', 'videoaulas', 'cavaquinho', 'ukulele', 'teclado', 'baixo', 'bateria', 'violao', 'guitarra', 'imprimir', 'discografia', 'album', 'albuns', 'fotos', 'biografia'];
function linksFromHtml(html, log, src) {
  const re = /https?:\/\/(?:www\.)?cifraclub\.com\.br\/([a-z0-9\-]+)\/([a-z0-9\-]+)(?:\/|(?=["'<\s#?&)]|$))/g;
  const seen = new Set(), songs = [];
  let m;
  while ((m = re.exec(html))) {
    const a = m[1], s = m[2];
    if (PASTAS_NAO_ARTISTA.indexOf(a) >= 0 || PAGINAS_NAO_MUSICA.indexOf(s) >= 0) continue;
    const key = a + '/' + s; if (seen.has(key)) continue; seen.add(key);
    songs.push({ t: '', a: '', url: 'https://www.cifraclub.com.br/' + a + '/' + s + '/' });
  }
  log.push(src + ': ' + songs.length + ' endereços');
  return songs;
}

/* 2. Abrir cada versão e ler o tom */
async function fetchKeys(songs, log) {
  if (!songs.length) return [];
  const pages = await Promise.all(songs.map(s => fetchText(s.url, log, 'página ' + s.url)));
  const out = [];
  pages.forEach((html, i) => {
    if (!html) return;
    const p = parsePage(html, songs[i]);
    log.push('página ' + songs[i].url + ': ' + (p.k ? 'tom ' + p.k + ' (' + p.src + ')' : 'sem tom'));
    if (p.k && p.t) out.push(p);
  });
  return out;
}
function parsePage(html, song) {
  const out = { t: song.t || '', a: song.a || '', url: song.url, k: null, src: 'Cifra Club' };
  const og = html.match(/property="og:title"\s+content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
  if (og) {
    const parts = decodeEntities(og[1]).replace(/\s*[-|]\s*Cifra Club.*$/i, '').split(/\s+-\s+/);
    if (!out.t && parts[0]) out.t = titleCase(parts[0].trim());
    if (!out.a && parts[1]) out.a = parts[1].trim();
  }
  const h1 = html.match(/<h1[^>]*>\s*(?:<a[^>]*>)?\s*([^<]{2,80})/i);
  if (h1) out.t = clean(h1[1]);
  const h2 = html.match(/<h2[^>]*class="[^"]*t3[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*([^<]{2,80})/i);
  if (h2) out.a = clean(h2[1]);
  const k = html.match(/id="cifra_tom"[^>]*>\s*(?:<a[^>]*>\s*)?([A-G][#b]?m?)\b/) ||
            html.match(/[Tt]om:\s*(?:<[^>]+>\s*)*([A-G][#b]?m?)\b/) ||
            html.match(/"tom"\s*:\s*"([A-G][#b]?m?)"/) ||
            html.match(/data-tom="([A-G][#b]?m?)"/);
  if (k) { out.k = k[1]; }
  else {
    const b = html.match(/<pre[^>]*>[\s\S]{0,400}?<b[^>]*>([A-G][#b]?m?)/);
    if (b) { out.k = b[1]; out.src = 'Cifra Club · 1º acorde'; }
  }
  return out;
}

/* ---------- texto ---------- */
const ENTIDADES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã', otilde: 'õ', ccedil: 'ç', acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Atilde: 'Ã', Otilde: 'Õ', Ccedil: 'Ç', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', Agrave: 'À', Uuml: 'Ü' };
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([A-Za-z]+);/g, (m, n) => Object.prototype.hasOwnProperty.call(ENTIDADES, n) ? ENTIDADES[n] : m);
}
function clean(s) { return decodeEntities(String(s)).replace(/\s+/g, ' ').trim(); }
function titleCase(s) {
  if (s !== s.toUpperCase()) return s;       // só mexe se veio TODO EM MAIÚSCULAS
  const small = ['de', 'do', 'da', 'dos', 'das', 'e', 'a', 'o', 'em', 'no', 'na', 'que', 'pra', 'com', 'por'];
  return s.toLowerCase().split(' ').map((w, i) => (i > 0 && small.indexOf(w) >= 0) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
