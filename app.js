(() => {
  'use strict';

  const C = { ...window.VIZ_CONFIG };
  const $ = (s) => document.querySelector(s);
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Characters by density: the brighter the cell, the "heavier" the character
  const RAMP = ' .,:;-=+*#%@';
  // ASCII only: a character of another width would shift the whole row
  const GLYPHS = '01#%&@$<>/\\{}[]=+*ABCDEFXZ';

  // Colors: [hue][brightness 0..3]
  const PAL = [
    ['#4a2208', '#a8480f', '#ff7a18', '#ffd08a'], // orange
    ['#123d0c', '#2f7a1c', '#7cff4f', '#d8ffc8'], // green
    ['#45070f', '#8f1022', '#ff1f3d', '#ffb0bb'], // red
    ['#24103a', '#4f2788', '#9b4dff', '#e0c8ff'], // purple
  ];
  const ORANGE = 0, GREEN = 1, RED = 2, PURPLE = 3;

  // ---------- Character grid ----------

  const stage = $('#stage');
  const cv = $('#screen');
  const g = cv.getContext('2d');
  const glowCv = $('#glow');
  const gg = glowCv.getContext('2d');

  let W = 0, H = 0, cw = 0, ch = 0, px = 0, font = '';
  let buf, tint, glyph, layers;
  const used = new Uint8Array(16);

  function set(x, y, v, t) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (v > buf[i]) {
      buf[i] = v;
      tint[i] = t;
    }
  }

  function shiftRow(arr, y, off) {
    const row = arr.slice(y * W, y * W + W);
    for (let x = 0; x < W; x++) arr[y * W + ((x + off + W) % W)] = row[x];
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.floor(innerWidth * dpr);
    cv.height = Math.floor(innerHeight * dpr);
    glowCv.width = Math.ceil(innerWidth / 4);
    glowCv.height = Math.ceil(innerHeight / 4);
    px = cv.width / C.columns / 0.6;
    font = `700 ${px}px 'Courier New', Courier, monospace`;
    g.font = font;
    cw = g.measureText('M').width;
    ch = cw * 2; // 1:2 cells, the art is drawn for them
    W = Math.floor(cv.width / cw);
    H = Math.floor(cv.height / ch);
    buf = new Float32Array(W * H);
    tint = new Uint8Array(W * H);
    glyph = new Uint8Array(W * H);
    layers = Array.from({ length: 16 }, () => new Array(W));
    for (const m of MODES) if (m.resize) m.resize();
    wordMask = null;
  }

  // Each row is drawn in color layers: 16 fillText calls per row instead of thousands per frame
  function draw() {
    g.fillStyle = '#050308';
    g.fillRect(0, 0, cv.width, cv.height);
    g.font = font;
    g.textBaseline = 'top';
    const ox = (cv.width - W * cw) / 2;
    const oy = (cv.height - H * ch) / 2 + (ch - px) / 2;
    for (let y = 0; y < H; y++) {
      used.fill(0);
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const v = buf[row + x];
        if (v < 0.035) continue;
        const L = tint[row + x] * 4 + (v < 0.25 ? 0 : v < 0.5 ? 1 : v < 0.8 ? 2 : 3);
        if (!used[L]) {
          used[L] = 1;
          layers[L].fill(' ');
        }
        layers[L][x] = glyph[row + x]
          ? String.fromCharCode(glyph[row + x])
          : RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(v * (RAMP.length - 1)))];
      }
      for (let L = 0; L < 16; L++) {
        if (!used[L]) continue;
        g.fillStyle = PAL[L >> 2][L & 3];
        g.fillText(layers[L].join(''), ox, oy + y * ch);
      }
    }
    gg.clearRect(0, 0, glowCv.width, glowCv.height);
    gg.drawImage(cv, 0, 0, glowCv.width, glowCv.height);
  }

  // ---------- Sound ----------

  const NB = 64;
  const bands = new Float32Array(NB);
  const bandsRaw = new Float32Array(NB);
  const waveRaw = new Float32Array(512);
  const waveBuf = new Float32Array(512);
  // hit is the strength of the last beat 0..1, drop is a loud part kicking in after a quiet one
  const A = { bass: 0, mid: 0, high: 0, level: 0, beat: false, hit: 0, pulse: 0, beats: 0, drop: false };
  const waveAt = (x) => waveBuf[Math.floor((x / W) * (waveBuf.length - 1))];

  let actx = null, analyser = null, freq = null, wave = null;
  let inputNode = null, stream = null, playerNode = null;
  let inputName = 'none';
  // above 1 the picture just hits the ceiling: loudness is already stretched to the full range
  let sens = clamp(C.sensitivity, 0.2, 1);
  let waveAgc = 0.1, lastBeat = 0, lastDrop = 0, lastAnalyse = 0;
  let prevFreq = null, shortE = 0, longE = 0;
  const fluxHist = new Float32Array(43); // ~0.7 s of beat history
  let fluxPos = 0;

  // Loudness comes in decibels, so quiet and loud parts differ little.
  // Each feature keeps its own floor and ceiling, and the value is stretched between them
  const range = () => ({ lo: 1, hi: 0 });
  const R = { bass: range(), mid: range(), high: range() };
  const bandLo = new Float32Array(NB).fill(1);
  let bandHi = 0.1;

  function stretch(r, x) {
    r.lo = x < r.lo ? x : r.lo + (x - r.lo) * 0.003;
    r.hi = x > r.hi ? x : r.hi - (r.hi - r.lo) * 0.0015;
    return clamp((x - r.lo) / Math.max(0.12, r.hi - r.lo), 0, 1);
  }

  // Instant rise, smooth fall over rel seconds
  const env = (cur, x, dt, rel) => (x > cur ? x : cur + (x - cur) * (1 - Math.exp(-dt / rel)));

  const player = new Audio();
  let playlist = [];
  let track = 0;
  let failed = 0; // how many files in a row failed to play

  function ensureAudio() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = actx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.5;
      freq = new Uint8Array(analyser.frequencyBinCount);
      wave = new Uint8Array(analyser.fftSize);
    }
    if (actx.state === 'suspended') actx.resume();
  }

  function stopInputs() {
    player.pause();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (inputNode) {
      inputNode.disconnect();
      inputNode = null;
    }
    if (analyser) analyser.disconnect();
    inputName = 'none';
  }

  function connect(node, speakers, label) {
    node.connect(analyser);
    if (speakers) analyser.connect(actx.destination);
    inputNode = node;
    inputName = label;
  }

  // A Chrome tab, or the entire screen with system audio for music apps (Chrome 141+, macOS 14.2+)
  async function useTab() {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
    });
    if (!s.getAudioTracks().length) {
      s.getTracks().forEach((t) => t.stop());
      throw new Error('noaudio');
    }
    const v = s.getVideoTracks()[0];
    const surface = v && v.getSettings().displaySurface;
    stopInputs();
    stream = s;
    connect(actx.createMediaStreamSource(s), false, surface === 'monitor' ? 'system' : 'tab');
    s.getAudioTracks()[0].addEventListener('ended', () => {
      stopInputs();
      showMenu();
      toast('audio sharing stopped');
    });
  }

  function useFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
    if (!list.length) return false;
    ensureAudio();
    stopInputs();
    playlist.forEach((t) => URL.revokeObjectURL(t.url));
    playlist = list.map((f) => ({ name: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f) }));
    track = 0;
    failed = 0;
    if (!playerNode) playerNode = actx.createMediaElementSource(player);
    connect(playerNode, true, 'files');
    playTrack();
    return true;
  }

  function playTrack() {
    const t = playlist[track];
    player.src = t.url;
    // without a click on the page (files were just dropped) the browser blocks playback: wait for the first input
    player.play().catch(() => toast(`♪ ${t.name} · click or press a key to play`));
    toast(`♪ ${t.name}`);
  }
  player.addEventListener('ended', () => {
    track = (track + 1) % playlist.length;
    playTrack();
  });
  player.addEventListener('playing', () => { failed = 0; });
  // skip broken or unsupported files; stop if none of them plays
  player.addEventListener('error', () => {
    if (!playlist.length) return;
    toast(`can't play: ${playlist[track].name}`);
    if (++failed >= playlist.length) return;
    track = (track + 1) % playlist.length;
    playTrack();
  });

  function unlockAudio() {
    if (actx && actx.state === 'suspended') actx.resume();
    if (inputName === 'files' && player.paused && player.src) player.play().catch(() => {});
  }
  addEventListener('pointerdown', unlockAudio);

  function analyse(now) {
    const dt = clamp((now - lastAnalyse) / 1000, 0.001, 0.05);
    lastAnalyse = now;
    let rawBass, rawMid, rawHigh, flux;
    if (!inputNode) {
      // No source picked yet: silence
      rawBass = rawMid = rawHigh = flux = 0;
      bandsRaw.fill(0);
      waveRaw.fill(0);
    } else {
      analyser.getByteFrequencyData(freq);
      analyser.getByteTimeDomainData(wave);
      const binHz = actx.sampleRate / analyser.fftSize;
      const avg = (lo, hi) => {
        const a = Math.max(1, Math.floor(lo / binHz));
        const z = Math.min(freq.length - 1, Math.max(a, Math.ceil(hi / binHz)));
        let s = 0;
        for (let i = a; i <= z; i++) s += freq[i];
        return s / (z - a + 1) / 255;
      };
      rawBass = avg(30, 150);
      rawMid = avg(150, 2000);
      rawHigh = avg(2000, 9000);
      // log bands 40 Hz – 16 kHz, highs boosted a little: they are always quieter
      for (let b = 0; b < NB; b++) {
        bandsRaw[b] = avg(40 * Math.pow(400, b / NB), 40 * Math.pow(400, (b + 1) / NB)) * (1 + (1.2 * b) / NB);
      }
      for (let i = 0; i < waveRaw.length; i++) waveRaw[i] = (wave[i * 4] - 128) / 128;
      // Beat: how sharply the bass grew since the last frame
      const a = Math.max(1, Math.floor(30 / binHz));
      const z = Math.max(a, Math.ceil(200 / binHz));
      if (!prevFreq) prevFreq = new Uint8Array(freq.length);
      flux = 0;
      for (let i = a; i <= z; i++) flux += Math.max(0, freq[i] - prevFreq[i]);
      flux /= 255 * (z - a + 1);
      prevFreq.set(freq);
    }

    A.bass = env(A.bass, clamp(stretch(R.bass, rawBass) * sens, 0, 1), dt, 0.12);
    A.mid = env(A.mid, clamp(stretch(R.mid, rawMid) * sens, 0, 1), dt, 0.18);
    A.high = env(A.high, clamp(stretch(R.high, rawHigh) * sens, 0, 1), dt, 0.08);
    A.level = (A.bass + A.mid) / 2;

    let mxb = 0;
    for (let b = 0; b < NB; b++) {
      const x = bandsRaw[b];
      bandLo[b] = x < bandLo[b] ? x : bandLo[b] + (x - bandLo[b]) * 0.0015;
      mxb = Math.max(mxb, x - bandLo[b]);
    }
    bandHi = Math.max(mxb, bandHi * 0.998, 0.08);
    for (let b = 0; b < NB; b++) bands[b] = env(bands[b], clamp(((bandsRaw[b] - bandLo[b]) / bandHi) * sens, 0, 1), dt, 0.1);

    let mx = 0;
    for (const v of waveRaw) mx = Math.max(mx, Math.abs(v));
    waveAgc = Math.max(mx, waveAgc * 0.995, 0.01);
    for (let i = 0; i < waveBuf.length; i++) waveBuf[i] = (waveRaw[i] / waveAgc) * 0.9 * sens;

    // Beat: a hit well above the usual spread over the last ~0.7 s
    let mean = 0, sq = 0;
    for (const f of fluxHist) { mean += f; sq += f * f; }
    mean /= fluxHist.length;
    const std = Math.sqrt(Math.max(0, sq / fluxHist.length - mean * mean));
    fluxHist[fluxPos] = flux;
    fluxPos = (fluxPos + 1) % fluxHist.length;
    A.beat = flux > mean + 1.5 * std && flux > 0.012 && A.bass > 0.3 && now - lastBeat > 200;
    if (A.beat) {
      lastBeat = now;
      A.beats++;
      A.hit = clamp((flux - mean) / (4 * std + 0.01), 0.2, 1);
      A.pulse = Math.max(A.pulse, 0.5 + 0.5 * A.hit);
    } else {
      A.pulse *= Math.exp(-dt * 8);
    }

    // Drop: short-term loudness jumps well above long-term loudness
    shortE += (A.level - shortE) * (1 - Math.exp(-dt / 0.3));
    longE += (A.level - longE) * (1 - Math.exp(-dt / 6));
    A.drop = shortE > 0.6 && shortE - longE > 0.3 && now - lastDrop > 15000;
    if (A.drop) lastDrop = now;
  }

  // ---------- Modes ----------

  function parseArt(name) {
    const lines = window.ART[name].split('\n');
    const w = Math.max(...lines.map((l) => l.length));
    const h = lines.length;
    const v = new Float32Array(w * h);
    lines.forEach((l, y) => {
      for (let x = 0; x < l.length; x++) {
        const r = RAMP.indexOf(l[x]);
        v[y * w + x] = r < 0 ? 0.6 : r / (RAMP.length - 1);
      }
    });
    const tints = { skull: GREEN, pumpkin: ORANGE, ghost: PURPLE, bat: RED, spider: PURPLE, eye: RED, tombstone: GREEN, witch: PURPLE };
    return { w, h, v, tint: tints[name] ?? ORANGE };
  }

  const ALL = {
    // Spectrum: bass in the middle, highs at the edges, a reflection below
    bars: {
      name: 'SPECTRUM',
      peaks: null,
      resize() { this.peaks = new Float32Array(W); },
      frame(t, dt) {
        buf.fill(0);
        const mid = Math.floor(H / 2);
        const half = mid - 2;
        for (let x = 0; x < W; x++) {
          if (x % 3 === 2) continue;
          const dist = Math.abs(x + 0.5 - W / 2) / (W / 2);
          const b = Math.min(NB - 1, Math.floor(dist * NB));
          const hgt = bands[b] * half * (0.85 + 0.3 * A.pulse);
          this.peaks[x] = Math.max(this.peaks[x] - 25 * dt, hgt);
          const tt = b < NB * 0.15 ? RED : b < NB * 0.6 ? ORANGE : PURPLE;
          for (let y = 0; y <= hgt; y++) {
            const v = 0.25 + 0.75 * (y / Math.max(1, hgt));
            set(x, mid - y, v, tt);
            set(x, mid + y, v * 0.55, tt);
          }
          set(x, mid - Math.round(this.peaks[x]) - 1, 1, tt);
        }
      },
    },

    // Figures assemble from flying characters, move with the music,
    // explode after artBeats beats, and the next one assembles from the shards
    art: {
      name: 'APPARITION',
      arts: null,
      names: [],
      lock: null, // G key: index of the locked figure, or null to cycle
      i: -1,
      phase: null,
      t: 0,
      beats: 0,
      parts: [],
      echoes: [],
      bands: [],
      flash: 0,
      resize() { this.phase = null; },
      enter() { this.phase = null; },

      load() {
        if (!this.arts) {
          this.names = (C.arts || []).filter((n) => window.ART && window.ART[n]);
          this.arts = this.names.map(parseArt);
        }
        return this.arts;
      },

      // Words wait while the figure changes
      busy() { return this.phase !== 'hold' || this.parts.length > 0; },

      select(k) {
        this.lock = k;
        if (this.phase === 'hold') this.explode();
        else this.phase = null;
      },

      start() {
        if (!this.load().length) return;
        this.parts = this.parts.filter((p) => p.kind === 'out');
        this.i = this.lock !== null ? this.lock : (this.i + 1) % this.arts.length;
        const a = this.arts[this.i];
        this.s = Math.min((W * 0.8) / a.w, (H * 0.86) / a.h);
        // Cells the characters fly into
        this.targets = [];
        for (let y = 0; y < H; y++) {
          const ay = Math.floor((y - H / 2) / this.s + a.h / 2);
          if (ay < 0 || ay >= a.h) continue;
          for (let x = 0; x < W; x++) {
            const ax = Math.floor((x - W / 2) / this.s + a.w / 2);
            if (ax < 0 || ax >= a.w) continue;
            const v = a.v[ay * a.w + ax];
            if (v) this.targets.push({ x, y, v });
          }
        }
        const R = Math.hypot(W, H * 2) * 0.6;
        for (const tg of this.targets) {
          const ang = rand(0, Math.PI * 2);
          this.parts.push({
            kind: 'in', tx: tg.x, ty: tg.y, v: tg.v,
            ox: Math.cos(ang) * R * rand(0.7, 1.2), oy: Math.sin(ang) * R * rand(0.7, 1.2),
            delay: rand(0, 0.45) + (Math.abs(tg.y - H / 2) / H) * 0.3,
            spin: rand(1.2, 2.4) * (Math.random() < 0.5 ? -1 : 1),
          });
        }
        this.phase = 'in';
        this.t = 0;
        this.beats = 0;
        this.echoes = [];
        this.bands = [];
      },

      explode() {
        const a = this.arts[this.i];
        for (const tg of this.targets) {
          if (Math.random() < 0.35) continue;
          const dx = tg.x - W / 2;
          const dy = (tg.y - H / 2) * 2;
          const d = Math.hypot(dx, dy) || 1;
          const sp = rand(15, 60) * (0.7 + A.bass);
          const life = rand(0.7, 1.4);
          this.parts.push({
            kind: 'out', x: tg.x, y: tg.y, v: tg.v, life, max: life,
            vx: (dx / d) * sp + rand(-6, 6), vy: ((dy / d) * sp) / 2 + rand(-4, 2),
            tt: Math.random() < 0.3 ? RED : a.tint,
          });
        }
        this.start();
        for (const p of this.parts) if (p.kind === 'in') p.delay += 0.35;
      },

      // Art at scale s, with row offset rowOff(y) and brightness k(y)
      blit(a, s, dx, k, tt, rowOff) {
        for (let y = 0; y < H; y++) {
          const ay = Math.floor((y - H / 2) / s + a.h / 2);
          if (ay < 0 || ay >= a.h) continue;
          const ro = rowOff ? rowOff(y) : 0;
          const kk = typeof k === 'function' ? k(y) : k;
          for (let x = 0; x < W; x++) {
            const ax = Math.floor((x - ro - dx - W / 2) / s + a.w / 2);
            if (ax < 0 || ax >= a.w) continue;
            const v = a.v[ay * a.w + ax];
            if (v) set(x, y, Math.min(1, v * kk), tt);
          }
        }
      },

      frame(t, dt) {
        if (!this.phase) this.start();
        buf.fill(0);
        glyph.fill(0);
        const sparks = Math.floor(A.high * 40);
        for (let k = 0; k < sparks; k++) set(randInt(0, W - 1), randInt(0, H - 1), rand(0.05, 0.3), PURPLE);
        if (!this.arts.length) return;
        const a = this.arts[this.i];
        this.t += dt;

        if (this.phase === 'hold') {
          if (A.beat) {
            this.beats++;
            this.echoes.push({ s: this.s, k: 0.45 });
            if (Math.random() < 0.5) {
              this.bands = Array.from({ length: randInt(1, 3) }, () => {
                const y0 = randInt(0, H - 1);
                return { y0, y1: y0 + randInt(1, 4), off: randInt(-10, 10) };
              });
            }
          }
          // the figure does not explode while text is on screen
          if (!wordMask) {
            if ((A.beat && this.beats >= (C.artBeats || 16)) || A.drop) return this.explode();
            if (this.t > Math.max(12, (C.artBeats || 16) * 0.9)) return this.explode(); // silence: no beats coming
          }

          // Echoes: copies of the figure spread out on every beat
          const et = a.tint === PURPLE ? GREEN : a.tint === RED ? ORANGE : PURPLE;
          for (const e of this.echoes) {
            e.s *= 1 + dt * 0.9;
            e.k -= dt * 0.55;
            if (e.k > 0) this.blit(a, e.s, 0, e.k, et);
          }
          this.echoes = this.echoes.filter((e) => e.k > 0);

          const s = this.s * (1 + 0.025 * A.bass);
          const scanY = ((t * (0.3 + 0.6 * A.mid)) % 1.4) * H - H * 0.2;
          this.flash = Math.max(0, this.flash - dt * 2);
          const rowOff = (y) => {
            let o = Math.round(Math.sin(y * 0.35 + t * 5) * A.mid * 1.6);
            for (const b of this.bands) if (y >= b.y0 && y <= b.y1) o += Math.round(b.off * A.pulse);
            return o;
          };
          const k = (y) => 0.5 + 0.55 * A.level + this.flash + 0.6 * Math.max(0, 1 - Math.abs(y - scanY) / 2.5);
          this.blit(a, s, 0, k, a.tint, rowOff);
          // Chroma split on beats: red and purple fringes
          if (A.pulse > 0.15) {
            const off = Math.round(1 + A.pulse * 3);
            this.blit(a, s, -off, 0.8 * A.pulse, RED, rowOff);
            this.blit(a, s, off, 0.8 * A.pulse, PURPLE, rowOff);
          }
          // Digital decay: on highs the figure's characters flicker as code
          const rot = A.high * 0.06 + A.pulse * 0.05;
          for (let i = 0; i < W * H; i++) {
            if (buf[i] > 0.3 && Math.random() < rot) glyph[i] = GLYPHS.charCodeAt(randInt(0, GLYPHS.length - 1));
          }
        }

        // Flying characters: assembly and explosion shards
        let flying = 0;
        for (const p of this.parts) {
          if (p.kind === 'in') {
            const q = clamp((this.t - p.delay) / 1.1, 0, 1);
            const e = 1 - Math.pow(1 - q, 3);
            const r = 1 - e;
            const ang = r * p.spin;
            const ox = (p.ox * Math.cos(ang) - p.oy * Math.sin(ang)) * r;
            const oy = (p.ox * Math.sin(ang) + p.oy * Math.cos(ang)) * r;
            const x = Math.round(p.tx + ox);
            const y = Math.round(p.ty + oy / 2);
            if (q < 1) flying++;
            if (q <= 0) continue;
            set(x, y, q < 1 ? 0.35 + 0.6 * e : p.v, a.tint);
            if (q < 1 && x >= 0 && y >= 0 && x < W && y < H) glyph[y * W + x] = GLYPHS.charCodeAt(randInt(0, GLYPHS.length - 1));
          } else {
            p.life -= dt;
            p.vy += 18 * dt;
            p.vx *= 1 - dt * 0.8;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            const x = Math.round(p.x);
            const y = Math.round(p.y);
            set(x, y, p.v * (p.life / p.max), p.tt);
            if (x >= 0 && y >= 0 && x < W && y < H && Math.random() < 0.3) glyph[y * W + x] = GLYPHS.charCodeAt(randInt(0, GLYPHS.length - 1));
          }
        }
        this.parts = this.parts.filter((p) => (p.kind === 'out' ? p.life > 0 : this.phase === 'in'));
        if (this.phase === 'in' && !flying && this.t > 0.5) {
          this.phase = 'hold';
          this.t = 0;
          this.flash = 0.6;
          this.parts = this.parts.filter((p) => p.kind === 'out');
        }
      },
    },

    // Oscilloscope: waveform with a trail
    scope: {
      name: 'NULL SCOPE',
      frame() {
        for (let i = 0; i < W * H; i++) buf[i] *= 0.55;
        for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 2) set(x, y, 0.06, GREEN);
        const mid = Math.floor(H / 2);
        const amp = H * 0.42 * (0.6 + 0.6 * A.level);
        let prev = null;
        let prev2 = null;
        for (let x = 0; x < W; x++) {
          const y = Math.round(mid + waveAt(x) * amp);
          const from = prev === null ? y : prev;
          for (let yy = Math.min(from, y); yy <= Math.max(from, y); yy++) set(x, yy, 1, GREEN);
          set(x, y - 1, 0.45, GREEN);
          set(x, y + 1, 0.45, GREEN);
          prev = y;
          const y2 = Math.round(mid - waveAt(W - 1 - x) * amp * 0.6);
          const from2 = prev2 === null ? y2 : prev2;
          for (let yy = Math.min(from2, y2); yy <= Math.max(from2, y2); yy++) set(x, yy, 0.5, PURPLE);
          prev2 = y2;
        }
      },
    },
  };

  // Key number = position in this list
  const MODES = C.modes.map((n) => ALL[n]).filter(Boolean);
  let mode = 0;
  let modeStart = 0;
  let auto = C.modeSeconds > 0;
  let trans = 0;

  function setMode(i) {
    mode = clamp(i, 0, MODES.length - 1);
    modeStart = performance.now();
    buf.fill(0);
    tint.fill(0);
    glyph.fill(0);
    trans = 0.35; // short digital noise on switch
    if (MODES[mode].enter) MODES[mode].enter();
  }

  function stepMode(d) {
    setMode((mode + d + MODES.length) % MODES.length);
  }

  // ---------- Huge words ----------

  const wordCv = document.createElement('canvas');
  const wctx = wordCv.getContext('2d', { willReadFrequently: true });
  let wordMask = null;
  let wordAge = 0;
  let wordIdx = 0;
  let wordHold = 1.4;

  // Each show is put together at random: font, entrance, exit, fill, color.
  // No part repeats the previous show
  const WORD_FONT = ["900 SIZE Impact, 'Arial Black', sans-serif", "400 SIZE Creepster, Impact, sans-serif"];
  const WORD_IN = ['fade', 'slam', 'decode', 'scan', 'drop'];
  const WORD_OUT = ['fade', 'dissolve', 'slice', 'melt'];
  const WORD_FILL = ['ramp', 'self', 'code', 'outline'];
  const WORD_TINT = [RED, ORANGE, GREEN, PURPLE];
  const IN_T = 0.5, OUT_T = 0.6;
  let ws = null;

  const pickNot = (arr, prev) => {
    const pool = arr.filter((v) => v !== prev);
    return pool[randInt(0, pool.length - 1)];
  };

  // Text in huge letters. Long text is split into lines so the letters come out bigger
  function showWord(text, hold = 1.4) {
    wordCv.width = W;
    wordCv.height = H;
    // Creepster has no Cyrillic
    const face = /[^\x00-\x7f]/.test(text) ? WORD_FONT[0] : pickNot(WORD_FONT, ws && ws.face);
    const setFont = (size) => { wctx.font = face.replace('SIZE', `${size}px`); };
    const words = text.split(/\s+/).filter(Boolean);
    let best = null;
    for (let n = 1; n <= Math.min(4, words.length); n++) {
      const per = Math.ceil(text.length / n);
      const lines = [];
      for (const w of words) {
        const cur = lines[lines.length - 1];
        if (cur && cur.length + 1 + w.length <= per) lines[lines.length - 1] = `${cur} ${w}`;
        else lines.push(w);
      }
      // the canvas is squashed 2x vertically, so 2H is available in height
      let size = Math.min(H * 1.3, (H * 1.8) / lines.length);
      setFont(size);
      const tw = Math.max(...lines.map((l) => wctx.measureText(l).width));
      if (tw > W * 0.92) size *= (W * 0.92) / tw;
      if (!best || size > best.size) best = { size, lines };
    }
    if (!best) return;
    setFont(best.size);
    // cells are twice as tall as wide: squash the text vertically
    wctx.setTransform(1, 0, 0, 0.5, 0, 0);
    wctx.fillStyle = '#fff';
    wctx.textAlign = 'center';
    wctx.textBaseline = 'middle';
    best.lines.forEach((l, k) => wctx.fillText(l, W / 2, H + (k - (best.lines.length - 1) / 2) * best.size));
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = wctx.getImageData(0, 0, W, H).data;
    wordMask = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) wordMask[i] = d[i * 4 + 3] / 255;
    wordAge = 0;
    wordHold = hold;

    // Letter edges, for the outline fill
    const empty = (x, y) => x < 0 || y < 0 || x >= W || y >= H || wordMask[y * W + x] < 0.1;
    const edge = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!empty(x, y) && (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1))) edge[y * W + x] = 1;
      }
    }
    // The "own letters" fill is ASCII only: other characters don't fit in a cell
    const own = text.replace(/[^\x21-\x7e]/g, '');
    let fill = pickNot(WORD_FILL, ws && ws.fill);
    if (fill === 'self' && !own) fill = 'code';
    const tt = pickNot(WORD_TINT, ws && ws.tint);
    ws = {
      face, fill, own, edge,
      in: pickNot(WORD_IN, ws && ws.in),
      out: pickNot(WORD_OUT, ws && ws.out),
      tint: tt,
      edgeTint: pickNot(WORD_TINT, tt),
      rnd: Float32Array.from({ length: W * H }, Math.random),
      col: Float32Array.from({ length: W }, Math.random),
      row: Float32Array.from({ length: H }, () => rand(-1, 1)),
    };
  }

  // While the figure changes, the word waits. Typed text beats automatic words and is not replaced by them
  let pendingWord = null;

  function postWord(text, hold, mine = false) {
    if (MODES[mode].busy && MODES[mode].busy()) {
      if (!pendingWord || mine || !pendingWord.mine) pendingWord = { text, hold, mine };
      return;
    }
    showWord(text, hold);
  }

  function nextWord() {
    if (C.words.length) postWord(C.words[wordIdx++ % C.words.length]);
  }

  function overlayWord(dt) {
    if (!wordMask) return;
    wordAge += dt;
    const t = wordAge;
    const q = t > wordHold ? (t - wordHold) / OUT_T : 0; // exit progress
    if (q >= 1) {
      wordMask = null;
      return;
    }
    if (Math.random() < 0.06) return; // flicker
    const p = Math.min(1, t / IN_T); // entrance progress
    const s = ws;
    const dim = 0.55 * Math.min(1, t / 0.15) * (1 - q); // dim the background so the word reads
    const k = 0.75 + 0.25 * A.level + 0.3 * A.pulse;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let sx = x, sy = y, vis = 1, scramble = false, front = false;
        if (p < 1) {
          switch (s.in) {
            case 'fade': vis = Math.min(1, t / 0.15); break;
            // flies in with torn rows that snap into place
            case 'slam':
              sx += Math.round(s.row[y] * 14 * (1 - p) ** 2);
              scramble = s.rnd[i] < 0.5 * (1 - p);
              break;
            // reveals left to right, characters still scramble behind the front
            case 'decode': {
              const f = (p * 1.25 - x / W) / 0.25;
              if (f < 0) vis = 0;
              else if (f < 1) scramble = s.rnd[i] > f;
              break;
            }
            // top-to-bottom scanner
            case 'scan': {
              const f = p * 1.2 * H - y;
              if (f < 0) vis = 0;
              else if (f < 1.5) front = true;
              break;
            }
            // columns fall from the top at random
            case 'drop': {
              const e = clamp((t - s.col[x] * 0.2) / 0.3, 0, 1);
              sy += Math.round((1 - e) ** 2 * H);
              break;
            }
          }
        }
        if (q > 0) {
          switch (s.out) {
            case 'fade': vis *= 1 - q; break;
            case 'dissolve':
              if (s.rnd[i] < q * 1.1) vis = 0;
              else if (s.rnd[i] < q * 1.6) scramble = true;
              break;
            // rows slide apart in opposite directions
            case 'slice': sx += Math.round((y % 2 ? 1 : -1) * q * q * W * (0.5 + Math.abs(s.row[y]))); break;
            // letters melt down
            case 'melt': sy -= Math.round(q * q * H * (0.3 + s.col[x])); break;
          }
        }
        const m = vis > 0 && sx >= 0 && sy >= 0 && sx < W && sy < H ? wordMask[sy * W + sx] * vis : 0;
        if (m < 0.1) {
          buf[i] *= 1 - dim;
          continue;
        }
        const si = sy * W + sx;
        let v = m * k;
        let tt = s.tint;
        let gl = 0;
        if (s.fill === 'outline') {
          if (s.edge[si]) { v = Math.max(v, 0.9); tt = s.edgeTint; } else v *= 0.3;
        } else if (s.fill === 'self') {
          gl = s.own.charCodeAt((sx + sy * 7) % s.own.length);
        } else if (s.fill === 'code') {
          gl = GLYPHS.charCodeAt(Math.floor(s.rnd[si] * 97 + t * (4 + s.rnd[si] * 10)) % GLYPHS.length);
        }
        if (scramble) gl = GLYPHS.charCodeAt(randInt(0, GLYPHS.length - 1));
        if (front) { v = 1; tt = s.edgeTint; }
        buf[i] = Math.max(buf[i] * 0.3, Math.min(1, v));
        tint[i] = tt;
        glyph[i] = gl;
      }
    }
  }

  // ---------- Overlay effects ----------

  let glitchRows = [];
  let glitchUntil = 0;

  function postFx(now, dt) {
    if (A.beat && Math.random() < 0.45) {
      glitchUntil = now + 110;
      glitchRows = Array.from({ length: randInt(2, 6) }, () => [randInt(0, H - 1), randInt(-12, 12)]);
    }
    if (now < glitchUntil) {
      for (const [y, off] of glitchRows) {
        shiftRow(buf, y, off);
        shiftRow(tint, y, off);
        shiftRow(glyph, y, off);
      }
    }
    if (trans > 0) {
      for (let i = 0; i < W * H; i++) {
        if (Math.random() < trans * 1.6) {
          buf[i] = Math.random();
          tint[i] = randInt(0, 3);
          glyph[i] = 0;
        }
      }
      trans -= dt;
    }
    // Beat flash: everything brightens with the hit strength
    if (A.pulse > 0.05) {
      const f = 1 + 0.7 * A.pulse;
      for (let i = 0; i < W * H; i++) buf[i] = Math.min(1, buf[i] * f);
    }
    glowCv.style.opacity = Math.min(1, 0.45 + 0.35 * A.level + 0.4 * A.pulse).toFixed(2);

    if (A.drop) {
      trans = 0.25;
      glitchUntil = now + 300;
      glitchRows = Array.from({ length: randInt(8, 14) }, () => [randInt(0, H - 1), randInt(-25, 25)]);
      nextWord();
      shake('drop');
    } else if (A.beat && C.shakeOnBeat && A.hit > 0.5) {
      shake('kick');
    }
  }

  function shake(cls) {
    stage.classList.remove('kick', 'drop');
    void stage.offsetWidth;
    stage.classList.add(cls);
  }

  // ---------- Utilities ----------

  let hudUntil = 0;
  let toastTimer = 0;

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 3000);
  }

  function hudTick(now) {
    const el = $('#hud');
    const helpOpen = !$('#help').classList.contains('hidden');
    // while the text field is open, the status line makes room for it
    if ((now > hudUntil && !helpOpen) || !say.classList.contains('hidden')) {
      el.classList.remove('on');
      return;
    }
    el.classList.add('on');
    const meter = '█'.repeat(Math.round(A.level * 10)).padEnd(10, '·');
    const art = MODES[mode] === ALL.art ? ` · fig: ${ALL.art.lock === null ? 'cycle' : ALL.art.names[ALL.art.lock].toUpperCase()}` : '';
    el.textContent = `${mode + 1}. ${MODES[mode].name}${art} · ${auto ? 'auto' : 'manual'} · ${inputName} · sens ${sens.toFixed(1)} · ${meter}`;
  }

  function goFullscreen() {
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().catch(() => {});
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else goFullscreen();
  }

  function enter() {
    $('#start').classList.add('hidden');
    document.body.classList.add('running');
    goFullscreen();
    hudUntil = performance.now() + 3000;
  }

  // Safari's screen sharing gives no audio at all
  const IS_SAFARI = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

  function showMenu() {
    $('#start').classList.remove('hidden');
    document.body.classList.remove('running');
  }

  async function choose(kind) {
    ensureAudio();
    $('#start-error').textContent = '';
    try {
      if (kind === 'files') return $('#file').click(); // continues in the change handler
      if (kind === 'tab') await useTab();
      enter();
    } catch (err) {
      $('#start-error').textContent = kind !== 'tab' ? String(err)
        : IS_SAFARI ? 'Safari cannot share audio: open this page in Chrome, or use music files'
          : 'No audio: pick a TAB with "Share tab audio" on, or ENTIRE SCREEN with "Share system audio" on';
    }
  }

  document.querySelectorAll('[data-input]').forEach((b) => {
    b.addEventListener('click', () => choose(b.dataset.input));
  });

  $('#file').addEventListener('change', (e) => {
    if (useFiles(e.target.files)) enter();
    e.target.value = '';
  });

  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    if (useFiles(e.dataTransfer.files)) enter();
  });

  // ---------- Your own text on screen ----------

  const say = $('#say');
  const sayInput = $('#say-input');
  const sayCount = $('#say-count');
  const textLimit = C.textLimit || 40;
  sayInput.maxLength = textLimit;
  const updateCount = () => { sayCount.textContent = `${sayInput.value.length}/${textLimit}`; };
  sayInput.addEventListener('input', updateCount);

  function openSay() {
    say.classList.remove('hidden');
    sayInput.value = '';
    updateCount();
    sayInput.focus();
  }

  function closeSay() {
    say.classList.add('hidden');
    sayInput.blur();
  }

  // Enter shows it now, Shift+Enter shows it and adds it to the automatic words
  sayInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') return closeSay();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = sayInput.value.trim().toUpperCase();
    closeSay();
    if (!text) return;
    postWord(text, clamp(1.5 + text.length * 0.08, 2.5, 7), true);
    if (e.shiftKey) {
      C.words.push(text);
      toast(`+ added to words: ${text}`);
    }
  });
  sayInput.addEventListener('blur', () => say.classList.add('hidden'));

  addEventListener('keydown', (e) => {
    // leave Cmd+R, Cmd+W and other shortcuts to the browser
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    unlockAudio();
    if (e.code === 'KeyT' && $('#start').classList.contains('hidden')) {
      e.preventDefault(); // otherwise the T ends up in the field
      openSay();
      return;
    }
    if (e.code === 'KeyH') {
      $('#help').classList.toggle('hidden');
      return;
    }
    if (!$('#start').classList.contains('hidden')) {
      const inputs = { Digit1: 'files', Digit2: 'tab' };
      if (inputs[e.code]) choose(inputs[e.code]);
      return;
    }
    switch (e.code) {
      case 'Space':
      case 'ArrowRight': stepMode(1); break;
      case 'ArrowLeft': stepMode(-1); break;
      case 'KeyA': auto = !auto; modeStart = performance.now(); break;
      case 'KeyW': nextWord(); break;
      // G: cycle → first figure → second → … → cycle again
      case 'KeyG': {
        const art = ALL.art;
        const k = MODES.indexOf(art);
        if (k < 0 || !art.load().length) break;
        if (mode !== k) setMode(k);
        const next = art.lock === null ? 0 : art.lock + 1;
        art.select(next < art.arts.length ? next : null);
        // a locked figure holds the screen, cycling restores auto rotation from the config
        auto = art.lock === null && C.modeSeconds > 0;
        modeStart = performance.now();
        break;
      }
      case 'ArrowUp': sens = Math.min(1, Math.round(sens * 10 + 1) / 10); break;
      case 'ArrowDown': sens = Math.max(0.2, Math.round(sens * 10 - 1) / 10); break;
      case 'KeyN':
        if (playlist.length) {
          track = (track + 1) % playlist.length;
          playTrack();
        }
        break;
      case 'KeyM': showMenu(); break;
      case 'KeyF': toggleFullscreen(); break;
      default: {
        const m = /^Digit([1-9])$/.exec(e.code);
        if (!m || +m[1] > MODES.length) return;
        setMode(+m[1] - 1);
      }
    }
    e.preventDefault();
    hudUntil = performance.now() + 2500;
  });

  // ---------- Loop ----------

  let last = performance.now();

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    analyse(now);
    if (auto && C.modeSeconds > 0 && now - modeStart > C.modeSeconds * 1000) stepMode(1);
    MODES[mode].frame(now / 1000, dt);
    if (A.beat && C.wordEveryBeats > 0 && A.beats % C.wordEveryBeats === 0) nextWord();
    if (pendingWord && !(MODES[mode].busy && MODES[mode].busy())) {
      showWord(pendingWord.text, pendingWord.hold);
      pendingWord = null;
    }
    overlayWord(dt);
    postFx(now, dt);
    draw();
    hudTick(now);
  }

  resize();
  addEventListener('resize', resize);
  setMode(0);
  requestAnimationFrame(loop);
})();
