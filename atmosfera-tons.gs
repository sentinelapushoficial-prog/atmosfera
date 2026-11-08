/*  Atmosfera · serviço de busca de tons na internet
 *  ------------------------------------------------
 *  O app (uma página no celular) não tem permissão para ler outros sites.
 *  Este script roda no Google (Apps Script) e faz isso por ele: procura a
 *  música no Cifra Club, abre cada versão encontrada e lê o campo "Tom".
 *
 *  Como publicar (uma vez, no computador):
 *   1. Abra https://script.google.com logado na sua conta Google → "Novo projeto".
 *   2. Apague o que estiver no editor e cole este arquivo inteiro. Salve (Ctrl+S).
 *   3. Implantar → Nova implantação → engrenagem: "App da Web"
 *      · Executar como: Eu
 *      · Quem pode acessar: Qualquer pessoa
 *      → Implantar → autorize com a sua conta → copie a URL (termina em /exec).
 *   4. No Atmosfera, em Repertório → "Busca de tons na internet", cole a URL e toque em Salvar e em Testar.
 *
 *  Teste direto no navegador:  SUA_URL?q=galileu          (resultado em JSON)
 *  Diagnóstico:                SUA_URL?q=galileu&debug=1  (mostra cada etapa)
 *
 *  Se mudar este código depois: Implantar → Gerenciar implantações → lápis → Versão: Nova → Implantar.
 */

var MAX_VERSOES = 6;          // quantas versões de uma música o serviço abre
var CACHE_SEGUNDOS = 6 * 3600;

