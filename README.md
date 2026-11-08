# Atmosfera

Pads de fundo para o louvor, sempre com fade: entrada e saída graduais, transição entre tons por crossfade, quatro timbres sintetizados no navegador, repertório com os tons de cada música, modo palco e controle por pedal (teclado Bluetooth ou MIDI).

Funciona como app instalável (PWA): abre sem internet depois da primeira visita.

- `index.html` — o app inteiro (áudio, interface, repertório)
- `manifest.webmanifest` e `icon-*.png` — instalação na tela inicial
- `sw.js` — cache para uso sem internet

## Publicar uma versão nova

1. Edite `index.html` (e suba `APP_VERSION`).
2. Em `sw.js`, mude o número de `CACHE` (`atmosfera-v4` → `atmosfera-v5`…). É essa mudança que faz o celular baixar a versão nova e mostrar o aviso "Atualizar agora" dentro do app.
3. Faça o push para `main`: o GitHub Pages publica sozinho.

## Busca de tons na internet

O app não consegue ler outros sites sozinho. `atmosfera-tons.gs` é um serviço para o Google Apps Script
(gratuito, na conta Google do usuário) que procura a música no Cifra Club e devolve as versões com o tom.
Publique como App da Web (Executar como: eu · Acesso: qualquer pessoa) e cole a URL `/exec` em
Repertório → "Busca de tons na internet". Diagnóstico: `URL?q=galileu&debug=1`.
