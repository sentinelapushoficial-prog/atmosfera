"""Confere o deslocador de altura (shimmer) isoladamente: seno de 220 Hz deve sair ≈ 440 Hz; e a dente de serra
do navegador sobe (convenção da especificação) — a janela em cosseno depende disso."""
import asyncio, re, subprocess, sys, time
from playwright.async_api import async_playwright

import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8775

src = open(f"{ROOT}/index.html", encoding="utf-8").read()
m = re.search(r"function makeShifter\(c, ratio, t0\)\{.*?\n\}\n", src, re.S)
SHIFTER = m.group(0)

JS = """
async () => {
""" + SHIFTER + """
  const sr = 48000, dur = 4;
  const c = new OfflineAudioContext(1, sr*dur, sr);
  // 1) sentido da dente de serra
  const c2 = new OfflineAudioContext(1, 4800, sr);
  const s = c2.createOscillator(); s.type='sawtooth'; s.frequency.value=100; s.connect(c2.destination); s.start(0);
  const b2 = await c2.startRendering(); const d2 = b2.getChannelData(0);
  const sawRising = d2[100] > d2[10] && d2[200] > d2[100];
  // 2) shifter
  const sh = makeShifter(c, 2, 0.01);
  const o = c.createOscillator(); o.type='sine'; o.frequency.value=220; o.connect(sh.input); sh.output.connect(c.destination); o.start(0);
  const b = await c.startRendering(); const d = b.getChannelData(0);
  function goertzel(f){ const N = sr*2, off = sr*1.5; let s0=0,s1=0,s2=0; const w=2*Math.PI*f/sr, cw=2*Math.cos(w); for(let i=0;i<N;i++){ s0 = d[off+i] + cw*s1 - s2; s2=s1; s1=s0; } return Math.sqrt(s1*s1 + s2*s2 - cw*s1*s2)/N*2; }
  const a220 = goertzel(220), a440 = goertzel(440), a880 = goertzel(880), a432 = goertzel(432), a448 = goertzel(448);
  // espectro grosso: DFT de 1 s a cada 2 Hz entre 100 e 1400 Hz, top 8
  const N1 = sr, off1 = sr*2; const spec=[];
  for (let f=100; f<=1400; f+=2){ let re=0, im=0; const w=2*Math.PI*f/sr; for(let i=0;i<N1;i+=4){ re += d[off1+i]*Math.cos(w*i); im -= d[off1+i]*Math.sin(w*i); } spec.push([f, Math.sqrt(re*re+im*im)/(N1/4)*2]); }
  spec.sort((a,b)=>b[1]-a[1]);
  const top = spec.slice(0,8).map(x=>x[0]+'Hz:'+x[1].toFixed(3));
  function band(lo,hi){ let e=0; for(const [f,a] of spec) if(f>=lo && f<=hi) e+=a*a; return e; }
  const eOct = band(420,460), eIn = band(212,228), eTot = band(100,1400);
  let peak=0; for (let i=sr; i<d.length; i++) peak=Math.max(peak, Math.abs(d[i]));
  // nível por janelas de 50 ms (tremor dos grãos)
  const win=Math.floor(sr*0.05); const lv=[]; for(let w=sr*1.5; w+win<d.length; w+=win){ let e=0; for(let i=w;i<w+win;i++) e+=d[i]*d[i]; lv.push(10*Math.log10(e/win)); }
  return {top, octShare: eOct/eTot, inShare: eIn/eTot, sawRising, a220, a440, a880, a432, a448, peak, flutterDb: Math.max(...lv)-Math.min(...lv)};
}
"""

async def main():
    srv = subprocess.Popen(["python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch()
            pg = await b.new_page()
            await pg.goto(f"http://localhost:{PORT}/index.html")
            r = await pg.evaluate(JS)
            print(r)
            ok = r["sawRising"] and r["octShare"] > 0.9 and r["inShare"] < 0.01
            print("RESULTADO:", "OK" if ok else "FALHA")
            await b.close()
    finally:
        srv.terminate()
    return 0

sys.exit(asyncio.run(main()))