function doGet(e) {
  var q = String((e && e.parameter && e.parameter.q) || '').trim();
  var debug = !!(e && e.parameter && e.parameter.debug);
  var out;
  if (!q) {
    out = { ok: true, results: [], hint: 'use ?q=nome da música' };
  } else {
    try { out = lookup(q, debug); }
    catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function lookup(q, debug) {
  var cache = CacheService.getScriptCache();
  var ck = 'q:' + q.toLowerCase();
  if (!debug) { var hit = cache.get(ck); if (hit) return JSON.parse(hit); }

  var log = [];
  var songs = searchSolr(q, log);
  if (!songs.length) songs = searchBing(q, log);
  if (!songs.length) songs = searchDuck(q, log);
  songs = songs.slice(0, MAX_VERSOES);

  var results = fetchKeys(songs, log);
  var out = { ok: true, q: q, results: results };
  if (debug) out.log = log;
  else { try { cache.put(ck, JSON.stringify(out), CACHE_SEGUNDOS); } catch (e2) {} }
  return out;
}

/* ---------- 1. Encontrar as versões da música (busca do próprio Cifra Club) ---------- */
function searchSolr(q, log) {
  try {
    var url = 'https://solr.sscdn.co/cc/h2/?q=' + encodeURIComponent(q) + '&wt=json&rows=25';
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    log.push('busca cifraclub: HTTP ' + r.getResponseCode());
    if (r.getResponseCode() !== 200) return [];
    var txt = r.getContentText();
    var i = txt.indexOf('{'); if (i > 0) txt = txt.slice(i, txt.lastIndexOf('}') + 1);   // tira um eventual callback(...)
    var data = JSON.parse(txt);
    var docs = (data.response && data.response.docs) || data.docs || [];
    var songs = [];
    docs.forEach(function (d) {
      var title = d.m || d.name || d.title || d.mn || '';
      var artist = d.a || d.artist || d.an || '';
      var artistSlug = d.d || d.ad || d.au || d.dns || '';
      var songSlug = d.u || d.su || d.url || '';
      if (!title || !artistSlug || !songSlug) return;                 // é artista, não música
      if (String(songSlug).indexOf('/') >= 0) songSlug = String(songSlug).split('/').pop();
      songs.push({ t: String(title), a: String(artist), url: 'https://www.cifraclub.com.br/' + artistSlug + '/' + songSlug + '/' });
    });
    log.push('busca cifraclub: ' + docs.length + ' itens, ' + songs.length + ' músicas');
    return songs;
  } catch (e) { log.push('busca cifraclub erro: ' + e); return []; }
}

/* ---------- 1b. Alternativas: achar os endereços do Cifra Club por um buscador ---------- */
function searchBing(q, log) {
  try {
    var url = 'https://www.bing.com/search?setlang=pt-br&q=' + encodeURIComponent(q + ' cifra site:cifraclub.com.br');
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'Accept-Language': 'pt-BR,pt;q=0.9' } });
    log.push('bing: HTTP ' + r.getResponseCode());
    if (r.getResponseCode() !== 200) return [];
    return linksFromHtml(r.getContentText(), log, 'bing');
  } catch (e) { log.push('bing erro: ' + e); return []; }
}
function searchDuck(q, log) {
  try {
    var url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q + ' cifra site:cifraclub.com.br');
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    log.push('duckduckgo: HTTP ' + r.getResponseCode());
    if (r.getResponseCode() !== 200) return [];
    return linksFromHtml(decodeURIComponent(r.getContentText()), log, 'duckduckgo');
  } catch (e) { log.push('duckduckgo erro: ' + e); return []; }
}
var PASTAS_NAO_ARTISTA = ['letra', 'letras', 'videoaulas', 'mais-acessadas', 'musicas', 'cifras', 'blog', 'gospel', 'mpb', 'rock', 'sertanejo', 'busca', 'artistas', 'estilos', 'lista', 'enviar', 'cursos', 'academy', 'app', 'static', 'tags', 'top-100'];
var PAGINAS_NAO_MUSICA = ['letra', 'simplificada', 'original', 'videoaula', 'videoaulas', 'cavaquinho', 'ukulele', 'teclado', 'baixo', 'bateria', 'violao', 'guitarra', 'imprimir', 'discografia', 'album', 'albuns', 'fotos', 'biografia'];
function linksFromHtml(html, log, src) {
  var re = /https?:\/\/(?:www\.)?cifraclub\.com\.br\/([a-z0-9\-]+)\/([a-z0-9\-]+)(?:\/|(?=["'<\s#?&)]|$))/g, m, seen = {}, songs = [];
  while ((m = re.exec(html))) {
    var a = m[1], s = m[2];
    if (PASTAS_NAO_ARTISTA.indexOf(a) >= 0 || PAGINAS_NAO_MUSICA.indexOf(s) >= 0) continue;
    var key = a + '/' + s; if (seen[key]) continue; seen[key] = true;
    songs.push({ t: '', a: '', url: 'https://www.cifraclub.com.br/' + a + '/' + s + '/' });
  }
  log.push(src + ': ' + songs.length + ' endereços');
  return songs;
}

/* ---------- 2. Abrir cada versão e ler o tom ---------- */
function fetchKeys(songs, log) {
  if (!songs.length) return [];
  var reqs = songs.map(function (s) { return { url: s.url, muteHttpExceptions: true, followRedirects: true }; });
  var resps;
  try { resps = UrlFetchApp.fetchAll(reqs); }
  catch (e) { log.push('abrir páginas erro: ' + e); return []; }
  var out = [];
  resps.forEach(function (r, i) {
    var code = r.getResponseCode();
    if (code !== 200) { log.push('página ' + songs[i].url + ': HTTP ' + code); return; }
    var p = parsePage(r.getContentText(), songs[i]);
    log.push('página ' + songs[i].url + ': ' + (p.k ? 'tom ' + p.k + ' (' + p.src + ')' : 'sem tom'));
    if (p.k && p.t) out.push(p);
  });
  return out;
}

function parsePage(html, song) {
  var out = { t: song.t || '', a: song.a || '', url: song.url, k: null, src: 'Cifra Club' };
  // nome e artista
  var og = html.match(/property="og:title"\s+content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
  if (og) {
    var parts = decodeEntities(og[1]).replace(/\s*[-|]\s*Cifra Club.*$/i, '').split(/\s+-\s+/);
    if (!out.t && parts[0]) out.t = titleCase(parts[0].trim());
    if (!out.a && parts[1]) out.a = parts[1].trim();
  }
  var h1 = html.match(/<h1[^>]*>\s*(?:<a[^>]*>)?\s*([^<]{2,80})/i);
  if (h1) out.t = clean(h1[1]);
  var h2 = html.match(/<h2[^>]*class="[^"]*t3[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*([^<]{2,80})/i);
  if (h2) out.a = clean(h2[1]);
  // tom
  var k = html.match(/id="cifra_tom"[^>]*>\s*(?:<a[^>]*>\s*)?([A-G][#b]?m?)\b/) ||
          html.match(/[Tt]om:\s*(?:<[^>]+>\s*)*([A-G][#b]?m?)\b/) ||
          html.match(/"tom"\s*:\s*"([A-G][#b]?m?)"/) ||
          html.match(/data-tom="([A-G][#b]?m?)"/);
  if (k) { out.k = k[1]; }
  else {
    var b = html.match(/<pre[^>]*>[\s\S]{0,400}?<b[^>]*>([A-G][#b]?m?)/);
    if (b) { out.k = b[1]; out.src = 'Cifra Club · 1º acorde'; }
  }
  return out;
}

function clean(s) { return decodeEntities(String(s)).replace(/\s+/g, ' ').trim(); }
var ENTIDADES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã', otilde: 'õ', ccedil: 'ç', acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Atilde: 'Ã', Otilde: 'Õ', Ccedil: 'Ç', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', Agrave: 'À', Uuml: 'Ü' };
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&([A-Za-z]+);/g, function (m, n) { return ENTIDADES.hasOwnProperty(n) ? ENTIDADES[n] : m; });
}
function titleCase(s) {
  if (s !== s.toUpperCase()) return s;      // só mexe se veio TODO EM MAIÚSCULAS
  var small = ['de', 'do', 'da', 'dos', 'das', 'e', 'a', 'o', 'em', 'no', 'na', 'que', 'pra', 'com', 'por'];
  return s.toLowerCase().split(' ').map(function (w, i) {
    return (i > 0 && small.indexOf(w) >= 0) ? w : w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}
