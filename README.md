# Atmosfera

Pads de fundo para o louvor, sempre com fade: entrada e saída graduais, transição entre tons por crossfade, quatro timbres sintetizados no navegador, repertório com os tons de cada música, modo palco e controle por pedal (teclado Bluetooth ou MIDI).

Funciona como app instalável (PWA): abre sem internet depois da primeira visita.

- `index.html` — o app inteiro (áudio, interface, repertório)
- `manifest.webmanifest` e `icon-*.png` — instalação na tela inicial
- `sw.js` — cache para uso sem internet

## Som

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

## Busca de tons na internet

O app não consegue ler outros sites sozinho. `atmosfera-tons-worker.js` é um serviço para Cloudflare Workers
(plano gratuito: 100 mil consultas/dia) que procura a música no Cifra Club e devolve as versões com o tom.
Publique uma vez (Workers & Pages → Create Worker → Edit code → Deploy) e coloque o endereço em
`DEFAULT_SETTINGS.lookupUrl` no `index.html` (ou cole em Repertório → "Busca de tons na internet").
Origens autorizadas ficam em `ORIGENS` no Worker. Diagnóstico: `URL/?q=galileu&debug=1`.
`atmosfera-tons.gs` é a mesma coisa para Google Apps Script, caso prefira.
