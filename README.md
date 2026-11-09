# Atmosfera PAD

Pads de fundo para o louvor, sempre com fade: entrada e saída graduais, transição entre tons por crossfade, quatro timbres sintetizados no navegador, repertório com os tons de cada música, modo palco e controle por pedal (teclado Bluetooth ou MIDI).

Funciona como app instalável (PWA): abre sem internet depois da primeira visita.

- `index.html` — o app inteiro (áudio, interface, repertório)
- `manifest.webmanifest` e `icon-*.png` — instalação na tela inicial
- `atmosfera-worklet.js` — o motor de áudio (AudioWorklet): um processador por voz (acorde) e um de efeitos
- `sw.js` — cache para uso sem internet
- `tests/` — testes com Playwright (`test_search.py` cobre a busca e o compartilhamento)

## Som

- **Motor em AudioWorklet (2.2).** Antes, cada acorde era um grafo de ~140 nós do Web Audio (35 osciladores,
  ganhos, panners, filtros, LFOs) mais ~110 nós de efeitos; em segundo plano no Android, a thread de áudio do
  Chrome não dava conta e o som picotava (gravação do autor: buracos de 20 ms e um de 1 s ao abrir outro app).
  Agora `atmosfera-worklet.js` faz tudo em dois processadores escritos à mão (`atmosfera-voice`: uníssono de
  dentes de serra PolyBLEP, sub/agudos, LFOs, filtro 24 dB/oit; `atmosfera-fx`: chorus, shimmer, reverb FDN,
  mistura). Medido em renderização offline: ~3× mais barato que o grafo nativo (4% contra 13% de um núcleo de
  desktop no pior caso, com duas vozes em crossfade). No `index.html` ficam só os ganhos de fade, o nivelador,
  o volume, o limitador e o medidor. O módulo é carregado no primeiro toque; se o toque vier antes de ele estar
  pronto, o pedido fica pendente e toca assim que carrega.

- Base: o motor original (1.0–1.5), evoluído na 2.0 na direção dos "warm pads" de louvor (os pads de Omnisphere
  usados por Hillsong/Elevation e canais como Worship the One):
  - corpo de cada nota em **uníssono de cinco dentes de serra** (`UNISON`, desafinações irregulares, espalhadas no
    estéreo) em vez de duas — as duas batiam fundo a cada segundo; cinco viram textura;
  - **filtro passa-baixas em dois estágios** (24 dB/oit) com LFO lento no brilho e LFO lento de amplitude por nota —
    o "Movimento interno" regula os dois (`MOTION`), padrão 35;
  - **chorus estilo Juno** (`CHORUS`, ~0,5 Hz, raso) — o chorus antigo a 0,1 Hz balançava o nível devagar;
  - **shimmer em cascata**: cópia uma oitava acima (deslocador granular, `makeShifter`) entra no reverb, e parte da
    cauda volta ao deslocador (`SHIMMER_FB`, ganho do laço ≤ 0,45): a cada volta sobe mais uma oitava e some;
  - reverb por **rede de atrasos realimentada** (FDN, `makeFDN`: 16 linhas de 50–300 ms, matriz de Householder,
    passa-baixas e passa-altas em cada linha, RT60 ≈ 8 s, pré-delay 40 ms). Substituiu a convolução de 8 s na 2.1:
    o ConvolverNode do Chrome processa a cauda numa thread de fundo que o Android estrangula quando o app sai da
    frente (som intermitente); a FDN roda inteira na thread de áudio e custa quase nada. O passa-altas (60 Hz) dentro
    do laço é obrigatório: sem ele, padrões de DC/subgrave ficam presos (autovalor +1 da matriz) e, com a
    realimentação do shimmer, explodem;
  - nivelador suave (`GLUE`), limitador de segurança e corte fixo de −3 dB (o DynamicsCompressor do navegador
    compensa o ganho sozinho, então só o corte garante que nada passe de 0 dBFS);
  - nona leve nos modos aberto e maior (`ninth`).
- Fades lineares em decibéis (de −50 dB até cheio). Troca de tom por crossfade de potência constante.
- Segundo plano (desde a 1.6): `<audio>` com 30 s de silêncio em loop enquanto o pad toca, Media Session com música
  e tom (Pausar, Próxima, Anterior na tela de bloqueio). Guardião (2.1): se o áudio parar de verdade (contexto
  interrompido), tenta voltar em 1,2 s e depois com recuo (3, 8, 20, 45 s); se só a mídia silenciosa foi pausada e
  o pad segue tocando, não disputa o foco (era isso que deixava o som intermitente) e religa a mídia quando o
  usuário volta ao app ou após 45 s.
- Volume (2.1): o fader vem travado (cadeado; ao liberar, trava de novo sozinho em 20 s) e os botões − / + mudam
  5% por toque — toques sem querer ao buscar Iniciar/Parar não mexem no volume.
