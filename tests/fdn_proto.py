"""Protótipo do reverb FDN: mede resposta ao impulso (energia, RT60, densidade) num OfflineAudioContext
para calibrar ganho de entrada e tempo de decaimento antes de integrar no app."""
import asyncio, json, subprocess, sys, time
from playwright.async_api import async_playwright

PORT = 8782
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FDN_JS = r"""
function makeFDN(c, opt){
  var N=opt.N||8, lens=opt.lens;
  if(!lens){ lens=[]; for(var q=0;q<N;q++){ var r=opt.minLen*Math.pow(opt.maxLen/opt.minLen, q/(N-1)); lens.push(Math.round(r*48000*(1+0.013*Math.sin(q*7.3)))/48000); } }
  var rt60=opt.rt60, damp=opt.damp, inGain=opt.inGain, mod=opt.mod;
  var input=c.createGain(); input.gain.value=inGain;
  var pre=c.createDelay(0.3); pre.delayTime.value=opt.pre; input.connect(pre);
  var stage=pre;
  if(opt.allpass){ var apLens=[0.0051,0.0127,0.0229]; for(var a=0;a<apLens.length;a++){
      var ff=c.createGain(); ff.gain.value=-0.5; var fb=c.createGain(); fb.gain.value=0.5; var ad=c.createDelay(0.1); ad.delayTime.value=apLens[a]; var sum=c.createGain();
      stage.connect(ff); ff.connect(sum); stage.connect(ad); ad.connect(sum); sum.connect(fb); fb.connect(ad);   // laço com DelayNode
      stage=sum; } }
  var split=c.createChannelSplitter(2); stage.connect(split);
  var merge=c.createChannelMerger(2); var outL=c.createGain(), outR=c.createGain(); outL.connect(merge,0,0); outR.connect(merge,0,1);
  var S=c.createGain(); S.gain.value=1; var M=c.createGain(); M.gain.value=-2/N; S.connect(M);
  var signsL=[], signsR=[]; for(var q=0;q<N;q++){ signsL.push(q%2?-1:1); signsR.push((q>>1)%2?-1:1); }
  var lfoRates=[0.13,0.17,0.23], t0=c.currentTime+0.01;
  for(var i=0;i<N;i++){
    var d=c.createDelay(0.5); d.delayTime.value=lens[i];
    var lp=c.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=damp; lp.Q.value=-6;
    var g=c.createGain(); g.gain.value=Math.pow(10, -3*lens[i]/rt60);
    d.connect(lp); lp.connect(g);
    g.connect(d); g.connect(S); M.connect(d);           // y_i*g − (2/N)·Σ → Householder
    split.connect(d, i<N/2 ? 0 : 1);                     // esquerda nas 4 primeiras, direita nas 4 últimas
    var wl = opt.randOut ? (0.55+0.45*Math.abs(Math.sin(i*2.1+0.7))) : 1, wr = opt.randOut ? (0.55+0.45*Math.abs(Math.cos(i*1.7+0.3))) : 1;
    var tl=c.createGain(); tl.gain.value=signsL[i]*opt.outGain*wl; d.connect(tl); tl.connect(outL);
    var tr=c.createGain(); tr.gain.value=signsR[i]*opt.outGain*wr; d.connect(tr); tr.connect(outR);
    if(mod && i%3===1){ var lfo=c.createOscillator(); lfo.frequency.value=lfoRates[((i/3)|0)%3]*(1+0.1*((i/9)|0)); var lg=c.createGain(); lg.gain.value=mod; lfo.connect(lg); lg.connect(d.delayTime); lfo.start(t0); }
  }
  return {input:input, output:merge};
}
"""

