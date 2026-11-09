import asyncio, subprocess, time, urllib.parse
from playwright.async_api import async_playwright
ROOT="/home/claude/atmosfera-repo"; PORT=8772
async def main():
    srv=subprocess.Popen(["python3","-m","http.server",str(PORT),"--bind","127.0.0.1"],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
    try:
        async with async_playwright() as pw:
            b=await pw.chromium.launch(); ctx=await b.new_context(viewport={"width":390,"height":844}); pg=await ctx.new_page()
            errors=[]; pg.on("pageerror", lambda e: errors.append(str(e)))
            await pg.goto(f"http://localhost:{PORT}/index.html"); await pg.wait_for_timeout(600)
            print("versão:", await pg.inner_text("#version"))
            print("elementos antigos removidos:", await pg.locator("#webBlock").count()==0 and await pg.locator("#lookupSetup").count()==0)
            async def sug(q, wait=150):
                await pg.fill("#search", q); await pg.wait_for_timeout(wait)
                ts=await pg.locator("#suglist .song .t").all_inner_texts(); ks=await pg.locator("#suglist .song .k").all_inner_texts()
                whys=await pg.locator("#suglist .song .why").all_inner_texts()
                return list(zip(ts,ks)), whys
            # 1. nome sem acento / cedilha
            r,w=await sug("dancar na chuva"); print("1 nome:", r[:3], "| trecho exibido:", w[:1])
            # 2. trecho da letra (não é o título)
            r,w=await sug("eu vou dançar na chuva"); print("2 letra:", r[:2], "| trecho:", w[:1])
            r,w=await sug("a sarça pegou fogo"); print("3 letra Me Atraiu:", r[:2], "| trecho:", w[:1])
            r,w=await sug("que deixa noventa e nove"); print("4 letra Ousado Amor:", r[:4])
            r,w=await sug("mais que o ar que eu respiro"); print("5 letra Preciso de Ti:", r[:2], "| trecho:", w[:1])
            r,w=await sug("minha alma engrandece"); print("6 apóstrofo:", r[:2])
            # 3. erro de digitação
            r,w=await sug("galieu"); print("7 typo galieu (já no repertório):", await pg.locator("#setlist .song .t").all_inner_texts(), r[:2])
            r,w=await sug("lugar secerto"); print("8 typo secerto:", r[:2])
            r,w=await sug("ousadu amor"); print("9 typo ousadu:", r[:3])
            # 4. ordem das palavras e artista
            r,w=await sug("chuva dançar"); print("10 ordem invertida:", r[:2])
            r,w=await sug("gabriela rocha"); print("11 artista:", r[:4])
            r,w=await sug("fernandinho santo"); print("12 artista+nome:", r[:3])
            # 5. autocompletar
            r,w=await sug("ocea"); print("13 prefixo:", r[:3])
            r,w=await sug("bond"); print("14 prefixo bond:", r[:2])
            # 6. nada encontrado: links
            r,w=await sug("xyzabc qwerty");
            print("15 vazio:", r, "| empty:", await pg.locator("#setlist .empty").inner_text())
            print("   links:", await pg.get_attribute("#lnkCifra","href"), await pg.get_attribute("#lnkLetras","href"), "| hint visível:", not await pg.locator("#searchHint").is_hidden())
            # 7. um toque põe na lista; depois some das sugestões e passa a ser achada pela letra no repertório
            await sug("eu vou dançar na chuva"); await pg.locator("#suglist .song .pick").first.click(); await pg.wait_for_timeout(200)
            print("16 flash:", (await pg.inner_text("#flash"))[:90])
            await pg.fill("#search","vou dançar naquela terra"); await pg.wait_for_timeout(150)
            print("   repertório acha pela letra:", await pg.locator("#setlist .song .t").all_inner_texts(), "| sugestões:", await pg.locator("#suglist .song .t").all_inner_texts()[:2] if False else await pg.locator("#suglist .song").count())
            # 8. compartilhamento (share target)
            q=urllib.parse.urlencode({"share_title":"DANÇAR NA CHUVA - Fernandinho - Cifra Club","share_text":"https://www.cifraclub.com.br/fernandinho/dancar-na-chuva/","share_url":"https://www.cifraclub.com.br/fernandinho/dancar-na-chuva/"})
            await pg.goto(f"http://localhost:{PORT}/index.html?{q}"); await pg.wait_for_timeout(700)
            print("17 share:", repr(await pg.input_value("#addTitle")), repr(await pg.input_value("#addArtist")), await pg.input_value("#addKey"), await pg.input_value("#addMode"), "| nota:", (await pg.inner_text("#shareNoteText"))[:70], "| url limpa:", pg.url.endswith("index.html"))
            q=urllib.parse.urlencode({"share_title":"Letra de Lugar Secreto - Gabriela Rocha - LETRAS.MUS.BR","share_url":"https://www.letras.mus.br/gabriela-rocha/lugar-secreto/"})
            await pg.goto(f"http://localhost:{PORT}/index.html?{q}"); await pg.wait_for_timeout(500)
            print("18 share letras:", repr(await pg.input_value("#addTitle")), repr(await pg.input_value("#addArtist")), await pg.input_value("#addKey"))
            q=urllib.parse.urlencode({"share_title":"Isaías Saad - Bondade de Deus (Ao Vivo)","share_url":"https://youtu.be/abc"})
            await pg.goto(f"http://localhost:{PORT}/index.html?{q}"); await pg.wait_for_timeout(500)
            print("19 share youtube:", repr(await pg.input_value("#addTitle")), repr(await pg.input_value("#addArtist")))
            await pg.click("#btnSwapTA"); print("   swap:", repr(await pg.input_value("#addTitle")), repr(await pg.input_value("#addArtist")))
            await pg.fill("#search","eu vou dançar"); await pg.wait_for_timeout(200)
            await pg.screenshot(path="shot_search_v24.png")
            print("ERRORS:", errors or "none")
            await b.close()
    finally: srv.terminate()
asyncio.run(main())
