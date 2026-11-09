/* Atmosfera — motor de áudio em AudioWorklet.
   Tudo que antes era um grafo de ~300 nós do Web Audio (osciladores, ganhos, panners, filtros, chorus, shimmer e
   reverb) roda aqui em dois processadores escritos à mão, em laços simples sobre blocos de 128 amostras:
     - 'atmosfera-voice': um acorde (uníssono de dentes de serra por nota, sub e agudos, LFOs, filtro 24 dB/oit)
     - 'atmosfera-fx': chorus → shimmer → reverb FDN → mistura seco/molhado
   O custo cai para uma fração, e o som para de picotar quando o Chrome fica atrás de outro app. */

var TWO_PI = Math.PI * 2;

/* dente de serra com PolyBLEP: a descontinuidade é suavizada em 2 amostras, o que tira quase todo o aliasing */
function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/* coeficientes RBJ (Audio EQ Cookbook) normalizados por a0; q em dB para passa-baixas/altas, como no Web Audio */
function lowpassCoefs(c, freq, qDb, sr) {
  var f = Math.min(freq, sr * 0.45), w0 = TWO_PI * f / sr, cs = Math.cos(w0), sn = Math.sin(w0);
  var Q = Math.pow(10, qDb / 20), alpha = sn / (2 * Q), a0 = 1 + alpha;
  c[0] = (1 - cs) / 2 / a0; c[1] = (1 - cs) / a0; c[2] = c[0]; c[3] = -2 * cs / a0; c[4] = (1 - alpha) / a0;
}
function highpassCoefs(c, freq, qDb, sr) {
  var w0 = TWO_PI * freq / sr, cs = Math.cos(w0), sn = Math.sin(w0);
  var Q = Math.pow(10, qDb / 20), alpha = sn / (2 * Q), a0 = 1 + alpha;
  c[0] = (1 + cs) / 2 / a0; c[1] = -(1 + cs) / a0; c[2] = c[0]; c[3] = -2 * cs / a0; c[4] = (1 - alpha) / a0;
}
function bandpassCoefs(c, f0, Q, sr) {        // pico constante em 0 dB, Q linear
  var w0 = TWO_PI * f0 / sr, cs = Math.cos(w0), sn = Math.sin(w0), alpha = sn / (2 * Q), a0 = 1 + alpha;
  c[0] = alpha / a0; c[1] = 0; c[2] = -alpha / a0; c[3] = -2 * cs / a0; c[4] = (1 - alpha) / a0;
}
/* biquad em forma direta II transposta; s = [z1, z2] */
function biquad(x, c, s) {
  var y = c[0] * x + s[0];
  s[0] = c[1] * x - c[3] * y + s[1];
  s[1] = c[2] * x - c[4] * y;
  return y;
}
function panGains(p) { var a = (Math.max(-1, Math.min(1, p)) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; }

/* ======================= VOZ ======================= */
class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var o = options.processorOptions, sr = sampleRate, self = this;
    this.sr = sr; this.alive = true; this.stopAt = -1;
    this.cutoff = o.cutoff; this.q = o.q;
    this.fLfoPhase = Math.random(); this.fLfoInc = o.fLfoRate / sr * 128; this.fLfoDepth = o.fLfoDepth;
    this.ampDepth = o.ampDepth; this.vibInc = (o.vibRate || 0) / sr * 128; this.vibDepth = o.vibDepth || 0; this.vibPhase = 0;
    this.width = o.width;
    this.notes = [];
    for (var i = 0; i < o.notes.length; i++) {
      var n = o.notes[i], oscs = [];
      for (var j = 0; j < n.oscs.length; j++) {
        var sp = n.oscs[j];
        oscs.push({ type: sp.type, inc: sp.freq * Math.pow(2, sp.cents / 1200) / sr, phase: Math.random(), gain: sp.gain, pan: sp.pan, gL: 1, gR: 1 });
      }
      this.notes.push({ gain: n.gain, g: n.gain, lfoPhase: Math.random(), lfoInc: n.lfoRate / sr * 128, oscs: oscs });
    }
    this.cL = new Float64Array(5); this.cR = this.cL;
    this.sL1 = [0, 0]; this.sL2 = [0, 0]; this.sR1 = [0, 0]; this.sR2 = [0, 0];
    this.updatePans();
    this.port.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'set') {
        if (m.cutoff != null) self.cutoff = m.cutoff;
        if (m.fLfoDepth != null) self.fLfoDepth = m.fLfoDepth;
        if (m.ampDepth != null) self.ampDepth = m.ampDepth;
        if (m.width != null) { self.width = m.width; self.updatePans(); }
      } else if (m.type === 'stop') { self.stopAt = currentTime + (m.after || 0.2); }
    };
  }
  updatePans() {
    for (var i = 0; i < this.notes.length; i++) {
      var oscs = this.notes[i].oscs;
      for (var j = 0; j < oscs.length; j++) { var g = panGains(oscs[j].pan * this.width); oscs[j].gL = g[0]; oscs[j].gR = g[1]; }
    }
  }
  process(inputs, outputs) {
    if (!this.alive) return false;
    if (this.stopAt >= 0 && currentTime >= this.stopAt) { this.alive = false; return false; }
    var out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, sr = this.sr;
    // por bloco: LFO do filtro, vibrato, LFOs de amplitude
    this.fLfoPhase += this.fLfoInc; if (this.fLfoPhase >= 1) this.fLfoPhase -= 1;
    var cut = this.cutoff * Math.pow(2, this.fLfoDepth * Math.sin(TWO_PI * this.fLfoPhase) / 1200);
    lowpassCoefs(this.cL, cut, this.q, sr);
    var vibMul = 1;
    if (this.vibDepth) { this.vibPhase += this.vibInc; if (this.vibPhase >= 1) this.vibPhase -= 1; vibMul = Math.pow(2, this.vibDepth * Math.sin(TWO_PI * this.vibPhase) / 1200); }
    var notes = this.notes, nn = notes.length;
    for (var k = 0; k < nn; k++) {
      var nt = notes[k]; nt.lfoPhase += nt.lfoInc; if (nt.lfoPhase >= 1) nt.lfoPhase -= 1;
      nt.g = nt.gain * (1 + this.ampDepth * Math.sin(TWO_PI * nt.lfoPhase));
    }
    var c = this.cL, sL1 = this.sL1, sL2 = this.sL2, sR1 = this.sR1, sR2 = this.sR2;
    for (var i = 0; i < n; i++) {
      var xl = 0, xr = 0;
      for (k = 0; k < nn; k++) {
        nt = notes[k]; var oscs = nt.oscs, al = 0, ar = 0;
        for (var j = 0; j < oscs.length; j++) {
          var o = oscs[j], t = o.phase, dt = o.inc * vibMul, s;
          if (o.type === 0) { s = 2 * t - 1 - polyblep(t, dt); }
          else if (o.type === 1) { s = 4 * Math.abs(t - 0.5) - 1; }
          else { s = Math.sin(TWO_PI * t); }
          t += dt; if (t >= 1) t -= 1; o.phase = t;
          s *= o.gain; al += s * o.gL; ar += s * o.gR;
        }
        xl += al * nt.g; xr += ar * nt.g;
      }
      L[i] = biquad(biquad(xl, c, sL1), c, sL2);
      R[i] = biquad(biquad(xr, c, sR1), c, sR2);
    }
    return true;
  }
}

