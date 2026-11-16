/* Pixel art dessiné par le code : portraits qui vieillissent et scènes des moments de la vie.
   Aucune image externe : chaque scène est une petite grille de pixels convertie en SVG. */
(function () {
  const PX = {};

  // ---------- Générateur pseudo-aléatoire stable (même vie = mêmes visages) ----------
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const pickR = (r, arr) => arr[Math.floor(r() * arr.length)];

  // ---------- Tampon de pixels ----------
  function Buf(w, h) { this.w = w; this.h = h; this.p = new Array(w * h).fill(null); }
  Buf.prototype.set = function (x, y, c) { x = Math.round(x); y = Math.round(y); if (!c || x < 0 || y < 0 || x >= this.w || y >= this.h) return; this.p[y * this.w + x] = c; };
  Buf.prototype.rect = function (x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); };
  Buf.prototype.spr = function (rows, pal, x, y, flip) {
    rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const ch = row[flip ? row.length - 1 - i : i]; if (ch !== '.' && pal[ch]) this.set(x + i, y + j, pal[ch]); } });
  };
  Buf.prototype.body = function () {
    let out = '';
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.p[y * this.w + x];
        if (!c) { x++; continue; }
        let e = x + 1;
        while (e < this.w && this.p[y * this.w + e] === c) e++;
        out += '<rect x="' + x + '" y="' + y + '" width="' + (e - x) + '" height="1" fill="' + c + '"/>';
        x = e;
      }
    }
    return out;
  };
  Buf.prototype.svg = function (attrs) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + this.w + ' ' + this.h + '" shape-rendering="crispEdges" ' + (attrs || '') + '>' + this.body() + '</svg>';
  };

  // ---------- Couleurs selon la région ----------
  const SKINS = {
    ssa: ['#5b3a29', '#7a4a30', '#8d5a3b'], sa: ['#a8714a', '#8d5a3b', '#c08a5e'], mena: ['#c8996b', '#b27d52', '#d9ad82'],
    eap: ['#e8c39e', '#dcae82', '#f0cfae'], lac: ['#c08a5e', '#a8714a', '#d9ad82'], eca: ['#f1cfb0', '#e3b88f', '#f6dcc4'], hi: ['#f1cfb0', '#e3b88f', '#d9ad82', '#f6dcc4'],
  };
  const HAIR = ['#1f1410', '#2b1a10', '#3a2416', '#5a3a1e'];
  const BLOND = ['#c9a35a', '#d8b878', '#a0522d'];
  const SHIRTS = ['#2f7f79', '#8c1d3c', '#3d5a99', '#d08a2e', '#6a8d3a', '#7b4a8c', '#c9564a'];
  const PANTS = ['#35405a', '#4a3b2c', '#2b2b2b', '#5a6470'];
  function casting(country, r) {
    const reg = (country && country.region) || 'hi';
    const skin = pickR(r, SKINS[reg] || SKINS.hi);
    const light = reg === 'hi' || reg === 'eca';
    const hair = light && r() < 0.35 ? pickR(r, BLOND) : pickR(r, HAIR);
    return { skin, hair, shirt: pickR(r, SHIRTS), pants: pickR(r, PANTS) };
  }

  // ---------- Personnages ----------
  const ADULT = ['..hhhh..', '.hhhhhh.', '.hssssh.', '.sesses.', '..ssss..', '.cccccc.', 'sccccccs', '.cccccc.', '.cccccc.', '.pp..pp.', '.pp..pp.', '.bb..bb.'];
  const CHILD = ['.hhhh.', '.hsssh', '.esse.', '.cccc.', 'sccccs', '.cccc.', '.p..p.', '.b..b.'];
  const BABY = ['.sss.', 'seses', 'wwwww', 'wwwww'];
  const CANE = ['k', 'k', 'k', 'k', 'k', 'k', 'k', 'k'];
  const DARK = '#241a14', SHOE = '#2b2018';
  function person(buf, x, groundY, kind, c, o) {
    o = o || {};
    const pal = { h: o.hair || c.hair, s: c.skin, e: DARK, c: o.shirt || c.shirt, p: o.pants || c.pants, b: SHOE, w: '#f4efe6', k: '#6b4a2a' };
    if (kind === 'baby') { buf.spr(BABY, pal, x, groundY - 4); return; }
    if (kind === 'child') { buf.spr(CHILD, pal, x, groundY - CHILD.length, o.flip); return; }
    if (kind === 'elder') { pal.h = '#d9d6cf'; buf.spr(ADULT, pal, x, groundY - ADULT.length, o.flip); buf.spr(CANE, pal, x + (o.flip ? -1 : 8), groundY - 8); return; }
    buf.spr(ADULT, pal, x, groundY - ADULT.length, o.flip);
  }

  // ---------- Décors ----------
  function parse(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
  function sky(buf, a, b, h) {
    const pa = parse(a), pb = parse(b), bands = 6;
    for (let k = 0; k < bands; k++) {
      const t = k / (bands - 1), col = '#' + [0, 1, 2].map(i => Math.round(pa[i] + (pb[i] - pa[i]) * t).toString(16).padStart(2, '0')).join('');
      buf.rect(0, Math.floor(k * h / bands), buf.w, Math.ceil(h / bands) + 1, col);
    }
  }
  function cloud(buf, x, y) { buf.rect(x + 2, y, 6, 2, '#fff'); buf.rect(x, y + 1, 10, 2, '#fff'); buf.rect(x + 3, y - 1, 3, 1, '#fff'); }
  function sun(buf, x, y, c) { buf.rect(x - 2, y - 1, 5, 3, c || '#ffe38a'); buf.rect(x - 1, y - 2, 3, 5, c || '#ffe38a'); }
  function ground(buf, y, color, line) { buf.rect(0, y, buf.w, buf.h - y, color); if (line) buf.rect(0, y, buf.w, 1, line); }
  function city(buf, baseY, color, r) {
    let x = 0;
    while (x < buf.w) {
      const w = 5 + Math.floor(r() * 5), h = 6 + Math.floor(r() * 10);
      buf.rect(x, baseY - h, w, h, color);
      for (let wy = baseY - h + 2; wy < baseY - 1; wy += 3) for (let wx = x + 1; wx < x + w - 1; wx += 2) if (r() < 0.45) buf.set(wx, wy, '#e9f3f8');
      x += w + 1;
    }
  }
  function tree(buf, x, groundY, big) { const h = big ? 9 : 6; buf.rect(x + 1, groundY - 3, 2, 3, '#6b4a2a'); buf.rect(x - 1, groundY - h, 6, h - 3, '#4f9a4a'); buf.rect(x, groundY - h - 1, 4, 1, '#5fb05a'); }
  function house(buf, x, groundY, wall, roof) {
    wall = wall || '#f4efe6'; roof = roof || '#b5433c';
    buf.rect(x, groundY - 9, 15, 9, wall);
    for (let k = 0; k < 6; k++) buf.rect(x - 1 + k, groundY - 15 + k, 17 - 2 * k, 1, roof);
    buf.rect(x + 6, groundY - 6, 3, 6, '#7b4a2a'); buf.rect(x + 2, groundY - 7, 3, 3, '#f2c85a'); buf.rect(x + 10, groundY - 7, 3, 3, '#f2c85a'); buf.rect(x + 11, groundY - 15, 2, 4, '#7b4a2a');
  }
  function heart(buf, x, y, c) { [[1, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [1, 2], [2, 2], [3, 2], [2, 3]].forEach(([i, j]) => buf.set(x + i, y + j, c || '#e0476a')); }
  function bunting(buf, y) { const cols = ['#e0476a', '#f2c85a', '#2f7f79', '#3d5a99']; for (let x = 4; x < buf.w - 4; x += 4) { const dy = Math.round(Math.sin(x / 9)); buf.set(x, y + dy, '#555'); buf.set(x + 1, y + 1 + dy, cols[(x / 4) % 4 | 0]); } }

  // ---------- Scènes ----------
  const W = 104, H = 34, G = 29;   // largeur, hauteur, ligne de sol
  const SCENES = {
    house(b, c, r, L) {
      sky(b, '#9fd3ea', '#d8ecd0', G); cloud(b, 8, 5); cloud(b, 70, 8); sun(b, 92, 6); ground(b, G, '#8fc275', '#7aae62'); house(b, 20, G); tree(b, 4, G, true);
      person(b, 44, G, 'adult', c, { shirt: '#2f7f79' });
      const kids = Math.min(3, ((L && L.stats && L.stats.kids) || []).length || (L && L.age < 18 ? 1 : 0));
      for (let k = 0; k < kids; k++) person(b, 56 + k * 8, G, 'child', c, { shirt: SHIRTS[(k + 2) % SHIRTS.length] });
    },
    baby(b, c) { sky(b, '#f6d6c0', '#f9e9d8', G); ground(b, G, '#d9b98b', '#c9a875'); house(b, 62, G, '#fbf3e4', '#c9564a'); person(b, 28, G, 'adult', c, { shirt: '#c9564a' }); person(b, 40, G, 'baby', c); heart(b, 18, 9); },
    school(b, c) {
      sky(b, '#9fd3ea', '#e6f1dc', G); cloud(b, 10, 5); ground(b, G, '#8fc275', '#7aae62');
      b.rect(24, G - 13, 40, 13, '#efe3c6'); b.rect(24, G - 14, 40, 1, '#b5433c');
      for (let k = 0; k < 4; k++) b.rect(28 + k * 9, G - 9, 5, 4, '#7fb7d8');
      b.rect(42, G - 6, 4, 6, '#7b4a2a'); b.rect(44, G - 20, 1, 6, '#555'); b.rect(45, G - 20, 4, 3, '#e0476a'); bunting(b, 6);
      [8, 16, 70, 78, 88].forEach((x, i) => person(b, x, G, 'child', c, { shirt: SHIRTS[i % SHIRTS.length] }));
    },
    office(b, c, r) {
      b.rect(0, 0, W, H, '#eceae6'); b.rect(10, 3, 84, 16, '#9ccbe4'); city(b, 19, '#7fa9c4', r);
      for (let k = 1; k < 8; k++) b.rect(10 + k * 10, 3, 1, 16, '#b9b9b9');
      b.rect(10, 3, 84, 1, '#b9b9b9'); b.rect(0, 26, W, 1, '#7b4a2a'); b.rect(0, 27, W, 7, '#e4e1da');
      for (let k = 0; k < 3; k++) {
        const x = 18 + k * 26;
        b.rect(x - 2, 21, 14, 1, '#7b4a2a'); b.rect(x + 7, 18, 5, 3, '#3d8fd0'); b.rect(x + 8, 21, 3, 1, '#555'); b.rect(x - 1, 22, 1, 4, '#7b4a2a'); b.rect(x + 11, 22, 1, 4, '#7b4a2a');
        person(b, x, 26, 'adult', k === 0 ? c : casting({ region: ['hi', 'sa', 'ssa'][k] }, rng(k + 7)), {});
      }
      b.rect(95, 15, 5, 4, '#fff'); b.rect(96, 11, 3, 4, '#5fb05a');
    },
    wedding(b, c) {
      sky(b, '#f9d9c8', '#fdf0dc', G); ground(b, G, '#b9d98f', '#a6c87c');
      b.rect(36, 6, 32, 2, '#f4efe6'); b.rect(36, 6, 2, 23, '#f4efe6'); b.rect(66, 6, 2, 23, '#f4efe6');
      for (let x = 38; x < 66; x += 3) b.set(x, 8, ['#e0476a', '#f2c85a', '#fff'][(x / 3) % 3 | 0]);
      person(b, 43, G, 'adult', c, { shirt: '#2a2a3a', pants: '#2a2a3a' });
      person(b, 53, G, 'adult', casting({ region: 'hi' }, rng(5)), { shirt: '#ffffff', pants: '#f6f0e6', hair: '#2b1a10' });
      heart(b, 49, 3);
      for (let k = 0; k < 8; k++) b.set(10 + k * 11, 22 + (k % 3), ['#e0476a', '#f2c85a', '#fff'][k % 3]);
    },
    hospital(b, c) {
      sky(b, '#cfe7f2', '#eef6f6', G); ground(b, G, '#c9ccd0', '#b3b7bc');
      b.rect(26, G - 22, 40, 22, '#f4f6f6'); b.rect(26, G - 23, 40, 1, '#b3b7bc');
      b.rect(43, G - 21, 6, 2, '#d4443c'); b.rect(45, G - 23, 2, 6, '#d4443c'); b.rect(44, G - 22, 4, 4, '#d4443c');
      for (let k = 0; k < 4; k++) b.rect(30 + k * 9, G - 14, 5, 4, '#9ccbe4');
      b.rect(44, G - 7, 5, 7, '#7fb7d8');
      person(b, 74, G, 'adult', c, { shirt: '#ffffff', pants: '#cfd6dc' }); person(b, 14, G, 'adult', c, {});
    },
    cemetery(b, c, r) {
      sky(b, '#d7a99a', '#e9cdb6', G); city(b, G, '#a9b8c4', r); ground(b, G, '#b9b9a8', '#a8a897');
      b.rect(50, G - 13, 6, 9, '#e8e4dc'); b.rect(51, G - 12, 4, 6, '#cfc9be'); b.rect(52, G - 16, 2, 4, '#444'); b.rect(51, G - 15, 4, 1, '#444');
      b.rect(46, G - 3, 14, 3, '#7b4a2a'); for (let x = 46; x < 60; x += 3) b.set(x, G - 4, '#f4efe6');
      person(b, 30, G, 'elder', c, { shirt: '#3a3f4a', pants: '#2b2b33' });
      person(b, 72, G, 'elder', casting({ region: 'hi' }, rng(9)), { shirt: '#3a3f4a', pants: '#2b2b33', flip: true });
      cloud(b, 6, 4); cloud(b, 78, 6);
      [8, 90].forEach(x => { b.rect(x, G - 5, 3, 5, '#d8d4ca'); b.rect(x, G - 6, 3, 1, '#d8d4ca'); });
    },
    migration(b, c) {
      sky(b, '#8fc1e8', '#e8f0f7', G); cloud(b, 12, 6); cloud(b, 60, 10);
      b.rect(76, 6, 12, 2, '#fff'); b.rect(80, 4, 3, 6, '#fff'); b.rect(86, 5, 2, 1, '#d4443c');
      ground(b, G, '#9a9a96', '#85857f'); for (let x = 0; x < W; x += 8) b.rect(x, G + 2, 4, 1, '#fff');
      person(b, 40, G, 'adult', c, {}); b.rect(52, G - 6, 6, 6, '#c9564a'); b.rect(54, G - 8, 2, 2, '#555');
      b.rect(10, G - 9, 3, 9, '#6b6b66'); b.rect(8, G - 10, 7, 2, '#3d5a99');
    },
    retire(b, c) {
      sky(b, '#f2b97a', '#fbe3b8', G); sun(b, 20, 20, '#ffd27a'); ground(b, G, '#9bc37a', '#86ad66'); tree(b, 70, G, true); tree(b, 86, G, true);
      b.rect(34, G - 5, 16, 1, '#7b4a2a'); b.rect(35, G - 4, 1, 4, '#7b4a2a'); b.rect(48, G - 4, 1, 4, '#7b4a2a'); b.rect(34, G - 9, 16, 1, '#7b4a2a');
      person(b, 38, G - 4, 'elder', c, {}); person(b, 7, G, 'child', c, { shirt: '#d08a2e' });
    },
    friends(b, c) {
      sky(b, '#9fd3ea', '#e6f1dc', G); cloud(b, 70, 4); sun(b, 10, 6); ground(b, G, '#8fc275', '#7aae62'); tree(b, 6, G, true); tree(b, 92, G, true);
      [30, 44, 58].forEach((x, i) => person(b, x, G, 'adult', i === 0 ? c : casting({ region: ['sa', 'hi', 'ssa'][i] }, rng(i + 3)), { flip: i === 2 }));
      heart(b, 44, 8, '#f2c85a'); bunting(b, 4);
    },
    love(b, c) {
      sky(b, '#f4b6c2', '#fbe0d0', G); ground(b, G, '#d9c39a', '#c8b185');
      person(b, 40, G, 'adult', c, {}); person(b, 54, G, 'adult', casting({ region: 'hi' }, rng(11)), { flip: true, shirt: '#e0476a' });
      heart(b, 46, 6); heart(b, 38, 12, '#f08fa6'); heart(b, 60, 11, '#f08fa6'); tree(b, 10, G, true); tree(b, 88, G, true);
    },
    gym(b, c) {
      b.rect(0, 0, W, H, '#e6e8e6'); b.rect(14, 4, 76, 14, '#a9cde0'); b.rect(0, 26, W, 1, '#7b4a2a'); b.rect(0, 27, W, 7, '#e0dcd4');
      person(b, 48, 26, 'adult', c, { shirt: '#3d5a99' });
      b.rect(40, 12, 24, 1, '#444'); b.rect(38, 10, 3, 5, '#2b2b2b'); b.rect(63, 10, 3, 5, '#2b2b2b'); b.rect(80, 19, 10, 7, '#2b2b33');
    },
    herd(b, c) {
      sky(b, '#9fd3ea', '#e9f1d8', 22); sun(b, 90, 6); cloud(b, 12, 6); ground(b, 22, '#b8c77a', '#a6b568'); b.rect(0, 24, W, 10, '#a9b866');
      for (let k = 0; k < 4; k++) { const x = 14 + k * 20; b.rect(x, 22, 8, 4, '#f4efe6'); b.rect(x + 7, 21, 3, 3, '#f4efe6'); b.rect(x + 1, 26, 1, 3, '#cfc9be'); b.rect(x + 6, 26, 1, 3, '#cfc9be'); b.set(x + 9, 21, '#333'); }
      person(b, 92, 31, 'adult', c, { shirt: '#d08a2e' });
    },
    market(b, c) {
      sky(b, '#f9d9a8', '#fdf0d0', G); ground(b, G, '#d9b98b', '#c9a875');
      b.rect(24, 9, 46, 3, '#c9564a'); for (let x = 24; x < 70; x += 6) b.rect(x, 9, 3, 3, '#f4efe6');
      b.rect(26, 12, 2, 17, '#7b4a2a'); b.rect(66, 12, 2, 17, '#7b4a2a'); b.rect(26, 22, 42, 3, '#7b4a2a');
      for (let k = 0; k < 7; k++) b.rect(28 + k * 6, 19, 4, 3, ['#e0476a', '#f2c85a', '#5fb05a'][k % 3]);
      person(b, 40, G, 'adult', c, {}); person(b, 78, G, 'adult', casting({ region: 'ssa' }, rng(21)), { flip: true });
    },
    park(b, c) { sky(b, '#9fd3ea', '#e6f1dc', G); cloud(b, 14, 5); sun(b, 88, 6); ground(b, G, '#8fc275', '#7aae62'); tree(b, 10, G, true); tree(b, 80, G, true); person(b, 46, G, 'adult', c, {}); },
  };

  // ---------- Choix de la scène d'après l'évènement ----------
  const MAP = [
    [/🎓|📚|🎒|🧑‍🏫|📖|✏️/, 'school'], [/💍|💒|💐/, 'wedding'], [/👶|🍼|🧒/, 'baby'], [/🕯|🕊|✝|🥀|🌹|⚰/, 'cemetery'],
    [/🏥|💉|🩺|🤒|😷|🩸|💊|🫀|🧬|😮‍💨|⚠️|🤧|🤕|🤢|🌡|😰|😨/, 'hospital'], [/✈|🧳|🌍|🚤|🛂|🚌|📦|🚚/, 'migration'], [/🏖|🪑|🌻|👵|👴|🌅/, 'retire'],
    [/❤|💞|💌|💔|💘/, 'love'], [/💼|🏭|📈|🛠|📉|💶|📊|🧾|⚙/, 'office'], [/🏋|⚽|🏃|🥇|🏆/, 'gym'], [/🐄|🐑|🐐|🐪|🐃|🐂|🌾/, 'herd'],
    [/🧺|🛒|🥣|🍲|🧶|🍚|🥛/, 'market'], [/🤝|👥|🎉|🥂|☎|📞|🎂|🍵|🔔|🎲|💃|🥁|🎵|🎶|🎈|🧑‍🤝‍🧑/, 'friends'], [/🏠|🔑|🧱|🏡|🔧|🌳|📷|🛌|🪟|🧸|🎨|🗣|🐕|🐈|🐶/, 'house'],
  ];
  PX.keyFor = function (entry, life) {
    const ic = (entry && entry.icon) || '';
    for (const [re, key] of MAP) if (re.test(ic)) return key;
    const a = life ? life.age : 30;
    return a < 14 ? 'house' : a >= 65 ? 'retire' : 'park';
  };
  PX.scene = function (key, life, seedExtra) {
    const f = SCENES[key] || SCENES.park;
    const nm = life && life.name ? (life.name.full || life.name.full_en || '') : '';
    const seed = hash(String(nm) + '|' + ((life && life.country) || '') + (seedExtra || ''));
    const r = rng(seed), c = casting(life && life.countryData, rng(seed ^ 0x9e3779b9));
    const b = new Buf(W, H);
    f(b, c, r, life);
    return b.svg('class="px-scene" preserveAspectRatio="xMidYMid slice"');
  };

  // ---------- Portrait qui vieillit ----------
  function shade(hex) { const p = parse(hex); return '#' + p.map(v => Math.max(0, v - 38).toString(16).padStart(2, '0')).join(''); }
  PX.portrait = function (country, age, sex, life) {
    const nm = life && life.name ? (life.name.full || life.name.full_en || '') : 'p';
    const seed = hash(String(nm) + '|' + ((country && country.id) || ''));
    const c = casting(country, rng(seed ^ 0x9e3779b9));
    const b = new Buf(24, 24);
    const baby = age < 3, child = age < 13, elder = age >= 65, female = sex === 'F';
    const hairC = elder ? '#d9d6cf' : age >= 50 ? '#8a857d' : c.hair, skin = c.skin, dark = DARK;
    const shirt = baby ? '#f4efe6' : c.shirt;
    const sy = baby ? 20 : child ? 19 : 18;
    b.rect(baby ? 6 : 4, sy, baby ? 12 : 16, 24 - sy, shirt);   // épaules
    b.rect(10, sy - 2, 4, 3, skin);                               // cou
    if (female && !baby) { b.rect(6, 6, 2, elder ? 9 : 12, hairC); b.rect(16, 6, 2, elder ? 9 : 12, hairC); }   // cheveux longs
    const top = baby ? 5 : 4;
    b.rect(8, top + 1, 8, 12, skin); b.rect(7, top + 2, 10, 10, skin);   // tête
    if (baby) { b.rect(10, 4, 4, 1, hairC); b.set(12, 3, hairC); }
    else if (!(elder && !female && age >= 75)) { b.rect(7, top, 10, 3, hairC); b.rect(6, top + 1, 1, 4, hairC); b.rect(17, top + 1, 1, 4, hairC); if (!female && !elder) b.rect(8, top + 3, 3, 1, hairC); if (female) b.rect(8, top + 3, 8, 1, hairC); }
    else { b.rect(7, top + 1, 2, 4, '#d9d6cf'); b.rect(15, top + 1, 2, 4, '#d9d6cf'); }   // couronne de cheveux blancs
    const ey = baby ? 10 : 9;
    b.rect(9, ey, 1, 2, dark); b.rect(14, ey, 1, 2, dark);
    if (baby) { b.set(9, ey - 1, '#fff'); b.set(14, ey - 1, '#fff'); }
    if (elder) { b.rect(8, ey - 1, 3, 1, '#555'); b.rect(13, ey - 1, 3, 1, '#555'); b.rect(8, ey + 2, 3, 1, '#555'); b.rect(13, ey + 2, 3, 1, '#555'); b.rect(11, ey, 2, 1, '#555'); }   // lunettes
    if (age >= 55) { const sh = shade(skin); b.set(8, 12, sh); b.set(15, 12, sh); b.set(9, 8, sh); b.set(14, 8, sh); }   // rides
    const mood = life && life.stats ? life.stats.happiness : 70;
    if (mood >= 60) { b.set(10, 13, dark); b.rect(11, 14, 2, 1, dark); b.set(13, 13, dark); }
    else if (mood >= 40) b.rect(10, 14, 4, 1, dark);
    else { b.set(10, 14, dark); b.rect(11, 13, 2, 1, dark); b.set(13, 14, dark); }
    if (life && life.smoker && age >= 14) { b.rect(14, 14, 3, 1, '#f4efe6'); b.set(17, 14, '#e8742a'); b.set(18, 12, '#b9b9b9'); b.set(18, 10, '#d0d0d0'); }
    if (!female && age >= 35 && c.hair !== '#c9a35a' && hash(nm + 'b') % 3 === 0) b.rect(8, 14, 8, 1, shade(hairC));   // barbe
    const flag = country && country.flag ? '<text x="1" y="23.5" font-size="5">' + country.flag + '</text>' : '';
    return '<svg viewBox="0 0 24 24" width="200" height="200" shape-rendering="crispEdges" style="display:block;margin:0 auto"><circle cx="12" cy="12" r="12" fill="#f5efe2"/>' + b.body() + flag + '</svg>';
  };

  window.PX = PX;
})();
