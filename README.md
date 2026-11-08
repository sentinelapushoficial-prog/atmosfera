# Atmosfera

Pads de fundo para o louvor, sempre com fade: entrada e saída graduais, transição entre tons por crossfade, quatro timbres sintetizados no navegador, repertório com os tons de cada música, modo palco e controle por pedal (teclado Bluetooth ou MIDI).

Funciona como app instalável (PWA): abre sem internet depois da primeira visita.

- `index.html` — o app inteiro (áudio, interface, repertório)
- `manifest.webmanifest` e `icon-*.png` — instalação na tela inicial
- `sw.js` — cache para uso sem internet

## Som

- Fades lineares em decibéis (de −50 dB até cheio): o crescimento soa parelho do começo ao fim. Troca de tom por
  crossfade de potência constante.
- Timbre: ondas desenhadas por harmônicos (`makeWaves`), fases iniciais aleatórias (o acorde não se "cola" numa
  onda pontuda), oitavas exatas e quinta justa (`TUNING`), filtro passa-baixas em dois estágios (24 dB/oit).
- Ensemble polifásico (`ENS`): seis linhas de atraso moduladas por um LFO lento e um rápido, fases a 60° — o que
  uma linha tira a outra devolve, então o som gira sem o nível oscilar (ondulação medida ≤ 0,8 dB). As linhas saem
  espalhadas no estéreo; a soma em mono continua estável. O controle "Ensemble" regula a profundidade.
- Shimmer: cópia uma oitava acima (deslocador granular, `makeShifter`) entra só no reverb.
- Sem LFO de amplitude e sem desafinação entre osciladores de uma mesma nota. Limitador só de segurança (−1 dB);
  o nível de trabalho é `BUS_GAIN`.
- Segundo plano: enquanto o pad toca, um `<audio>` com 30 s de silêncio em loop toca junto, e a Media Session mostra
  música e tom na notificação e na tela de bloqueio (Pausar, Próxima, Anterior). Se o sistema pausar a mídia ou
  interromper o áudio, o app tenta voltar sozinho (até 8 vezes por minuto). Só para com Parar ou ao fechar o app.
- `test_audio.py` renderiza o motor num OfflineAudioContext e mede fade, ondulação e picos; `test_shifter.py`
  confere o shimmer; `test_bg.py` o comportamento de mídia/Media Session.

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