/* ======================= EFEITOS ======================= */
class FxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var o = options.processorOptions, sr = sampleRate, self = this;
    this.sr = sr;
    // --- chorus (duas linhas moduladas, abertas em estéreo) ---
    var ch = o.chorus; this.ch = ch;
    this.chSize = 8192; this.chBufL = new Float32Array(this.chSize); this.chBufR = new Float32Array(this.chSize); this.chW = 0;
    this.chPhL = 0; this.chPhR = 0.25; this.chIncL = ch.rateL / sr; this.chIncR = ch.rateR / sr;
    // --- shimmer (deslocador granular, oitava acima) ---
    this.shSize = 32768; this.shBuf = new Float32Array(this.shSize); this.shW = 0;
    var F = 8, T = 1 / F; this.shInc = F / sr; this.shPh = 0; this.shG = -(2 - 1) * T / 2; this.shD0 = Math.abs(this.shG) + 0.004;
    this.hpC = new Float64Array(5); highpassCoefs(this.hpC, 150, -3, sr); this.hpS = [0, 0];
    this.revMono = 0;
    // --- pré-delay ---
    this.preSize = Math.ceil(0.05 * sr) + 1; this.preL = new Float32Array(this.preSize); this.preR = new Float32Array(this.preSize); this.preW = 0; this.preLen = Math.round(0.04 * sr);
    // --- reverb FDN ---
    var fd = o.fdn, N = fd.N; this.N = N; this.lines = [];
    var bp = new Float64Array(5); bandpassCoefs(bp, Math.sqrt(fd.floor * fd.damp), Math.sqrt(fd.floor * fd.damp) / (fd.damp - fd.floor), sr); this.bpC = bp;
    for (var i = 0; i < N; i++) {
      var len = Math.round(fd.minLen * Math.pow(fd.maxLen / fd.minLen, i / (N - 1)) * sr * (1 + 0.013 * Math.sin(i * 7.3)));
      this.lines.push({ len: len, buf: new Float32Array(len), w: 0, s: [0, 0], g: Math.pow(10, -3 * (len / sr) / fd.rt60),
        tL: (i % 2 ? -1 : 1) * fd.outGain * (0.55 + 0.45 * Math.abs(Math.sin(i * 2.1 + 0.7))),
        tR: ((i >> 1) % 2 ? -1 : 1) * fd.outGain * (0.55 + 0.45 * Math.abs(Math.cos(i * 1.7 + 0.3))) });
    }
    this.fdnIn = fd.inGain; this.y = new Float64Array(N); this.z = new Float64Array(N);
    // --- mistura ---
    this.setParams(o);
    this.port.onmessage = function (e) { if (e.data.type === 'set') self.setParams(e.data); };
  }
  setParams(p) {
    if (p.width != null) {
      var w = p.width; this.chWet = w * 0.9; this.chDry = 1 - 0.35 * w;
      var gl = panGains(-(0.25 + 0.75 * w)), gr = panGains(0.25 + 0.75 * w);
      this.pLL = gl[0]; this.pLR = gl[1]; this.pRL = gr[0]; this.pRR = gr[1];
    }
    if (p.reverb != null) { var r = p.reverb; this.rvDry = 1 - 0.55 * r; this.rvWet = 1.15 * r; this.reverb = r; }
    if (p.shimmer != null) this.shimmer = p.shimmer;
    if (p.shimFbBase != null) this.shimFbBase = p.shimFbBase;
    var sg = (this.shimmer || 0) * (0.8 + (this.reverb || 0));
    this.shimG = sg; this.shimFb = this.shimmer > 0 ? (this.shimFbBase || 0) * (0.6 + 0.4 * (this.reverb || 0)) / Math.max(1, sg) : 0;
  }
  readInterp(buf, size, w, delaySamples) {
    var pos = w - delaySamples; while (pos < 0) pos += size;
    var i0 = Math.floor(pos), fr = pos - i0, i1 = i0 + 1; if (i0 >= size) i0 -= size; if (i1 >= size) i1 -= size;
    return buf[i0] + (buf[i1] - buf[i0]) * fr;
  }
  process(inputs, outputs) {
    var inp = inputs[0], out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length, sr = this.sr;
    var inL = inp && inp[0] ? inp[0] : null, inR = inp && inp[1] ? inp[1] : inL;
    var ch = this.ch, chSize = this.chSize, chBufL = this.chBufL, chBufR = this.chBufR;
    var lines = this.lines, N = this.N, y = this.y, z = this.z, bp = this.bpC, two_N = 2 / N;
    var shBuf = this.shBuf, shSize = this.shSize, hpC = this.hpC, hpS = this.hpS;
    var preL = this.preL, preR = this.preR, preSize = this.preSize, preLen = this.preLen;
    for (var i = 0; i < n; i++) {
      var xL = inL ? inL[i] : 0, xR = inR ? inR[i] : 0, xm = 0.5 * (xL + xR);
      // chorus
      chBufL[this.chW] = xm; chBufR[this.chW] = xm;
      this.chPhL += this.chIncL; if (this.chPhL >= 1) this.chPhL -= 1;
      this.chPhR += this.chIncR; if (this.chPhR >= 1) this.chPhR -= 1;
      var dL = this.readInterp(chBufL, chSize, this.chW, (ch.baseL + ch.depthL * Math.sin(TWO_PI * this.chPhL)) * sr);
      var dR = this.readInterp(chBufR, chSize, this.chW, (ch.baseR + ch.depthR * Math.sin(TWO_PI * this.chPhR)) * sr);
      this.chW++; if (this.chW >= chSize) this.chW = 0;
      var fxL = this.chDry * xL + this.chWet * (dL * this.pLL + dR * this.pRL);
      var fxR = this.chDry * xR + this.chWet * (dL * this.pLR + dR * this.pRR);
      // shimmer: entrada = passa-altas(fx) + realimentação da cauda; duas janelas que se revezam lendo uma rampa
      var shIn = biquad(0.5 * (fxL + fxR), hpC, hpS) + this.shimFb * this.revMono;
      shBuf[this.shW] = shIn;
      this.shPh += this.shInc; if (this.shPh >= 1) this.shPh -= 1;
      var pA = this.shPh, pB = pA + 0.5; if (pB >= 1) pB -= 1;
      var sh = (0.5 - 0.5 * Math.cos(TWO_PI * pA)) * this.readInterp(shBuf, shSize, this.shW, (this.shD0 + this.shG * (2 * pA - 1)) * sr)
             + (0.5 - 0.5 * Math.cos(TWO_PI * pB)) * this.readInterp(shBuf, shSize, this.shW, (this.shD0 + this.shG * (2 * pB - 1)) * sr);
      this.shW++; if (this.shW >= shSize) this.shW = 0;
      sh *= this.shimG;
      // pré-delay (fx + shimmer) → FDN
      preL[this.preW] = fxL + sh; preR[this.preW] = fxR + sh;
      var rp = this.preW - preLen; if (rp < 0) rp += preSize;
      var rvInL = preL[rp] * this.fdnIn, rvInR = preR[rp] * this.fdnIn;
      this.preW++; if (this.preW >= preSize) this.preW = 0;
      var S = 0, revL = 0, revR = 0, k, ln;
      for (k = 0; k < N; k++) {
        ln = lines[k]; var yk = ln.buf[ln.w]; y[k] = yk;
        var zk = biquad(yk, bp, ln.s) * ln.g; z[k] = zk; S += zk;
        revL += ln.tL * yk; revR += ln.tR * yk;
      }
      var mix = two_N * S;
      for (k = 0; k < N; k++) {
        ln = lines[k];
        ln.buf[ln.w] = (k % 2 ? rvInR : rvInL) + z[k] - mix;
        ln.w++; if (ln.w >= ln.len) ln.w = 0;
      }
      this.revMono = 0.5 * (revL + revR);
      L[i] = this.rvDry * fxL + this.rvWet * revL;
      R[i] = this.rvDry * fxR + this.rvWet * revR;
    }
    return true;
  }
}

registerProcessor('atmosfera-voice', VoiceProcessor);
registerProcessor('atmosfera-fx', FxProcessor);
