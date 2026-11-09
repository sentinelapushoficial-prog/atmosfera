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

## Repertório e busca (2.4)

- **Catálogo embutido** em `CATALOG_RAW` (`index.html`): `Título|Artista|Tom|trechos da letra separados por ;`.
  O tom é o da gravação original (fichas "Original Master" do MultiTracks.com e cifras publicadas); os trechos são
  frases curtas, só para a busca encontrar a música pela letra. Para acrescentar uma música, basta uma linha nova.
- **Busca** (`searchCatalog`/`matchText`): entende nome, artista ou pedaço da letra; ignora acento, maiúsculas e
  pontuação; aceita começo de palavra (autocompletar), ordem trocada e erro de digitação (distância de edição 1,
  ou 2 em palavras longas). Palavras muito comuns (de, que, eu…) não são exigidas. Frase inteira dentro do nome
  vale mais que dentro da letra, que vale mais que no artista. O repertório do usuário é filtrado pelo mesmo motor,
  usando os trechos do catálogo quando a música veio de lá.
- **Nada encontrado:** o app mostra links para a busca do Cifra Club e do Letras (abrem no navegador) e o botão
  "Cadastrar à mão". Não há leitura automática de sites: o Cifra Club responde 403 a servidores (bloqueio
  deliberado de leitura automatizada), então a versão 2.3 (serviço em Cloudflare Workers / Apps Script que lia as
  cifras) foi removida. Respeitar isso é condição para um app que vai à loja.
- **Compartilhar → Atmosfera PAD** (`share_target` no manifesto; `handleShareTarget` no `index.html`): na página
  da cifra, o compartilhamento do Android abre o app com nome e artista preenchidos (`parseShared` entende os
  títulos do Cifra Club, Letras e YouTube, com botão para trocar nome ⇄ artista); se a música está no catálogo,
  o tom já vem sugerido. Funciona com o app instalado na tela inicial.
