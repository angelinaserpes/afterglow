/* Afterglow — particle engine.
   One WebGL points program. Every shape (sculpture, orb, galaxy, dust, garden, ring)
   is a position + colour buffer of the same N particles; scrolling morphs between them. */
(function () {
  'use strict';
  const AG = (window.AG = window.AG || {});
  const S = (AG.S = 240);   // time slices per sculpture
  const B = (AG.B = 16);    // frequency bands per slice
  const reduced = (AG.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 700;
  const N = (AG.N = coarse || small ? 24000 : (navigator.hardwareConcurrency || 8) <= 4 ? 44000 : 72000);

  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  AG.rng = mulberry;
  const R = mulberry(7);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  AG.clamp = clamp; AG.lerp = lerp;

  function hsl(h, s, l, out, o) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    out[o] = r + m; out[o + 1] = g + m; out[o + 2] = b + m;
  }
  AG.hsl = hsl;

  /* ---------- per-particle constants ---------- */
  const T = new Float32Array(N), CX = new Float32Array(N), SZ = new Float32Array(N), U = new Float32Array(N),
    SH = new Float32Array(N), JY = new Float32Array(N), SCX = new Float32Array(N), SCY = new Float32Array(N),
    SCZ = new Float32Array(N), RS = new Float32Array(N);
  const seeds = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    // an even lattice over height and angle (R2 sequence): no clumps, and any prefix still covers the whole form
    T[i] = (0.5 + i * 0.7548776662466927) % 1;
    const th = ((0.5 + i * 0.5698402909980532) % 1) * Math.PI * 2;
    const m = Math.abs((((th * 3) / (Math.PI * 2)) % 1) * 2 - 1); // three mirrored lobes: bass at the tips
    U[i] = (1 - m) * (B - 1);
    CX[i] = Math.cos(th); SZ[i] = Math.sin(th);
    SH[i] = R() < 0.14 ? 0.2 + 0.7 * R() : 1;       // most particles sit exactly on the surface
    JY[i] = 0;
    const a = R() * Math.PI * 2, d = 0.25 + R() * 0.9;
    SCX[i] = Math.cos(a) * d; SCZ[i] = Math.sin(a) * d; SCY[i] = (R() - 0.5) * 0.5; RS[i] = R();
    seeds[i * 4] = R(); seeds[i * 4 + 1] = R(); seeds[i * 4 + 2] = R(); seeds[i * 4 + 3] = R();
  }

  /* ---------- sculpture generator (shared by WebGL and the 2D thumbnails) ----------
     d = { bands: Uint8Array(S*B), hue: Uint8Array(S), flag: Uint8Array(S) } */
  const notch = new Float32Array(S), lo = new Float32Array(S * 3), hi = new Float32Array(S * 3), sA = new Float32Array(S * B), sV = new Float32Array(S * B);
  function fillSculpt(d, P, C, n) {
    const flag = d.flag, hue = d.hue, raw = d.bands, bands = sV;
    // soften the raw spectrum across bands and across time so the surface reads as one carved form
    for (let s = 0; s < S; s++) for (let b = 0; b < B; b++) {
      const o = s * B; sA[o + b] = (raw[o + (b > 0 ? b - 1 : b)] + 2 * raw[o + b] + raw[o + (b < B - 1 ? b + 1 : b)]) * 0.25;
    }
    for (let s = 0; s < S; s++) for (let b = 0; b < B; b++) {
      const u = s > 0 ? s - 1 : s, v = s < S - 1 ? s + 1 : s; sV[s * B + b] = (sA[u * B + b] + 2 * sA[s * B + b] + sA[v * B + b]) * 0.25;
    }
    for (let s = 0; s < S; s++) {
      const f0 = flag[s], f1 = Math.max(flag[s > 0 ? s - 1 : s], flag[s < S - 1 ? s + 1 : s]),
        f2 = Math.max(flag[s > 1 ? s - 2 : s], flag[s < S - 2 ? s + 2 : s]);
      notch[s] = Math.max(f0, f1 * 0.7, f2 * 0.3);
      const h = (hue[s] * 360) / 255;
      hsl(h, 0.9, 0.2, lo, s * 3);
      hsl(h - 28, 0.95, 0.62, hi, s * 3);
    }
    for (let i = 0; i < n; i++) {
      const t = T[i], f = t * (S - 1), s0 = f | 0, s1 = s0 < S - 1 ? s0 + 1 : s0, k = f - s0;
      const u = U[i], b0 = u | 0, b1 = b0 < B - 1 ? b0 + 1 : b0, kb = u - b0;
      const a0 = bands[s0 * B + b0] * (1 - kb) + bands[s0 * B + b1] * kb;
      const a1 = bands[s1 * B + b0] * (1 - kb) + bands[s1 * B + b1] * kb;
      const a = (a0 * (1 - k) + a1 * k) / 255;
      const nt = notch[s0] * (1 - k) + notch[s1] * k;
      const env = 0.5 + 0.5 * Math.sin(Math.PI * Math.pow(t, 0.8));
      const r = (0.13 + 0.66 * a) * env * SH[i] * (1 - 0.62 * nt);
      let x = CX[i] * r, z = SZ[i] * r, y = (t - 0.5) * 2.4 + JY[i], dim = 1;
      if (nt > 0.02 && RS[i] < nt * 0.5) {
        const m = 0.5 + RS[i] * 3.2;
        x += SCX[i] * m; y += SCY[i] * m; z += SCZ[i] * m; dim = 0.55;
      }
      const p = i * 4, c = i * 3, j0 = s0 * 3, j1 = s1 * 3;
      P[p] = x; P[p + 1] = y; P[p + 2] = z; P[p + 3] = t;
      const w = clamp(a * 1.15, 0, 1);
      dim *= (SH[i] < 1 ? 0.35 : 1) * (((t * S) % 8) < 1.3 ? 1.55 : 0.8);   // brighter contour every 8 slices
      for (let q = 0; q < 3; q++) {
        const L = lo[j0 + q] * (1 - k) + lo[j1 + q] * k, H = hi[j0 + q] * (1 - k) + hi[j1 + q] * k;
        C[c + q] = (L + (H - L) * w) * dim;
      }
    }
  }
  AG.fillSculpt = fillSculpt;
  AG.emptyData = () => ({ bands: new Uint8Array(S * B), hue: new Uint8Array(S).fill(152), flag: new Uint8Array(S) });

  /* 2D renderer for thumbnails, the share card and the floating mini window */
  let tP = null, tC = null;
  AG.draw2D = function (ctx, w, h, d, o) {
    o = o || {};
    const n = Math.min(N, o.n || 4000), rot = o.rot == null ? 0.6 : o.rot, grow = o.grow == null ? 1 : o.grow,
      tw = o.twist == null ? 1.1 : o.twist, sc = (o.scale || 0.36) * h, px = o.px || 1.3, cx = w * (o.cx || 0.5), cy = h * (o.cy || 0.5);
    if (!tP || tP.length < n * 4) { tP = new Float32Array(n * 4); tC = new Float32Array(n * 3); }
    fillSculpt(d, tP, tC, n);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const t = tP[i * 4 + 3]; if (t > grow) continue;
      const y = tP[i * 4 + 1], a = rot + y * tw, c = Math.cos(a), s = Math.sin(a);
      const x = tP[i * 4] * c - tP[i * 4 + 2] * s, z = tP[i * 4] * s + tP[i * 4 + 2] * c;
      const k = 0.6 + 0.4 * (z + 1) * 0.5;
      ctx.fillStyle = 'rgba(' + ((tC[i * 3] * 255) | 0) + ',' + ((tC[i * 3 + 1] * 255) | 0) + ',' + ((tC[i * 3 + 2] * 255) | 0) + ',' + (0.75 * k).toFixed(2) + ')';
      ctx.fillRect(cx + x * sc, cy - (y + z * 0.12) * sc, px, px);
    }
    ctx.restore();
  };

  /* ---------- static shapes ---------- */
  const shapes = (AG.shapes = {});
  function mk(name, fn) {
    const pos = new Float32Array(N * 4), col = new Float32Array(N * 3);
    if (fn) fn(pos, col);
    shapes[name] = { pos, col, pb: null, cb: null, dirty: true };
  }
  const put = (P, C, i, x, y, z, r, g, b) => { P[i * 4] = x; P[i * 4 + 1] = y; P[i * 4 + 2] = z; P[i * 4 + 3] = 0; C[i * 3] = r; C[i * 3 + 1] = g; C[i * 3 + 2] = b; };

  mk('sculpt');
  mk('orb', (P, C) => {
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N, rr = Math.sqrt(1 - y * y), ph = i * 2.399963;
      let rad = 0.98 * (1 + 0.07 * Math.sin(y * 7 + Math.cos(ph) * 2) + 0.05 * Math.sin(ph * 3 + y * 4));
      const inner = R() < 0.14; if (inner) rad *= 0.15 + R() * 0.5;
      const k = (y + 1) / 2, v = 0.35 + R() * 0.4;
      put(P, C, i, Math.cos(ph) * rr * rad, y * rad, Math.sin(ph) * rr * rad,
        lerp(0.08, 0.25, k) * v * 2, lerp(0.25, 0.95, k) * v * (inner ? 1.4 : 1), lerp(1.0, 0.8, k) * v * 1.5);
    }
  });
  mk('galaxy', (P, C) => {
    for (let i = 0; i < N; i++) {
      if (R() < 0.12) {
        const a = R() * 6.283, b = Math.acos(2 * R() - 1), r = Math.pow(R(), 2) * 0.3;
        put(P, C, i, Math.sin(b) * Math.cos(a) * r, Math.cos(b) * r * 0.6, Math.sin(b) * Math.sin(a) * r, 0.5, 0.85, 1);
        continue;
      }
      const rr = 0.12 + Math.pow(R(), 0.62) * 1.55, arm = (R() * 3) | 0;
      const th = (arm * 6.283) / 3 + rr * 3.4 + (R() - 0.5) * 1.1 * (1 - rr / 1.9) + (R() < 0.2 ? R() * 6.283 : 0);
      const k = rr / 1.67, v = 0.3 + R() * 0.45, mint = R() < 0.15;
      put(P, C, i, Math.cos(th) * rr, (R() - 0.5) * 0.16 * Math.exp(-rr * 1.2), Math.sin(th) * rr,
        (mint ? 0.25 : lerp(0.2, 0.1, k)) * v * 2, (mint ? 1 : lerp(0.85, 0.3, k)) * v * 1.4, (mint ? 0.75 : 1) * v * 1.6);
    }
  });
  mk('dust', (P, C) => {
    for (let i = 0; i < N; i++) {
      const v = 0.12 + Math.pow(R(), 3) * 0.6, c = R();
      put(P, C, i, (R() - 0.5) * 10, (R() - 0.5) * 6.5, (R() - 0.5) * 7 - 0.5, (c < 0.2 ? 0.3 : 0.12) * v * 2, lerp(0.35, 0.9, c) * v, 1 * v);
    }
  });
  mk('ring', (P, C) => {
    for (let i = 0; i < N; i++) {
      const u = R() * 6.283, v = R() * 6.283, w = 0.4 * (1 + 0.22 * Math.sin(u * 3 + v) + 0.12 * Math.sin(u * 7));
      const rr = 1.08 + w * Math.cos(v), k = (Math.sin(v) + 1) / 2, b = 0.3 + R() * 0.4;
      put(P, C, i, rr * Math.cos(u), w * Math.sin(v), rr * Math.sin(u), lerp(0.1, 0.3, k) * b * 2, lerp(0.3, 1, k) * b * 1.3, lerp(1, 0.75, k) * b * 1.5);
    }
  });
  mk('garden');

  /* Garden: up to 7 small sculptures on a dotted ground. items = [{data, x, z, scale}] */
  AG.setGarden = function (items) {
    const g = shapes.garden, P = g.pos, C = g.col;
    const per = Math.floor((N * 0.8) / 7), sub = new Float32Array(per * 4), subC = new Float32Array(per * 3);
    let o = 0;
    for (const it of items) {
      fillSculpt(it.data, sub, subC, per);
      const G2 = mulberry(5 + items.indexOf(it));
      for (let i = 0; i < per; i++, o++) {
        if (sub[i * 4 + 3] > (it.grow == null ? 1 : it.grow)) {   // not grown: leave it as dust on the ground
          const q = G2() * 6.283, d = Math.sqrt(G2()) * 0.42;
          put(P, C, o, it.x + Math.cos(q) * d, -0.74, it.z + Math.sin(q) * d * 0.6, 0.03, 0.09, 0.16); continue;
        }
        if (sub[i * 4 + 3] > (it.grow || 1)) {   // unfinished part stays on the ground
          put(P, C, o, it.x + sub[i * 4] * it.scale * 2.2, -0.735, it.z + sub[i * 4 + 2] * it.scale * 2.2, 0.03, 0.09, 0.16); continue;
        }
        const y = sub[i * 4 + 1], a = y * 1.1 + it.x, c = Math.cos(a), s = Math.sin(a);
        put(P, C, o, it.x + (sub[i * 4] * c - sub[i * 4 + 2] * s) * it.scale, -0.72 + (y + 1.2) * it.scale, it.z + (sub[i * 4] * s + sub[i * 4 + 2] * c) * it.scale,
          subC[i * 3] * 1.25, subC[i * 3 + 1] * 1.25, subC[i * 3 + 2] * 1.25);
      }
    }
    const G = mulberry(99);
    for (; o < N; o++) {   // ground
      const a = G() * 6.283, r = Math.sqrt(G()) * 3.6, x = Math.cos(a) * r, z = Math.sin(a) * r * 0.55;
      const ripple = 0.5 + 0.5 * Math.sin(r * 9), v = 0.07 + 0.16 * ripple * (1 - r / 3.8);
      put(P, C, o, x, -0.74 + (G() - 0.5) * 0.01, z, 0.2 * v, 0.6 * v, 1 * v);
    }
    g.dirty = true;
  };
  AG.setGarden([]);

  /* ---------- WebGL ---------- */
  const canvas = document.getElementById('gl');
  let gl = null;
  try { gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' }); } catch (e) {}
  if (!gl) { document.documentElement.classList.add('no-gl'); }

  const VS = `
precision highp float;
attribute vec4 aA; attribute vec4 aB; attribute vec3 aCA; attribute vec3 aCB; attribute vec4 aSeed;
uniform mat4 uVP; uniform mat4 uM;
uniform float uMix,uTime,uGrowA,uGrowB,uTwA,uTwB,uAudA,uAudB,uTurb,uBass,uMid,uHigh,uPx,uDim,uRepel,uShock,uAspect;
uniform vec2 uMouse;
varying vec3 vC; varying float vA;
vec3 tw(vec3 p,float k){float a=p.y*k;float c=cos(a),s=sin(a);return vec3(c*p.x-s*p.z,p.y,s*p.x+c*p.z);}
void main(){
  float a0=aSeed.x*6.2832+uTime*0.06*(0.4+aSeed.y);
  float dr=1.15+aSeed.z*1.7;
  vec3 d=vec3(cos(a0)*dr,(aSeed.y-0.5)*3.6+sin(uTime*0.25+aSeed.w*6.28)*0.12,sin(a0)*dr);
  float ga=smoothstep(uGrowA-0.05,uGrowA,aA.w);
  float gb=smoothstep(uGrowB-0.05,uGrowB,aB.w);
  vec3 pa=tw(aA.xyz,uTwA);
  pa.xz*=1.0+uAudA*(uBass*0.14*sin(pa.y*5.0-uTime*3.2)+uMid*0.06);
  pa=mix(pa,d,ga);
  vec3 pb=tw(aB.xyz,uTwB);
  pb.xz*=1.0+uAudB*(uBass*0.14*sin(pb.y*5.0-uTime*3.2)+uMid*0.06);
  pb=mix(pb,d,gb);
  float m=clamp(uMix*1.5-aSeed.x*0.5,0.0,1.0); m=m*m*(3.0-2.0*m);
  vec3 p=mix(pa,pb,m);
  float bell=sin(m*3.14159);
  vec3 n=vec3(sin(aSeed.y*40.0+uTime*0.9),cos(aSeed.z*37.0+uTime*0.7),sin(aSeed.w*31.0-uTime*0.8));
  p+=n*(bell*uTurb+uShock*aSeed.x*0.5+0.0025);
  float sw=bell*uTurb*2.4; float c=cos(sw),s=sin(sw); p.xz=mat2(c,-s,s,c)*p.xz;
  vec4 cp=uVP*(uM*vec4(p,1.0));
  vec2 nd=cp.xy/cp.w; vec2 dl=(nd-uMouse)*vec2(uAspect,1.0); float dd=dot(dl,dl);
  nd+=normalize(dl+vec2(1e-5))*uRepel*exp(-dd*16.0)*0.09/vec2(uAspect,1.0);
  cp.xy=nd*cp.w;
  gl_Position=cp;
  float born=1.0-mix(ga,gb,m);
  float sz=(0.55+aSeed.w*1.15)*(1.0+uHigh*step(0.9,aSeed.y)*2.2);
  gl_PointSize=max(1.0,uPx*sz/cp.w);
  vC=mix(vec3(0.10,0.2,0.55),mix(aCA,aCB,m)*(0.85+uBass*0.5),born);
  vA=mix(0.16,1.0,born)*uDim;
}`;
  const FS = `
precision mediump float; varying vec3 vC; varying float vA;
void main(){vec2 q=gl_PointCoord-0.5;float d=dot(q,q)*4.0;float a=max(0.0,1.0-d);a*=a;gl_FragColor=vec4(vC*a*vA,1.0);}`;

  let prog, loc = {}, seedBuf;
  function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; }
  if (gl) {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    ['aA', 'aB', 'aCA', 'aCB', 'aSeed'].forEach((n) => { loc[n] = gl.getAttribLocation(prog, n); gl.enableVertexAttribArray(loc[n]); });
    ['uVP', 'uM', 'uMix', 'uTime', 'uGrowA', 'uGrowB', 'uTwA', 'uTwB', 'uAudA', 'uAudB', 'uTurb', 'uBass', 'uMid', 'uHigh', 'uPx', 'uDim', 'uRepel', 'uShock', 'uAspect', 'uMouse']
      .forEach((n) => (loc[n] = gl.getUniformLocation(prog, n)));
    seedBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf); gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    for (const k in shapes) { shapes[k].pb = gl.createBuffer(); shapes[k].cb = gl.createBuffer(); }
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0.014, 0.018, 0.04, 1);
  }
  function upload(sp) {
    gl.bindBuffer(gl.ARRAY_BUFFER, sp.pb); gl.bufferData(gl.ARRAY_BUFFER, sp.pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, sp.cb); gl.bufferData(gl.ARRAY_BUFFER, sp.col, gl.DYNAMIC_DRAW);
    sp.dirty = false;
  }

  /* ---------- matrices ---------- */
  const FOV = (34 * Math.PI) / 180, CAMZ = 6.2;
  const VP = new Float32Array(16), M = new Float32Array(16), M2 = new Float32Array(16), MVP = new Float32Array(16);
  function persp(o, asp) { const f = 1 / Math.tan(FOV / 2), n = 0.1, fr = 60; o.fill(0); o[0] = f / asp; o[5] = f; o[10] = (fr + n) / (n - fr); o[11] = -1; o[14] = (2 * fr * n) / (n - fr); }
  function model(o, x, y, s, rx, ry) {
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
    // M = T * Rx * Ry * S
    o[0] = cy * s; o[1] = sx * sy * s; o[2] = -cx * sy * s; o[3] = 0;
    o[4] = 0; o[5] = cx * s; o[6] = sx * s; o[7] = 0;
    o[8] = sy * s; o[9] = -sx * cy * s; o[10] = cx * cy * s; o[11] = 0;
    o[12] = x; o[13] = y; o[14] = -CAMZ; o[15] = 1;
  }
  function mul(o, a, b) { for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; }
  AG.project = function (x, y, z) {
    const X = MVP[0] * x + MVP[4] * y + MVP[8] * z + MVP[12], Y = MVP[1] * x + MVP[5] * y + MVP[9] * z + MVP[13], W = MVP[3] * x + MVP[7] * y + MVP[11] * z + MVP[15];
    return [(X / W * 0.5 + 0.5) * innerWidth, (1 - (Y / W * 0.5 + 0.5)) * innerHeight];
  };

  /* ---------- scroll keys ---------- */
  let keys = [], W = 1, H = 1, dpr = 1, quality = 1, maxDpr = Math.min(devicePixelRatio || 1, 2);
  function measure() {
    const mob = innerWidth < 860;
    keys = [...document.querySelectorAll('[data-key]')].map((el) => {
      const r = el.getBoundingClientRect(), d = el.dataset;
      const pick = (k, def) => parseFloat(mob && d[k + 'M'] != null ? d[k + 'M'] : d[k] != null ? d[k] : def);
      return { y: r.top + scrollY + r.height / 2, shape: d.key, fx: pick('fx', 0), fy: pick('fy', 0), s: pick('s', 1), tilt: pick('tilt', 0), repel: pick('repel', 0.3), spin: pick('spin', 1), halo: pick('halo', 0) };
    }).sort((a, b) => a.y - b.y);
  }
  function resize() {
    dpr = Math.min(maxDpr, devicePixelRatio || 1);
    W = Math.round(innerWidth * dpr); H = Math.round(innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    if (gl) gl.viewport(0, 0, W, H);
    persp(VP, W / H);
    measure();
  }
  addEventListener('resize', resize);
  addEventListener('load', () => { resize(); setTimeout(measure, 600); setTimeout(measure, 2500); });
  if (window.ResizeObserver) new ResizeObserver(() => measure()).observe(document.body);
  AG.measure = measure;

  /* ---------- interaction ---------- */
  const mouse = { x: 0, y: 0, sx: 0, sy: 0, on: 0 };
  let userRot = 0, rotVel = 0, drag = null;
  addEventListener('pointermove', (e) => {
    mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = -((e.clientY / innerHeight) * 2 - 1); mouse.on = 1;
    if (drag) { const dx = e.clientX - drag.x; drag.x = e.clientX; rotVel = dx * 0.006; userRot += rotVel; }
  }, { passive: true });
  addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,a,input,select,textarea,label,.panel,.card,.player,.modal,[data-noorbit]')) return;
    drag = { x: e.clientX };
  });
  addEventListener('pointerup', () => (drag = null));
  addEventListener('pointercancel', () => (drag = null));
  document.addEventListener('pointerleave', () => (mouse.on = 0));

  /* ---------- public state ---------- */
  const st = (AG.view = {
    grow: 1, twist: 1.1, size: 1, bass: 0, mid: 0, high: 0, shock: 0, dim: 1, dimTarget: 1,
    override: null,            // {shape, fx, fy, s, tilt} while the viewer / replay is open
    spinBoost: 0,
  });
  AG.updateSculpt = function (data) {
    const sp = shapes.sculpt; fillSculpt(data, sp.pos, sp.col, N); sp.dirty = true;
  };
  const cur = { fx: 0.4, fy: 0, s: 1, tilt: 0, repel: 1, spin: 1, halo: 0 };
  let scrollS = scrollY, time = 0, last = performance.now(), fAcc = 0, fCnt = 0, spin = 0;
  const hooks = (AG.onFrame = []);
  const sm = (t) => t * t * (3 - 2 * t);

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1000); last = now; time += dt;
    // adaptive quality
    fAcc += dt; fCnt++;
    if (fCnt >= 80) {
      const avg = fAcc / fCnt; fAcc = 0; fCnt = 0;
      if (avg > 0.027) { if (maxDpr > 1.01) { maxDpr = Math.max(1, maxDpr - 0.5); resize(); } else if (quality > 0.3) quality *= 0.8; }
      else if (avg < 0.0175 && quality < 1) quality = Math.min(1, quality * 1.08);
    }
    scrollS += (scrollY - scrollS) * (reduced ? 1 : Math.min(1, dt * 6));
    const pc = scrollS + innerHeight * 0.5;
    let a, b, f = 0;
    if (st.override) { a = b = st.override; }
    else if (keys.length) {
      let i = 0; while (i < keys.length - 2 && pc >= keys[i + 1].y) i++;
      a = keys[i]; b = keys[Math.min(i + 1, keys.length - 1)];
      f = b.y > a.y ? clamp((pc - a.y) / (b.y - a.y), 0, 1) : 0;
      f = sm(clamp((f - 0.22) / 0.56, 0, 1));
    } else return;
    const e = reduced ? 1 : Math.min(1, dt * 5);
    cur.fx += (lerp(a.fx, b.fx, f) - cur.fx) * e; cur.fy += (lerp(a.fy, b.fy, f) - cur.fy) * e;
    cur.s += (lerp(a.s, b.s, f) - cur.s) * e; cur.tilt += (lerp(a.tilt, b.tilt, f) - cur.tilt) * e;
    cur.repel += (lerp(a.repel == null ? 0.3 : a.repel, b.repel == null ? 0.3 : b.repel, f) - cur.repel) * e;
    cur.spin += (lerp(a.spin == null ? 1 : a.spin, b.spin == null ? 1 : b.spin, f) - cur.spin) * e;
    cur.halo += (lerp(a.halo || 0, b.halo || 0, f) - cur.halo) * e;
    mouse.sx += (mouse.x - mouse.sx) * Math.min(1, dt * 3); mouse.sy += (mouse.y - mouse.sy) * Math.min(1, dt * 3);
    if (!drag) { userRot += rotVel; rotVel *= 0.94; }
    if (!reduced) spin += dt * (0.1 + st.spinBoost);
    st.shock *= Math.pow(0.12, dt); st.dim += (st.dimTarget - st.dim) * Math.min(1, dt * 3);
    for (const h of hooks) h(dt, time);
    if (!gl) return;

    const halfH = Math.tan(FOV / 2) * CAMZ, halfW = halfH * (W / H);
    const follow = reduced ? 0 : 1;
    const ry = cur.spin * (spin + userRot + scrollS * 0.0012) + (1 - cur.spin) * ((reduced ? 0 : Math.sin(time * 0.25) * 0.22) + Math.sin(userRot) * 0.9) + mouse.sx * 0.45 * follow * (0.3 + 0.7 * cur.spin);
    const rx = cur.tilt + -mouse.sy * 0.16 * follow;
    model(M, cur.fx * halfW + mouse.sx * 0.07 * follow, cur.fy * halfH + mouse.sy * 0.04 * follow, cur.s, rx, ry);
    mul(MVP, VP, M);

    const A = shapes[a.shape], Bs = shapes[b.shape], D = shapes.dust, Rg = shapes.ring;
    if (A.dirty) upload(A); if (Bs.dirty) upload(Bs); if (D.dirty) upload(D); if (Rg.dirty) upload(Rg);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf); gl.vertexAttribPointer(loc.aSeed, 4, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(loc.uVP, false, VP); gl.uniform1f(loc.uTime, time);
    gl.uniform1f(loc.uBass, st.bass); gl.uniform1f(loc.uMid, st.mid); gl.uniform1f(loc.uHigh, st.high);
    gl.uniform1f(loc.uAspect, W / H); gl.uniform2f(loc.uMouse, mouse.sx * 0.35 + mouse.x * 0.65, mouse.sy * 0.35 + mouse.y * 0.65);
    const px = H * 0.0165 * st.size / Math.sqrt(quality) * (N < 30000 ? 1.25 : 1);
    const isS = (k) => (k.shape === 'sculpt' ? 1 : 0), aud = (k) => ({ sculpt: 1, orb: 0.8, galaxy: 0.5, garden: 0.25, ring: 0.5, dust: 0 }[k.shape]);
    // 1. far dust, always there for depth (fades out where dust is already the main shape)
    const dustW = (a.shape === 'dust' ? 1 - f : 0) + (b.shape === 'dust' ? f : 0);
    if (dustW < 0.98) {
      model(M2, 0, 0, 1.7, 0.08, time * (reduced ? 0 : 0.012) + scrollS * 0.0003);
      pass(D, D, 0, M2, 1.06, 1.06, 0, 0, 0, 0, 0, px * 0.9, st.dim * 0.55 * (1 - dustW), 0, 0, 0.3);
    }
    // 2. halo ring around the sculpture where a key asks for it
    if (cur.halo > 0.01) {
      model(M2, cur.fx * halfW + mouse.sx * 0.07 * follow, cur.fy * halfH - 0.15 * cur.s, cur.s * 1.5, rx + 0.2, time * (reduced ? 0 : 0.1));
      pass(Rg, Rg, 0, M2, 1.06, 1.06, 0, 0, 0.6, 0.6, 0, px * 0.8, st.dim * 0.34 * cur.halo, 0, 0, 0.4);
    }
    // 3. the main shape pair
    pass(A, Bs, f, M, isS(a) ? st.grow * 1.06 : 1.06, isS(b) ? st.grow * 1.06 : 1.06, isS(a) * st.twist, isS(b) * st.twist, aud(a), aud(b),
      reduced ? 0 : 0.42, px, st.dim, st.shock, reduced || !mouse.on ? 0 : cur.repel, 1);
  }
  function pass(A, Bs, mix, mat, gA, gB, twA, twB, auA, auB, turb, px, dim, shock, repel, frac) {
    gl.bindBuffer(gl.ARRAY_BUFFER, A.pb); gl.vertexAttribPointer(loc.aA, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, A.cb); gl.vertexAttribPointer(loc.aCA, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, Bs.pb); gl.vertexAttribPointer(loc.aB, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, Bs.cb); gl.vertexAttribPointer(loc.aCB, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(loc.uM, false, mat); gl.uniform1f(loc.uMix, mix);
    gl.uniform1f(loc.uGrowA, gA); gl.uniform1f(loc.uGrowB, gB); gl.uniform1f(loc.uTwA, twA); gl.uniform1f(loc.uTwB, twB);
    gl.uniform1f(loc.uAudA, auA); gl.uniform1f(loc.uAudB, auB); gl.uniform1f(loc.uTurb, turb);
    gl.uniform1f(loc.uPx, px); gl.uniform1f(loc.uDim, dim); gl.uniform1f(loc.uShock, shock); gl.uniform1f(loc.uRepel, repel);
    gl.drawArrays(gl.POINTS, 0, Math.floor(N * quality * frac));
  }
  AG.start = function () { resize(); requestAnimationFrame(frame); };
  AG.info = () => ({ N, quality, dpr });
})();
