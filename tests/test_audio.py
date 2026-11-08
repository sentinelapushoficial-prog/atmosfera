"""Mede o motor de áudio num OfflineAudioContext: perfil do fade-in (deve ser ~linear em dB),
ondulação do nível em regime (deve ser < 1 dB) e fade-out. Sem placa de som: tudo é renderizado offline."""
import asyncio, json, subprocess, sys, time
from playwright.async_api import async_playwright

import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8773
SR = 48000
TOTAL = 42           # s renderizados
FADE = 10            # fadeIn padrão
STOP_AT = 28         # quando "Parar com fade" é acionado

INIT = """
(function(){
  var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  window.__offline = null;
  window.AudioContext = function(opts){
    var c = new Off(2, %d*%d, %d);
    window.__offline = c;
    return c;
  };
  window.webkitAudioContext = window.AudioContext;
})();
""" % (SR, TOTAL, SR)

ANALYZE = """
async (args) => {
  const c = window.__offline;
  const stopAt = args.stopAt, win = args.win;
  // "Parar com fade" no meio da renderização
  c.suspend(stopAt).then(() => { document.getElementById(args.stopBtn).click(); c.resume(); });
  const buf = await c.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1), sr = buf.sampleRate;
  const n = Math.floor(win*sr), frames = Math.floor(L.length/n), out = [], outL = [];
  let peak = 0;
  for (let w = 0; w < frames; w++) {
    let s = 0, sl = 0;
    for (let i = w*n; i < (w+1)*n; i++) { const m = 0.5*(L[i]+R[i]); s += m*m; sl += L[i]*L[i]; const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > peak) peak = a; }
    const rms = Math.sqrt(s/n), rmsL = Math.sqrt(sl/n);
    out.push(rms > 0 ? 20*Math.log10(rms) : -120); outL.push(rmsL > 0 ? 20*Math.log10(rmsL) : -120);
  }
  let pk=0, e=0, cnt=0; for (let i=Math.floor(16*sr); i<Math.floor(26*sr); i++){ const m=0.5*(L[i]+R[i]); pk=Math.max(pk,Math.abs(m)); e+=m*m; cnt++; }
  const crest = 20*Math.log10(pk/Math.sqrt(e/cnt));
  // FFT de 32768 pontos (janela Hann) sobre o regime: centroide e energia por faixa
  function fft(re, im){ const n=re.length; for(let i=1,j=0;i<n;i++){ let bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit; if(i<j){ let t=re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; } }
    for(let len=2;len<=n;len<<=1){ const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang); for(let i=0;i<n;i+=len){ let cr=1, ci=0; for(let j=0;j<len/2;j++){ const ur=re[i+j], ui=im[i+j], vr=re[i+j+len/2]*cr-im[i+j+len/2]*ci, vi=re[i+j+len/2]*ci+im[i+j+len/2]*cr; re[i+j]=ur+vr; im[i+j]=ui+vi; re[i+j+len/2]=ur-vr; im[i+j+len/2]=ui-vi; const ncr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=ncr; } } } }
  const NF=32768, off=Math.floor(20*sr), re=new Float64Array(NF), im=new Float64Array(NF);
  for(let i=0;i<NF;i++){ const wnd=0.5-0.5*Math.cos(2*Math.PI*i/NF); re[i]=0.5*(L[off+i]+R[off+i])*wnd; }
  fft(re, im);
  let num=0, den=0, eLow=0, eMid=0, eHigh=0; const binHz=sr/NF;
  for(let b=1;b<NF/2;b++){ const f=b*binHz, p=re[b]*re[b]+im[b]*im[b]; num+=f*p; den+=p; if(f<250) eLow+=p; else if(f<1000) eMid+=p; else eHigh+=p; }
  const centroid=num/den, tot=eLow+eMid+eHigh;
  return {db: out, dbL: outL, peak: peak, sr: sr, crest: crest, centroid: centroid, low: eLow/tot, mid: eMid/tot, high: eHigh/tot};
}
"""

def fmt(x): return ("%.1f" % x).replace("-", "−")

async def set_slider(pg, sid, val):
    await pg.evaluate("([id,v]) => { var i=document.getElementById('sl-'+id); i.value=v; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); }", [sid, val])

async def measure(pg, preset, mode, win=0.25, worst=False):
    await pg.click(f".chip[data-preset={preset}]")
    if worst:
        for sid, val in (("volume", 1), ("bright", 1), ("reverb", 1), ("width", 1)): await set_slider(pg, sid, val)
    await pg.click(f"#modes button[data-mode={mode}]")
    await pg.click('.key[data-pc="0"]')   # Dó: cria o contexto (offline) e agenda o fade-in a partir de t=0
    await pg.wait_for_timeout(50)
    res = await pg.evaluate(ANALYZE, {"stopAt": STOP_AT, "win": win, "stopBtn": "btnStop"})
    return res

