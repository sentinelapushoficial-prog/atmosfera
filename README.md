# Atmosfera

Pads de fundo para o louvor, sempre com fade: entrada e saída graduais, transição entre tons por crossfade, quatro timbres sintetizados no navegador, repertório com os tons de cada música, modo palco e controle por pedal (teclado Bluetooth ou MIDI).

Funciona como app instalável (PWA): abre sem internet depois da primeira visita.

- `index.html` — o app inteiro (áudio, interface, repertório)
- `manifest.webmanifest` e `icon-*.png` — instalação na tela inicial
- `sw.js` — cache para uso sem internet

## Som

- Motor de som original (o mesmo da 1.0 à 1.5, de volta na 1.9 a pedido do autor): quatro presets — Quente, Cristal,
  Cordas, Profundo — com duas dentes de serra desafinadas por nota, sub e agudos, filtro passa-baixas com LFO lento
  ("Movimento interno"), chorus/ensemble estéreo com duas linhas de atraso moduladas, reverb por convolução
  (resposta gerada, 6,5 s) e compressor/limitador (−6 dB, 12:1).
- Fades lineares em decibéis (de −50 dB até cheio), novidade da 1.6 mantida: a entrada cresce parelha, sem começar
  alta. Troca de tom por crossfade de potência constante.
- Segundo plano (desde a 1.6): enquanto o pad toca, um `<audio>` com 30 s de silêncio em loop toca junto, e a Media
  Session mostra música e tom na notificação e na tela de bloqueio (Pausar, Próxima, Anterior). Se o sistema pausar
  a mídia ou interromper o áudio, o app tenta voltar sozinho (até 8 vezes por minuto). Só para com Parar ou ao
  fechar o app.
- Histórico: as versões 1.6–1.8 experimentaram motores sem oscilação de nível (ensemble polifásico, shimmer,
  síntese aditiva de piano). O código está no histórico do git (commits "Atmosfera 1.6/1.7/1.8").
- `tests/test_audio.py` renderiza o motor num OfflineAudioContext e mede fade, ondulação, picos e equilíbrio
  espectral (a ondulação é informativa: o motor original tem movimento por natureza); `tests/test_bg.py` confere
  mídia/Media Session e as migrações de configurações.

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
