# Atmosfera

Pads de fundo para o louvor, sempre com fade: entrada e saída graduais, transição entre tons por crossfade, quatro timbres sintetizados no navegador, repertório com os tons de cada música, modo palco e controle por pedal (teclado Bluetooth ou MIDI).

Funciona como app instalável (PWA): abre sem internet depois da primeira visita.

- `index.html` — o app inteiro (áudio, interface, repertório)
- `manifest.webmanifest` e `icon-*.png` — instalação na tela inicial
- `sw.js` — cache para uso sem internet

## Som

- Fades lineares em decibéis (de −50 dB até cheio): o crescimento soa parelho do começo ao fim. Troca de tom por
  crossfade de potência constante.
- Presets **Piano** (padrão) e **Cristal**: síntese aditiva — cada nota é um conjunto de parciais senoidais com a
  envoltória espectral de um piano (queda 1/k^tilt e o pente da posição do martelo, ≈1/7,5 da corda), tônica uma
  oitava acima (entre Sol3 e Fá♯4), baixo uma oitava abaixo, quinta/oitava/12ª/15ª, nona leve e terça nos modos
  maior/menor. Afinação de afinador de piano (`partialFreq`/`below`): cada nota cai onde um parcial seu coincide
  com um parcial da tônica — nada bate devagar. A inarmonicidade (`inharm`) existe no código mas fica em 0: com ela
  os parciais vizinhos batem e o nível "respira" (medido 2–4 dB).
- **Cordas**: dente de serra em ensemble, uma oitava acima. **Profundo**: pad escuro no registro grave.
- Fase inicial por frequência (`startPhase`): parciais coincidentes somam sempre igual (timbre consistente), sem
  onda pontuda.
- Ensemble polifásico (`ENS`): seis linhas de atraso moduladas (LFO lento 0,9 Hz e rápido 6,2 Hz), fases a 60° —
  gira sem o nível oscilar. Divisor Linkwitz-Riley (`ensSplit`): só graves e médios passam pelo ensemble; os
  agudos seguem limpos (nos parciais agudos do piano o chorus virava tremor). O controle "Ensemble" regula a
  profundidade. Ondulação medida ≤ 0,9 dB em todos os presets.
- Shimmer: cópia uma oitava acima (deslocador granular, `makeShifter`) entra só no reverb.
- Sem LFO de amplitude e sem desafinação dentro da nota. Limitador só de segurança (−1 dB); nível de trabalho
  `BUS_GAIN`. Atenção: no Web Audio o `Q` dos passa-baixas/altas é em dB.
- Segundo plano: enquanto o pad toca, um `<audio>` com 30 s de silêncio em loop toca junto, e a Media Session mostra
  música e tom na notificação e na tela de bloqueio (Pausar, Próxima, Anterior). Se o sistema pausar a mídia ou
  interromper o áudio, o app tenta voltar sozinho (até 8 vezes por minuto). Só para com Parar ou ao fechar o app.
- `tests/test_audio.py` renderiza o motor num OfflineAudioContext e mede fade, ondulação, picos e equilíbrio
  espectral; `tests/test_shifter.py` confere o shimmer; `tests/test_bg.py` o comportamento de mídia/Media Session.

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