async def main():
    srv = subprocess.Popen(["python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    fails = []
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            for preset, mode, worst in [("piano","aberto",False), ("piano","maior",False), ("piano","menor",False), ("cristal","maior",False), ("cordas","menor",False), ("profundo","aberto",False), ("piano","maior",True), ("cristal","aberto",True)]:
                ctx = await b.new_context(viewport={"width": 390, "height": 844})
                pg = await ctx.new_page()
                errors = []
                pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
                pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" and "ERR_" not in m.text and "fonts" not in m.text and "503" not in m.text else None)
                await pg.add_init_script(INIT)
                await pg.goto(f"http://localhost:{PORT}/index.html"); await pg.wait_for_timeout(500)
                res = await measure(pg, preset, mode, worst=worst)
                db = res["db"]; win = 0.25
                def at(t): return db[int(t/win)]
                steady = db[int(14/win):int(STOP_AT/win)-2]
                ref = max(steady)
                ripple = max(steady) - min(steady)
                steadyL = res["dbL"][int(14/win):int(STOP_AT/win)-2]
                rippleL = max(steadyL) - min(steadyL)
                # perfil do fade-in em relação ao nível de regime
                prof = {t: at(t) - ref for t in (1, 2.5, 5, 7.5, 9, 10, 12)}
                # a subida deve ser monotônica (tolerância 0.3 dB) entre 0,5 s e 10 s
                rise = db[int(0.5/win):int(FADE/win)]
                nonmono = sum(1 for i in range(1, len(rise)) if rise[i] < rise[i-1] - 0.3)
                # fade-out: cai de forma monotônica depois de STOP_AT (tolerância 0.5 dB), e some em ~FADE s + cauda
                fall = db[int((STOP_AT+0.5)/win):int((STOP_AT+FADE)/win)]
                nonmono_fall = sum(1 for i in range(1, len(fall)) if fall[i] > fall[i-1] + 0.5)
                tail = at(STOP_AT + FADE + 3) - ref
                print(f"\n== {preset} / {mode}{' / tudo no máximo' if worst else ''} ==  regime {fmt(ref)} dBFS (rms), pico {fmt(20*__import__('math').log10(res['peak']))} dBFS, fator de crista {fmt(res['crest'])} dB, centroide {res['centroid']:.0f} Hz, energia <250 Hz {res['low']*100:.0f}% · 250–1k {res['mid']*100:.0f}% · >1k {res['high']*100:.0f}%")
                print("  fade-in (dB rel. regime):", "  ".join(f"{t}s:{fmt(v)}" for t, v in prof.items()))
                print(f"  ondulação em regime (14–{STOP_AT} s, janelas de 250 ms): mono {fmt(ripple)} dB · canal L {fmt(rippleL)} dB | quedas na subida: {nonmono} | subidas na descida: {nonmono_fall} | 3 s após o fim do fade-out: {fmt(tail)} dB")
                if errors: print("  ERROS:", errors)
                lim = 2.5 if worst else 1.0
                if ripple > lim: fails.append(f"{preset}/{mode}: ondulação {ripple:.2f} dB")
                if rippleL > lim+0.5: fails.append(f"{preset}/{mode}: ondulação no canal L {rippleL:.2f} dB")
                if nonmono > (6 if worst else 2): fails.append(f"{preset}/{mode}: subida não monotônica ({nonmono})")
                if nonmono_fall > 2: fails.append(f"{preset}/{mode}: descida não monotônica ({nonmono_fall})")
                if res["peak"] > 0.98: fails.append(f"{preset}/{mode}: clipping (pico {res['peak']:.3f})")
                if not (-32 < prof[5] < -16): fails.append(f"{preset}/{mode}: fade-in em 5 s = {prof[5]:.1f} dB (esperado ≈ −25)")
                if prof[2.5] > -34: fails.append(f"{preset}/{mode}: fade-in em 2,5 s alto demais ({prof[2.5]:.1f} dB)")
                if tail > -40: fails.append(f"{preset}/{mode}: fade-out não terminou ({tail:.1f} dB)")
                if errors: fails.append(f"{preset}/{mode}: erros JS {errors}")
                await ctx.close()
            await b.close()
    finally:
        srv.terminate()
    print("\nRESULTADO:", "OK" if not fails else "FALHAS:\n  " + "\n  ".join(fails))
    return 0 if not fails else 1

sys.exit(asyncio.run(main()))