- Histórico: 1.6–1.8 experimentaram motores sem oscilação de nível (ensemble polifásico, síntese aditiva de piano);
  1.9 voltou ao original. Tudo no histórico do git.
- `tests/test_audio.py` renderiza o motor num OfflineAudioContext (fade, ondulação, picos, espectro);
  `tests/test_shifter.py` confere o shimmer; `tests/test_bg.py` mídia/Media Session e migrações.

## Publicar uma versão nova

1. Edite `index.html` (e suba `APP_VERSION`).
2. Em `sw.js`, mude o número de `CACHE` (`atmosfera-v4` → `atmosfera-v5`…). É essa mudança que faz o celular baixar a versão nova e mostrar o aviso "Atualizar agora" dentro do app.
3. Faça o push para `main`: o GitHub Pages publica sozinho.

## Repertório e busca (2.5)

Três camadas, nesta ordem:

1. **Catálogo embutido** em `CATALOG_RAW` (`index.html`): `Título|Artista|Tom|trechos da letra separados por ;`.
   Tom da gravação original (fichas "Original Master" do MultiTracks.com e cifras publicadas); os trechos são
   frases curtas só para a busca achar a música pela letra. Responde na hora, sem internet.
2. **IA do Google (modo rápido).** O que não está no catálogo vai para o serviço `atmosfera-pad-worker.js`
   (Cloudflare Worker), que pergunta ao Gemini pela API oficial. A IA identifica a música pelo nome, artista ou
   trecho da letra e lista versões com o tom e um grau de confiança (`alta/media/baixa`). O app marca "IA · não
   conferido" e põe `?` quando o tom é incerto. Esse resultado pode ser guardado (KV no Worker, 30 dias;
   `localStorage` no aparelho, 7 dias).
3. **Conferir no Google.** A IA pesquisa as cifras na hora (Grounding with Google Search) e devolve o tom com o
   site de origem. Dispara sozinho quando a IA não deu nenhum tom com confiança alta, ou no botão. Pelos termos
   do Google, esse resultado (a) é mostrado só a quem perguntou, (b) não é guardado em cache — nem no Worker nem
   no `localStorage`; só na memória da sessão — e (c) vem acompanhado das **Sugestões de pesquisa do Google**
   (`searchEntryPoint.renderedContent`), que o app exibe num `iframe` logo abaixo da lista.

A busca local (`searchCatalog`/`matchText`) ignora acento, maiúsculas e pontuação; aceita começo de palavra,
ordem trocada e erro de digitação. O repertório do usuário é filtrado pelo mesmo motor. **Compartilhar →
Atmosfera PAD** (`share_target` no manifesto) abre o app com nome e artista preenchidos a partir da página da
cifra. Ler o Cifra Club direto pelo servidor não funciona: o site responde 403 a leitura automática (versão 2.3,
removida).

### Publicar o serviço (uma vez)

1. Cloudflare → Workers & Pages → worker `atmosfera-pad` → **Edit code** → colar `atmosfera-pad-worker.js` → **Deploy**.
2. Chave da IA: [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key**.
   No worker: **Settings → Variables and Secrets → Add** → tipo *Secret* → nome `GEMINI_KEY` → colar → **Deploy**.
3. Opcional, recomendado: **Storage & Databases → KV → Create** (`atmosfera-tons`) e, no worker, **Settings →
   Bindings → Add → KV namespace**, variável `TONS`. É o cache compartilhado do modo rápido.
4. Variáveis opcionais: `MODELOS` e `MODELOS_BUSCA` (listas separadas por vírgula; padrão
   `gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite` e
   `gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash`), `MODO=conferir` (toda busca já pesquisa no Google).
5. Teste: `https://atmosfera-pad.ffdasilva1990.workers.dev/?q=galileu&debug=1` (mostra modelo, tentativas e a
   resposta crua da IA). O endereço do serviço fica em `LOOKUP_DEFAULT` no `index.html`.

Plano gratuito do Gemini: modo rápido com Flash-Lite 3.x (centenas de pedidos/dia); a pesquisa Google só existe no
2.5 Flash-Lite (até 500/dia, partilhados). Com faturamento ativado no AI Studio (Tier 1): 5.000 pesquisas/mês
grátis nos modelos 3.x, depois US$ 14 por 1.000; tokens custam frações de centavo por busca. O Worker tenta os
modelos em ordem e passa ao seguinte quando um recusa (limite diário, indisponível no plano). Limites por IP:
20 buscas rápidas e 6 conferências por minuto. Só o texto digitado sai do aparelho.

Testes: `node tests/test_worker.mjs` (Worker com Google simulado), `python3 tests/test_web.py` (fluxo no app com o
serviço simulado), `python3 tests/test_search.py` (busca local e compartilhamento).
