"""Som em segundo plano: mídia silenciosa acompanha o pad, Media Session reflete música/tom e estado,
pausa externa (sistema) é revertida pelo guardião, e a mídia para quando o som acaba."""
import asyncio, subprocess, sys, time
from playwright.async_api import async_playwright

import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8774

INIT = """
(function(){
  window.__audios = [];
  var ce = document.createElement.bind(document);
  document.createElement = function(tag){ var e = ce(tag); if (String(tag).toLowerCase() === 'audio') window.__audios.push(e); return e; };
})();
"""

async def ms(pg):
    return await pg.evaluate("() => ({state: navigator.mediaSession.playbackState, title: navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : null, artist: navigator.mediaSession.metadata ? navigator.mediaSession.metadata.artist : null, audios: window.__audios.length, paused: window.__audios.length ? window.__audios[0].paused : null, t: window.__audios.length ? window.__audios[0].currentTime : null, dur: window.__audios.length ? window.__audios[0].duration : null, loop: window.__audios.length ? window.__audios[0].loop : null})")

async def main():
    srv = subprocess.Popen(["python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    fails = []
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            ctx = await b.new_context(viewport={"width": 390, "height": 844})
            pg = await ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" and "ERR_" not in m.text and "fonts" not in m.text and "503" not in m.text else None)
            await pg.add_init_script(INIT)
            await pg.goto(f"http://localhost:{PORT}/index.html"); await pg.wait_for_timeout(600)

            print("antes de tocar:", await ms(pg))
            s0 = await ms(pg)
            if s0["audios"] != 0: fails.append("mídia criada antes de qualquer toque")

            await pg.click('.key[data-pc="2"]'); await pg.wait_for_timeout(1200)
            s1 = await ms(pg); print("tocando Ré (livre):", s1)
            if s1["state"] != "playing": fails.append(f"playbackState ao tocar = {s1['state']}")
            if not (s1["title"] or "").startswith("Tom livre"): fails.append(f"título ao tocar tom livre = {s1['title']}")
            if s1["paused"] is not False: fails.append("mídia silenciosa não está tocando")
            if not s1["dur"] or s1["dur"] < 25: fails.append(f"duração da mídia silenciosa = {s1['dur']} (esperado ≥ 30 s)")
            if s1["loop"] is not True: fails.append("mídia silenciosa sem loop")

            # Música da sequência: o título e o tom vão para a Media Session
            await pg.click("#seqlist .song >> nth=0"); await pg.wait_for_timeout(500)
            s2 = await ms(pg); print("música da sequência:", s2)
            if s2["title"] != "Galileu" or not any(k in (s2["artist"] or "") for k in ("A♯m","B♭m","Bbm")): fails.append(f"metadados da música = {s2['title']} / {s2['artist']}")

            # Pausa externa (como o sistema faz ao perder o foco de áudio): o guardião retoma em ~1,2 s
            await pg.evaluate("() => window.__audios[0].pause()")
            await pg.wait_for_timeout(300)
            s3 = await ms(pg); print("logo após pausa externa:", s3["paused"])
            await pg.wait_for_timeout(1800)
            s4 = await ms(pg); print("~2 s depois:", s4)
            if s4["paused"] is not False: fails.append("guardião não retomou a mídia após pausa externa")
            warn = await pg.evaluate("() => document.getElementById('ctxWarn').classList.contains('show')")
            print("aviso visível (contexto segue rodando → não deve):", warn)
            if warn: fails.append("aviso de interrupção apareceu com o contexto rodando")

            # Parar seco: mídia para depois da cauda (1 s) + ciclo do guardião (3 s); estado vira 'paused'
            await pg.click("#btnHard"); await pg.wait_for_timeout(4800)
            s5 = await ms(pg); print("após Parar seco:", s5)
            if s5["state"] != "paused": fails.append(f"playbackState após parar = {s5['state']}")
            if s5["paused"] is not True: fails.append("mídia silenciosa continuou após o som acabar")

            # Com o som parado, pausa externa não dispara nada
            await pg.wait_for_timeout(3200)
            s6 = await ms(pg)
            if s6["paused"] is not True: fails.append("mídia voltou a tocar sem som")

            # Fade out: a mídia segue durante a saída e a cauda, e só para depois
            await pg.click("#btnPlay"); await pg.wait_for_timeout(800)
            await pg.click("#btnStop"); await pg.wait_for_timeout(1500)
            s7 = await ms(pg); print("durante o fade-out:", s7["state"], s7["paused"])
            if s7["paused"] is not False or s7["state"] != "playing": fails.append("mídia parou durante o fade-out")

            # Handlers da Media Session existem (não dá para disparar pelo Playwright; só confere que setActionHandler aceitou)
            hs = await pg.evaluate("() => { var ok=[]; ['play','pause','stop','nexttrack','previoustrack'].forEach(function(a){ try{ navigator.mediaSession.setActionHandler(a, null); ok.push(a); }catch(e){} }); return ok; }")
            print("ações aceitas pela Media Session:", hs)

            # Movimento vem desligado; migração de configurações antigas zera o movimento
            mot = await pg.evaluate("() => document.getElementById('out-motion').textContent")
            print("ensemble padrão:", mot)
            if mot != "60": fails.append(f"ensemble padrão = {mot}")
            await pg.evaluate("() => { var d=JSON.parse(localStorage.getItem('atmosfera.v3')); d.settings.motion=0; d.settings.engine=6; localStorage.setItem('atmosfera.v3', JSON.stringify(d)); }")
            await pg.reload(); await pg.wait_for_timeout(600)
            mot2 = await pg.evaluate("() => document.getElementById('out-motion').textContent")
            print("ensemble após migrar configurações da 1.6 (movimento 0):", mot2)
            if mot2 != "60": fails.append(f"migração não repôs o ensemble ({mot2})")
            await pg.evaluate("() => { var i=document.getElementById('sl-motion'); i.value=0.4; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); }")
            await pg.reload(); await pg.wait_for_timeout(600)
            mot3 = await pg.evaluate("() => document.getElementById('out-motion').textContent")
            print("ensemble escolhido pelo usuário sobrevive ao recarregar:", mot3)
            if mot3 != "40": fails.append(f"preferência de ensemble perdida ({mot3})")

            ver = await pg.inner_text("#version"); print(ver)
            if "1.7" not in ver: fails.append("versão no rodapé")
            if errors: fails.append(f"erros JS: {errors}")
            await pg.set_viewport_size({"width": 390, "height": 844})
            await pg.screenshot(path=f"{ROOT}/shot_mobile_v17.png", full_page=False)
            await b.close()
    finally:
        srv.terminate()
    print("\nRESULTADO:", "OK" if not fails else "FALHAS:\n  " + "\n  ".join(fails))
    return 0 if not fails else 1

sys.exit(asyncio.run(main()))