MEASURE = r"""
async (opt) => {
""" + FDN_JS + r"""
  const sr=48000, dur=14, c=new OfflineAudioContext(2, sr*dur, sr);
  let fdn;
  if(opt.conv){ const seconds=opt.conv, len=Math.floor(sr*seconds), ir=c.createBuffer(2,len,sr);
    for(let ch=0;ch<2;ch++){ const dch=ir.getChannelData(ch); let lp=0; for(let i=0;i<len;i++){ const t=i/len; const a=0.6*(1-t)+0.08; lp+=a*((Math.random()*2-1)-lp); const env=Math.exp(-6.2*t)*(t<0.012?t/0.012:1)*(1+0.6*Math.exp(-t*18)); dch[i]=lp*env; } }
    let en=0; for(let ch=0;ch<2;ch++){ const dch=ir.getChannelData(ch); for(let i=0;i<len;i++) en+=dch[i]*dch[i]; } const norm=0.9/Math.sqrt(en/2); for(let ch=0;ch<2;ch++){ const dch=ir.getChannelData(ch); for(let i=0;i<len;i++) dch[i]*=norm; }
    const cv=c.createConvolver(); cv.buffer=ir; const g=c.createGain(); g.gain.value=1; g.connect(cv); fdn={input:g, output:cv}; }
  else fdn=makeFDN(c, opt);
  // impulso estéreo
  const buf=c.createBuffer(2, 128, sr); buf.getChannelData(0)[0]=1; buf.getChannelData(1)[0]=1;
  const src=c.createBufferSource(); src.buffer=buf; src.connect(fdn.input); fdn.output.connect(c.destination); src.start(0);
  const out=await c.startRendering(); const L=out.getChannelData(0), R=out.getChannelData(1);
  let e=0; for(let i=0;i<L.length;i++) e+=0.5*(L[i]*L[i]+R[i]*R[i]);
  // envelope em janelas de 100 ms → RT60 por regressão entre -5 e -35 dB
  const w=Math.floor(0.1*sr); const env=[]; for(let s=0;s+w<L.length;s+=w){ let ee=0; for(let i=s;i<s+w;i++) ee+=0.5*(L[i]*L[i]+R[i]*R[i]); env.push(10*Math.log10(ee/w+1e-30)); }
  const peak=Math.max(...env); const pts=[]; for(let k=0;k<env.length;k++){ const rel=env[k]-peak; if(rel<-5 && rel>-35) pts.push([k*0.1, rel]); }
  let n=pts.length, sx=0, sy=0, sxx=0, sxy=0; for(const [x,y] of pts){ sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; }
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx); const rt60=-60/slope;
  // densidade de ecos: fração de amostras não-nulas por janela, nos primeiros 300 ms; e pico máximo após 1 s (flutter)
  let nz=0, tot=0; for(let i=Math.floor(0.1*sr); i<Math.floor(0.3*sr); i++){ tot++; if(Math.abs(L[i])>1e-4) nz++; }
  // uniformidade da resposta em regime: FFT de 2^19 (0,09 Hz) do IR inteiro, potência suavizada em 20 Hz, desvio em dB (100–2000 Hz)
  function fft(re, im){ const n=re.length; for(let i=1,j=0;i<n;i++){ let bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit; if(i<j){ let t=re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; } }
    for(let len=2;len<=n;len<<=1){ const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang); for(let i=0;i<n;i+=len){ let cr=1, ci=0; for(let j=0;j<len/2;j++){ const ur=re[i+j], ui=im[i+j], vr=re[i+j+len/2]*cr-im[i+j+len/2]*ci, vi=re[i+j+len/2]*ci+im[i+j+len/2]*cr; re[i+j]=ur+vr; im[i+j]=ui+vi; re[i+j+len/2]=ur-vr; im[i+j+len/2]=ui-vi; const ncr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=ncr; } } } }
  const NF=524288, re=new Float64Array(NF), im=new Float64Array(NF); for(let i=0;i<Math.min(NF,L.length);i++) re[i]=L[i];
  fft(re,im); const binHz=sr/NF, sm=Math.round(20/binHz); const pw=new Float64Array(NF/2); for(let b=0;b<NF/2;b++) pw[b]=re[b]*re[b]+im[b]*im[b];
  const vals=[]; let run=0; for(let b=0;b<NF/2;b++){ run+=pw[b]; if(b>=sm) run-=pw[b-sm]; const f=b*binHz; if(f>=100 && f<=2000 && b>=sm) vals.push(10*Math.log10(run/sm+1e-30)); }
  const mu=vals.reduce((a,b)=>a+b,0)/vals.length; let va=0; for(const v of vals) va+=(v-mu)*(v-mu); const flat=Math.sqrt(va/vals.length);
  // também a largura de banda de 100 Hz (como o ouvido integra no médio)
  const sm2=Math.round(100/binHz); const vals2=[]; run=0; for(let b=0;b<NF/2;b++){ run+=pw[b]; if(b>=sm2) run-=pw[b-sm2]; const f=b*binHz; if(f>=300 && f<=3000 && b>=sm2) vals2.push(10*Math.log10(run/sm2+1e-30)); }
  const mu2=vals2.reduce((a,b)=>a+b,0)/vals2.length; let va2=0; for(const v of vals2) va2+=(v-mu2)*(v-mu2); const unev100=Math.sqrt(va2/vals2.length);
  // correlação L/R (largura)
  let lr=0, ll=0, rr=0; for(let i=sr;i<4*sr;i++){ lr+=L[i]*R[i]; ll+=L[i]*L[i]; rr+=R[i]*R[i]; }
  return {energy:e, rt60:rt60, density:nz/tot, unev20Hz_dB:flat, unev100Hz_dB:unev100, lrCorr:lr/Math.sqrt(ll*rr)};
}
"""

async def main():
    srv = subprocess.Popen(["python3","-m","http.server",str(PORT),"--bind","127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch(); pg = await b.new_page()
            await pg.goto(f"http://localhost:{PORT}/index.html")
            for opt in json.loads(sys.argv[1]):
                r = await pg.evaluate(MEASURE, opt)
                print(json.dumps(opt), "→", {k:(round(v,3) if isinstance(v,float) else v) for k,v in r.items()})
            await b.close()
    finally:
        srv.terminate()

asyncio.run(main())
