import asyncio, json, subprocess, time
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
ROOT="/home/claude/atmosfera"; PORT=8773
WORKER="https://atmosfera-pad.ffdasilva1990.workers.dev/"
SUG='<style>.container{display:flex}.chip{border:1px solid}</style><div class="container"><span class="headline">Google</span><a class="chip" href="https://www.google.com/search?q=fogo+consumidor+tom">fogo consumidor tom</a></div>'
IA={
  "fogo consumidor": {"ok":True,"modo":"ia","grounded":False,"results":[
      {"t":"Fogo Consumidor","a":"Ministério Avivah","k":"B","c":"alta","trecho":"vem com fogo consumidor","src":"IA"},
      {"t":"Fogo Consumidor","a":"Kemuel","k":"A","c":"media","src":"IA"},
      {"t":"Fogo Consumidor","a":"Fernandinho","k":None,"c":"baixa","src":"IA"}]},
  "musica incerta": {"ok":True,"modo":"ia","grounded":False,"results":[{"t":"Música Incerta","a":"Alguém","k":"G","c":"media","src":"IA"}]},
  "musica desconhecida": {"ok":True,"modo":"ia","grounded":False,"results":[]},
  "dancar na chuva": {"ok":True,"modo":"ia","grounded":False,"results":[
      {"t":"Dançar na Chuva","a":"Fernandinho","k":"D","c":"alta","src":"IA"},
      {"t":"Dançar na Chuva","a":"Banda VIP","k":"E","c":"alta","src":"IA"}]},
  "erro total": {"ok":False,"code":"limite","error":"limite diário da IA atingido"},
  "sem chave": {"ok":False,"code":"sem-chave","error":"o serviço ainda não tem a chave"},
}
CONF={
  "musica incerta": {"ok":True,"modo":"conferir","grounded":True,"results":[{"t":"Música Incerta","a":"Alguém","k":"F#m","c":"alta","src":"cifraclub.com.br"}],"fontes":["cifraclub.com.br","letras.mus.br"],"sugestoes":SUG,"pesquisas":["musica incerta tom cifra"]},
  "fogo consumidor": {"ok":True,"modo":"conferir","grounded":True,"results":[{"t":"Fogo Consumidor","a":"Ministério Avivah","k":"B","c":"alta","src":"cifraclub.com.br"},{"t":"Fogo Consumidor","a":"Kemuel","k":"Bb","c":"alta","src":"cifraclub.com.br"}],"fontes":["cifraclub.com.br"],"sugestoes":SUG,"pesquisas":["x"]},
  "musica desconhecida": {"ok":True,"modo":"conferir","grounded":True,"results":[],"fontes":[],"sugestoes":SUG,"pesquisas":["x"]},
}
async def main():
    srv=subprocess.Popen(["python3","-m","http.server",str(PORT),"--bind","127.0.0.1"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
    fails=[]
    def check(cond,msg):
        print(("ok   " if cond else "FAIL ")+msg)
        if not cond: fails.append(msg)
    try:
        async with async_playwright() as pw:
            b=await pw.chromium.launch(); ctx=await b.new_context(viewport={"width":390,"height":844}); pg=await ctx.new_page()
            errors=[]; pg.on("pageerror", lambda e: errors.append(str(e)))
            calls=[]; off={"on":False}
            async def handler(route, request):
                if off["on"]: await route.abort("internetdisconnected"); return
                qs=parse_qs(urlparse(request.url).query); q=qs.get("q",[""])[0].lower(); conferir=qs.get("conferir",[""])[0]=="1"
                calls.append((q,conferir))
                import unicodedata
                qn=''.join(c for c in unicodedata.normalize('NFD',q) if unicodedata.category(c)!='Mn')
                body=(CONF if conferir else IA).get(qn, {"ok":True,"modo":"conferir" if conferir else "ia","grounded":conferir,"results":[],"fontes":[],"sugestoes":SUG if conferir else ""})
                await asyncio.sleep(0.15)
                await route.fulfill(status=200 if body.get("ok") else 429, content_type="application/json", body=json.dumps(body))
            await ctx.route(WORKER+"**", handler)
            await pg.goto(f"http://localhost:{PORT}/index.html"); await pg.wait_for_timeout(600)
            check("2.5" in await pg.inner_text("#version"), "versão 2.5")
            # 1. música do catálogo: nada vai à internet; botão manual aparece
            await pg.fill("#search","dançar na chuva"); await pg.wait_for_timeout(1300)
            check(len(calls)==0, "catálogo responde; internet não é chamada sozinha")
            check(not await pg.locator("#webBlock").is_hidden() and not await pg.locator("#btnWebSearch").is_hidden(), "bloco da internet com botão 'Buscar na internet (IA)'")
            # toque manual: traz versões além das do catálogo (Banda VIP), sem repetir Fernandinho (já no catálogo)
            await pg.click("#btnWebSearch"); await pg.wait_for_timeout(600)
            ts=await pg.locator("#weblist .song .t").all_inner_texts(); subs=await pg.locator("#weblist .song .a").all_inner_texts()
            check(ts==["Dançar na Chuva"] and "Banda VIP" in subs[0] and "IA" in subs[0], f"manual: só a versão nova aparece, marcada IA: {ts} {subs}")
            check(calls==[("dançar na chuva",False)], f"uma chamada rápida: {calls}")
            check(not await pg.locator("#btnWebVerify").is_hidden() and await pg.locator("#btnWebSearch").is_hidden(), "botão Conferir no Google disponível, Buscar sumiu")
            # 2. fora do catálogo: busca automática, com tom seguro → não confere sozinho
            calls.clear(); await pg.fill("#search","fogo consumidor"); await pg.wait_for_timeout(300)
            check("IA" in await pg.inner_text("#webStatus"), "enquanto espera: 'Perguntando à IA…' → "+await pg.inner_text("#webStatus"))
            await pg.wait_for_timeout(1200)
            ts=await pg.locator("#weblist .song .t").all_inner_texts(); ks=await pg.locator("#weblist .song .k").all_inner_texts(); subs=await pg.locator("#weblist .song .a").all_inner_texts(); whys=await pg.locator("#weblist .song .why").all_inner_texts()
            check(ts==["Fogo Consumidor"]*3 and ks==["B","A","?"], f"3 versões, tom incerto com ? : {ks}")
            check("tom incerto" in subs[1] and "tom incerto" in subs[2] and "não conferido" in subs[0], f"legendas: {subs}")
            check(whys==["letra: “…vem com fogo consumidor…”"], f"trecho da letra: {whys}")
            check(calls==[("fogo consumidor",False)], f"só a chamada rápida (tem tom seguro): {calls}")
            check("sem conferir" in await pg.inner_text("#webStatus"), "aviso de tom não conferido")
            check(await pg.locator("#webSug").is_hidden(), "sem sugestões do Google antes de conferir")
            # conferir manualmente
            await pg.click("#btnWebVerify"); await pg.wait_for_timeout(120)
            check("Conferindo" in await pg.inner_text("#webStatus"), "status 'Conferindo no Google…'")
            await pg.wait_for_timeout(500)
            ks=await pg.locator("#weblist .song .k").all_inner_texts(); subs=await pg.locator("#weblist .song .a").all_inner_texts()
            check(ks==["B","A♯"] and all("conferido · cifraclub.com.br" in x for x in subs), f"conferido: {ks} {subs}")
            check("conferido no Google" in await pg.inner_text("#webHead") and "cifraclub.com.br" in await pg.inner_text("#webHead"), "cabeçalho com fonte")
            check(not await pg.locator("#webSug").is_hidden() and "google.com/search" in (await pg.get_attribute("#webSug","srcdoc")), "sugestões de pesquisa do Google exibidas")
            check(await pg.locator("#btnWebVerify").is_hidden(), "botão Conferir some depois de conferido")
            check(await pg.locator("#weblist .song.ok").count()==2, "linhas marcadas como conferidas")
            # toque: entra na lista com rótulo
            await pg.locator("#weblist .song .pick").first.click(); await pg.wait_for_timeout(250)
            fl=await pg.inner_text("#flash")
            check("Fogo Consumidor" in fl and "conferido no Google" in fl and "B" in fl, "toque cadastra com 'tom conferido no Google': "+fl[:80])
            check(await pg.locator("#weblist .song").count()==1, "a versão cadastrada some da lista da internet")
            # 3. tom incerto → confere sozinho
            calls.clear(); await pg.fill("#search","musica incerta"); await pg.wait_for_timeout(1800)
            check(calls==[("musica incerta",False),("musica incerta",True)], f"IA incerta → conferiu sozinho: {calls}")
            ks=await pg.locator("#weblist .song .k").all_inner_texts()
            check(ks==["F♯m"] and not await pg.locator("#webSug").is_hidden(), f"tom conferido F#m com sugestões: {ks}")
            # 4. desconhecida: IA vazia → confere sozinho → Google vazio → mensagem + dica
            calls.clear(); await pg.fill("#search","musica desconhecida"); await pg.wait_for_timeout(1800)
            check(len(calls)==2 and "não trouxe cifra" in await pg.inner_text("#webStatus"), "desconhecida: duas chamadas e mensagem clara → "+await pg.inner_text("#webStatus"))
            check(not await pg.locator("#searchHint").is_hidden(), "dica de cadastro à mão aparece quando nada foi achado")
            # 5. cache por aparelho: repetir não chama de novo
            calls.clear(); await pg.fill("#search",""); await pg.fill("#search","fogo consumidor"); await pg.wait_for_timeout(1200)
            check(calls==[] and await pg.locator("#weblist .song").count()==1, f"cache: sem chamadas, resultado conferido lembrado na sessão: {calls}")
            # 6. erro de limite
            calls.clear(); await pg.fill("#search","erro total"); await pg.wait_for_timeout(1400)
            check("limite de hoje" in await pg.inner_text("#webStatus"), "limite diário explicado → "+await pg.inner_text("#webStatus"))
            await pg.fill("#search","sem chave"); await pg.wait_for_timeout(1400)
            check("chave" in await pg.inner_text("#webStatus"), "sem chave explicado → "+await pg.inner_text("#webStatus"))
            # 7. Enter dispara a busca manual quando há resultado local
            calls.clear(); await pg.fill("#search","dançar na chuva"); await pg.wait_for_timeout(200)
            await pg.fill("#search",""); await pg.fill("#search","lugar secreto"); await pg.press("#search","Enter"); await pg.wait_for_timeout(600)
            check(("lugar secreto",False) in calls, f"Enter pede à IA: {calls}")
            # 8. offline
            off["on"]=True; await ctx.set_offline(True); await pg.fill("#search","outra coisa qualquer"); await pg.wait_for_timeout(1500)
            check("sem internet" in await pg.inner_text("#webStatus"), "offline: "+await pg.inner_text("#webStatus"))
            await ctx.set_offline(False); off["on"]=False
            # 9. palco esconde os botões
            await pg.fill("#search","fogo consumidor"); await pg.wait_for_timeout(300)
            await pg.evaluate("document.body.classList.add('palco')")
            check(await pg.locator("#webTools").is_hidden(), "modo palco esconde os botões da internet")
            await pg.evaluate("document.body.classList.remove('palco')")
            await pg.fill("#search","fogo consumidor"); await pg.wait_for_timeout(400)
            await pg.screenshot(path="shot_web_v25.png")
            # 10. mesma busca em outra página sem rede nenhuma com cache local da IA
            await pg.reload(); await pg.wait_for_timeout(600); calls.clear()
            await pg.fill("#search","dançar na chuva"); await pg.wait_for_timeout(1300)
            check(calls==[] and await pg.locator("#weblist .song").count()==1 and await pg.locator("#btnWebSearch").is_hidden(), f"após recarregar, cache da IA (7 dias) mostra direto, sem nova chamada: {calls}")
            check(await pg.locator("#webSug").is_hidden() and await pg.locator("#weblist .song.ok").count()==0, "resultado conferido não sobrevive ao recarregar (só memória da sessão)")
            print("ERRORS:", errors or "none")
            if errors: fails.append("erros JS")
            await b.close()
    finally: srv.terminate()
    print("\nRESULTADO:", "TUDO OK" if not fails else "FALHAS: "+"; ".join(fails))
asyncio.run(main())
