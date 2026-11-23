/* AliExpress Debloater — modo escuro "de verdade" (sem inverter cores).
 *
 * Camadas, da base até a rede de segurança:
 *   1. dark.css      fundo base e ajustes fixos de partes conhecidas do site
 *   2. Elementos     lê as cores computadas de cada elemento e escurece fundos claros,
 *                    clareia textos escuros, escurece bordas e SVGs
 *   3. Folhas        lê o CSS do site e cria a versão escura de:
 *                      - estados :hover/:focus/:active com fundo claro
 *                      - componentes que só aparecem depois (janelas, menus suspensos,
 *                        popovers, tooltips...), para abrirem já escuros, sem flash branco
 *   4. Imagens       ícones pretos são invertidos; faixas largas com imagem de fundo branca
 *                    (ex.: cabeçalho do carrinho) são mescladas com o fundo escuro
 *   5. Varredura     de tempos em tempos e ao parar de rolar, procura o que ainda está claro
 *                    na área visível e reprocessa (pega estilos trocados direto no elemento,
 *                    que nenhum observador vê)
 *
 * Cores com matiz (preço vermelho, selos, botões) e fotos ficam como estão. Tudo só vale com
 * <html data-adb-dark>, então desligar o modo não exige desfazer nada nos elementos.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const FLAG = 'data-adb-dark';
  const CANVAS_L = 0.07;                 // luminância do fundo base (#12141a)
  const BASE_BG = 'rgba(18,20,26,1)';    // #12141a
  const URL_RE = /url\(["']?([^"')]+)["']?\)/;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'HEAD', 'TITLE', 'BR',
    'IMG', 'VIDEO', 'CANVAS', 'SOURCE', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);

  let enabled = false;
  let observer = null;
  let cache = new WeakMap();             // elemento -> decisões da análise
  const fresh = new WeakSet();           // reler sem as marcações atuais (classe mudou)
  const queue = [];                      // elementos pendentes (lidos a partir de qHead)
  let qHead = 0;
  let scheduled = false;

  /* =====================================================================
     Cores
     ===================================================================== */

  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  const gray = (c) => (c.r + c.g + c.b) / 3;
  const neutral = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 28;
  const isLightNeutral = (c, minLum, minAlpha) => !!c && c.a >= minAlpha && neutral(c) && lum(c) > minLum;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const rgba = (r, g, b, a) => `rgba(${clamp(r)},${clamp(g)},${clamp(b)},${a})`;

  // fundo claro -> escuro (branco => #12141a; cinzas claros ficam um pouco mais claros)
  const mapBg = (c) => {
    const o = 18 + (255 - gray(c)) * 0.5;
    return rgba(o, o + 2, o + 8, c.a);
  };
  // hover: um pouco MAIS claro que o fundo, senão o destaque some
  const mapHoverBg = (c) => {
    const o = 34 + (255 - gray(c)) * 0.4;
    return rgba(o, o + 2, o + 8, c.a);
  };
  // texto escuro -> claro (preto => ~#ebebeb; cinzas médios ficam mais apagados)
  const mapFg = (c) => {
    const o = 235 - gray(c) * 0.6;
    return rgba(o, o, o + 4, c.a);
  };
  // cor com matiz e escura demais -> mistura com branco (mantém o tom)
  const lighten = (c) => rgba(c.r + (255 - c.r) * 0.55, c.g + (255 - c.g) * 0.55, c.b + (255 - c.b) * 0.55, c.a);
  // borda clara -> escura
  const mapBd = (c) => {
    const o = 40 + (255 - gray(c)) * 0.4;
    return rgba(o, o + 1, o + 7, c.a);
  };

  // true se for um degradê (sem imagem) composto só de cores claras e neutras
  function isLightGradient(bi) {
    if (!/gradient\(/.test(bi) || /url\(/.test(bi)) return false;
    const cols = (bi.match(/rgba?\([^)]*\)/g) || []).map(parse).filter((c) => c && c.a > 0.05);
    return cols.length > 0 && cols.every((c) => neutral(c) && lum(c) > 0.8);
  }

  /* =====================================================================
     Regras geradas para as marcações (data-adb-b="3" -> background-color...)
     ===================================================================== */

  const PROP = {
    b: 'background-color',
    f: 'color',
    d: 'border-color',
    s: 'fill',
    g: 'background-image',
  };
  const MARKS = Object.keys(PROP);
  const known = new Map();               // "tipo|valor" -> id da regra
  let markStyle = null;

  function ruleId(kind, value) {
    const key = `${kind}|${value}`;
    let id = known.get(key);
    if (id === undefined) {
      id = known.size;
      known.set(key, id);
      if (!markStyle) markStyle = addStyle('adb-dark-dyn');
      markStyle.appendChild(document.createTextNode(
        `html[${FLAG}] [data-adb-${kind}="${id}"]{${PROP[kind]}:${value}!important}\n`
      ));
    }
    return id;
  }

  function addStyle(id) {
    const st = document.createElement('style');
    st.id = id;
    root.appendChild(st);
    return st;
  }

  /* =====================================================================
     Camada 2 — análise de cada elemento
     ===================================================================== */

  // Luminância do fundo efetivo do elemento (já considerando o escurecimento)
  function effLum(el) {
    const info = cache.get(el);
    if (info) return info.eff;
    const parent = el.parentElement;
    return analyze(el, parent ? effLum(parent) : CANVAS_L).eff;
  }

  // Lê (sem escrever) e devolve as decisões; o cache evita reanalisar
  function analyze(el, parentL) {
    const cs = getComputedStyle(el);
    const info = { eff: parentL, b: null, f: null, d: null, s: null, g: false, mix: false };
    cache.set(el, info);

    const bg = parse(cs.backgroundColor);
    let hasImg = cs.backgroundImage !== 'none';
    if (hasImg && isLightGradient(cs.backgroundImage)) {
      info.g = true;           // degradê branco/cinza claro: remove e deixa o fundo escuro aparecer
      hasImg = false;
    }

    if (hasImg && isWhiteBanner(el, cs)) {
      // Faixa com imagem branca: mescla com fundo escuro (camada 4) e trata como fundo escuro
      info.mix = true;
      if (!(bg && bg.a > 0.5 && !neutral(bg))) info.b = BASE_BG;
      info.eff = CANVAS_L;
    } else if (hasImg) {
      info.eff = 0.6;          // imagem: não dá para saber o fundo, mantém textos como estão
      // Cor de fundo clara por trás da imagem (ex.: PNG transparente sobre branco): escurece
      if (isLightNeutral(bg, 0.72, 0.5)) info.b = mapBg(bg);
      checkBgIcon(el, cs);
    } else if (bg && bg.a > 0.05) {
      if (neutral(bg) && lum(bg) > 0.72) {
        info.b = mapBg(bg);
        if (bg.a > 0.5) info.eff = lum(parse(info.b));
      } else if (bg.a > 0.5) {
        info.eff = lum(bg);    // cor com matiz (selo amarelo etc.): mantém e guarda a luminância
      }
    }

    const fg = parse(cs.color);
    if (fg && fg.a > 0.05 && info.eff < 0.45) {
      if (neutral(fg)) {
        if (lum(fg) < 0.55) info.f = mapFg(fg);
      } else if (lum(fg) < 0.3) {
        info.f = lighten(fg);  // texto colorido muito escuro (marrom, azul-marinho...): clareia mantendo o matiz
      }
    }

    const bw = parseFloat(cs.borderTopWidth) || parseFloat(cs.borderBottomWidth) ||
               parseFloat(cs.borderLeftWidth) || parseFloat(cs.borderRightWidth);
    if (bw > 0) {
      const bc = parse(cs.borderTopColor) || parse(cs.borderBottomColor);
      if (isLightNeutral(bc, 0.7, 0.05)) info.d = mapBd(bc);
    }

    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') {
      const fl = parse(cs.fill);
      if (fl && fl.a > 0.05 && neutral(fl) && lum(fl) < 0.55) info.s = mapFg(fl);
    }
    return info;
  }

  // Só ADICIONA marcações, nunca remove. Reler um elemento já escurecido enxerga fundo escuro e
  // texto claro (nada a fazer); se isso apagasse as marcações, a página voltaria ao claro e
  // seria remarcada em seguida (piscar). Quem precisa de releitura "limpa" chama stripMarks antes.
  function apply(el, info) {
    for (const k of ['b', 'f', 'd', 's']) {
      if (info[k]) el.setAttribute(`data-adb-${k}`, ruleId(k, info[k]));
    }
    if (info.g) el.setAttribute('data-adb-g', ruleId('g', 'none'));
    if (info.mix) el.setAttribute('data-adb-mix', '');
  }

  function stripMarks(el) {
    for (const k of MARKS) el.removeAttribute(`data-adb-${k}`);
    el.removeAttribute('data-adb-mix');
  }

  // Esquece a análise do elemento e de tudo dentro dele e reprocessa (os textos de dentro
  // dependem do fundo dele)
  function reprocess(el) {
    cache.delete(el);
    for (const d of el.querySelectorAll('*')) cache.delete(d);
    enqueueTree(el);
  }

  /* =====================================================================
     Camada 4 — imagens
     Lê os pixels de uma cópia reduzida da imagem (o CDN permite CORS).
     ===================================================================== */

  const pixelCache = new Map();          // "tamanho|src" -> Promise<Uint8ClampedArray|null>

  function loadPixels(src, size) {
    const key = `${size}|${src}`;
    let p = pixelCache.get(key);
    if (p) return p;
    p = new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = size;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(im, 0, 0, size, size);
          resolve(x.getImageData(0, 0, size, size).data);
        } catch (_) { resolve(null); }   // canvas contaminado (sem CORS): ignora
      };
      im.onerror = () => resolve(null);
      im.src = src;
    });
    pixelCache.set(key, p);
    return p;
  }

  /* --- ícones pretos (PNG preto sobre transparente) -> data-adb-inv (o CSS inverte) ---
     Fotos, selos coloridos e imagens claras não são afetados. */
  function isDarkGlyph(d) {
    if (!d) return false;
    let opaque = 0, l = 0, sat = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 128) {
        opaque++;
        l += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        sat += (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])) / 255;
      }
    }
    const frac = opaque / (d.length / 4);
    return frac >= 0.05 && frac < 0.9 && l / opaque < 0.35 && sat / opaque < 0.15;
  }

  // Ícone pequeno colocado como background-image (ex.: lixeira/coração do carrinho)
  function checkBgIcon(el, cs) {
    if (el.childElementCount !== 0) return;
    const m = URL_RE.exec(cs.backgroundImage);
    if (!m || m[1].startsWith('data:')) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.width > 48 || r.height > 48) return;
    loadPixels(m[1], 16).then((d) => {
      if (enabled && isDarkGlyph(d)) el.setAttribute('data-adb-inv', '');
    });
  }

  function checkIcon(img) {
    if (!enabled) return;
    if (!img.complete) { img.addEventListener('load', () => checkIcon(img), { once: true }); return; }
    const src = img.currentSrc || img.src;
    if (!src || (src.startsWith('data:') && src.length > 4000)) return;
    if (!img.naturalWidth || img.naturalWidth > 96 || img.naturalHeight > 96) return;
    if (img.getBoundingClientRect().width > 56) return;
    loadPixels(src, 16).then((d) => {
      if (isDarkGlyph(d)) img.setAttribute('data-adb-inv', '');
    });
  }

  /* --- faixas com imagem de fundo branca -> data-adb-mix (o CSS mescla com o escuro) ---
     Só faixas largas (largura >= 2,5x a altura): fotos de produto, quase sempre
     quadradas e com fundo branco, ficam de fora. */
  const bannerVerdict = new Map();       // src -> true | false
  const bannerWaiting = new Map();       // src -> elementos esperando o veredito

  function isWhiteImage(d) {
    if (!d) return false;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      const mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx - mn < 20 && (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255 > 0.88) white++;
    }
    return white / (d.length / 4) >= 0.6;
  }

  // Síncrono: responde pelo veredito já conhecido; se ainda não há, mede a imagem e
  // reprocessa o elemento quando a resposta chegar
  function isWhiteBanner(el, cs) {
    const m = URL_RE.exec(cs.backgroundImage);
    if (!m || m[1].startsWith('data:')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.width < r.height * 2.5) return false;
    const src = m[1];
    if (bannerVerdict.has(src)) return bannerVerdict.get(src);

    let waiting = bannerWaiting.get(src);
    if (!waiting) {
      waiting = new Set();
      bannerWaiting.set(src, waiting);
      loadPixels(src, 24).then((d) => {
        const white = isWhiteImage(d);
        bannerVerdict.set(src, white);
        bannerWaiting.delete(src);
        if (white && enabled) for (const w of waiting) if (w.isConnected) reprocess(w);
      });
    }
    waiting.add(el);
    return false;
  }

  /* =====================================================================
     Fila em fatias (não trava a página)
     ===================================================================== */

  function enqueueTree(node) {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'IMG') { checkIcon(node); return; }
    if (SKIP.has(node.tagName)) return;
    queue.push(node);
    for (const el of node.querySelectorAll('*')) {
      if (el.tagName === 'IMG') checkIcon(el);
      else if (!SKIP.has(el.tagName)) queue.push(el);
    }
    schedule();
  }

  function schedule() {
    if (scheduled || !enabled) return;
    scheduled = true;
    requestAnimationFrame(work);
  }

  function clearQueue() {
    queue.length = 0;
    qHead = 0;
  }

  function work() {
    scheduled = false;
    if (!enabled) { clearQueue(); return; }
    const t0 = performance.now();
    const batch = [];
    // 1) leitura de tudo da fatia; 2) escrita depois (evita recálculo de estilo a cada leitura)
    while (qHead < queue.length && performance.now() - t0 < 10) {
      const el = queue[qHead++];
      if (!el.isConnected) continue;
      if (fresh.has(el)) {     // classe mudou: lê o estilo ORIGINAL, sem as nossas marcações
        fresh.delete(el);
        stripMarks(el);
        cache.delete(el);
      }
      batch.push([el, cache.get(el) || analyze(el, el.parentElement ? effLum(el.parentElement) : CANVAS_L)]);
    }
    for (const [el, info] of batch) apply(el, info);
    // Descarta o trecho já processado (sem shift(), que move o array inteiro a cada item)
    if (qHead >= queue.length) clearQueue();
    else if (qHead > 2000) { queue.splice(0, qHead); qHead = 0; }
    if (qHead < queue.length) schedule();
  }

  /* =====================================================================
     Camada 3 — folhas de estilo do site
     As de outro domínio são baixadas (o CDN permite CORS) e lidas numa folha própria.
     ===================================================================== */

  const STATE_RE = /:(hover|focus|focus-within|focus-visible|active)\b/;
  // Componentes que entram na página depois (o elemento ainda não existe para a camada 2)
  const LATE_RE = /modal|dialog|drawer|popover|popup|poplayer|dropdown|tooltip|toast|notice|picker|select|menu|overlay|sheet|layer|mask/i;
  const KEYWORD_RE = /^(transparent|inherit|initial|unset|revert|revert-layer|currentcolor|none)$/i;

  const sheetsDone = new WeakSet();
  const hrefsDone = new Set();
  let sheetStyle = null;
  let probe = null;

  // Valor de cor como está na regra ("rgb(...)", "white", "var(--x)") -> cor
  function colorOf(value) {
    if (!value || KEYWORD_RE.test(value)) return null;
    const direct = parse(value);
    if (direct) return direct;
    if (!probe) {
      probe = document.createElement('span');
      probe.id = 'adb-probe';
      probe.style.cssText = 'display:none!important';
      root.appendChild(probe);
    }
    probe.style.backgroundColor = '';
    probe.style.backgroundColor = value;
    if (!probe.style.backgroundColor) return null;
    return parse(getComputedStyle(probe).backgroundColor);
  }

  // Divide "a, b:hover, c" respeitando parênteses (ex.: :is(a, b))
  function splitSelectors(sel) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of sel) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function darkRule(rule) {
    const st = rule.style;
    const sels = splitSelectors(rule.selectorText).filter((s) => !/^(html|:root)\b/i.test(s));
    if (!sels.length) return null;
    const bg = colorOf(st.backgroundColor);
    const lightBg = isLightNeutral(bg, 0.72, 0.5);
    const lightGrad = !!st.backgroundImage && isLightGradient(st.backgroundImage);

    // a) Estados: precisam vencer as marcações por elemento (!important + seletor completo)
    const states = sels.filter((s) => STATE_RE.test(s));
    if (states.length && lightBg) {
      const body = `{background-color:${mapHoverBg(bg)}!important}`;
      return states.map((s) => `html[${FLAG}] ${s}${body}`).join('\n');
    }

    // b) Componentes que aparecem depois: a versão escura vem no mesmo "peso" da regra
    //    original (:where não soma especificidade), então regras mais específicas do site
    //    (ex.: botão vermelho dentro da janela) continuam vencendo
    const late = sels.filter((s) => !STATE_RE.test(s) && LATE_RE.test(s));
    if (!late.length) return null;
    const decls = [];
    const imp = (prop) => (st.getPropertyPriority(prop) === 'important' ? '!important' : '');
    if (lightBg) decls.push(`background-color:${mapBg(bg)}${imp('background-color')}`);
    if (lightGrad) decls.push(`background-image:none${imp('background-image')}`);
    const bd = colorOf(st.borderTopColor || st.borderBottomColor);
    if (isLightNeutral(bd, 0.7, 0.05)) decls.push(`border-color:${mapBd(bd)}${imp('border-top-color')}`);
    if (!decls.length) return null;
    const body = `{${decls.join(';')}}`;
    return late.map((s) => `:where(html[${FLAG}]) ${s}${body}`).join('\n');
  }

  function darkenRules(rules, out) {
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        const css = darkRule(r);
        if (css) out.push(css);
      } else if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) {
        // (@container também tem conditionText, mas não pode virar "@supports <condição>")
        const inner = [];
        darkenRules(r.cssRules, inner);
        if (inner.length) {
          const kind = r instanceof CSSMediaRule ? '@media' : '@supports';
          out.push(`${kind} ${r.conditionText}{${inner.join('\n')}}`);
        }
      } else if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) {
        darkenRules(r.cssRules, out);   // fora da camada, a versão escura vence a original
      }
    }
  }

  function addSheetRules(rules) {
    const out = [];
    try { darkenRules(rules, out); } catch (_) { return; }
    if (!out.length) return;
    if (!sheetStyle) sheetStyle = addStyle('adb-dark-sheets');
    sheetStyle.appendChild(document.createTextNode(`${out.join('\n')}\n`));
  }

  function processSheets() {
    if (!enabled) return;
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && sheet.ownerNode.id && sheet.ownerNode.id.startsWith('adb-')) continue;
      if (sheetsDone.has(sheet)) continue;
      let rules = null;
      try { rules = sheet.cssRules; } catch (_) { rules = null; }
      if (rules) { sheetsDone.add(sheet); addSheetRules(rules); continue; }
      const href = sheet.href;
      if (!href || hrefsDone.has(href)) continue;
      hrefsDone.add(href);
      fetch(href, { mode: 'cors' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((text) => {
          if (!text) return;
          const copy = new CSSStyleSheet();
          copy.replaceSync(text);
          addSheetRules(copy.cssRules);
        })
        .catch(() => {});
    }
  }

  /* =====================================================================
     Camada 5 — varredura de segurança da área visível
     ===================================================================== */

  const SWEEP_EVERY_MS = 3000;
  const SWEEP_COLS = 8;
  const SWEEP_ROWS = 6;
  const SWEEP_MAX_TRIES = 3;             // o que continua claro depois disso não tem conserto aqui
  const sweepTries = new WeakMap();      // elemento -> tentativas
  let sweepTimer = 0;
  let scrollTimer = 0;

  function stillLight(el) {
    const cs = getComputedStyle(el);
    return cs.backgroundImage === 'none' && isLightNeutral(parse(cs.backgroundColor), 0.72, 0.5);
  }

  function sweep() {
    if (!enabled || document.hidden || !document.body) return;
    const found = new Set();
    for (let i = 0; i < SWEEP_COLS; i++) {
      for (let j = 0; j < SWEEP_ROWS; j++) {
        const x = (i + 0.5) * (innerWidth / SWEEP_COLS);
        const y = (j + 0.5) * (innerHeight / SWEEP_ROWS);
        // o ponto e até 6 contêineres acima dele
        let el = document.elementFromPoint(x, y);
        for (let k = 0; el && el !== root && k < 7; k++, el = el.parentElement) {
          if (found.has(el) || SKIP.has(el.tagName)) continue;
          if (stillLight(el)) found.add(el);
        }
      }
    }
    for (const el of found) {
      const tries = (sweepTries.get(el) || 0) + 1;
      if (tries > SWEEP_MAX_TRIES) continue;
      sweepTries.set(el, tries);
      stripMarks(el);   // relê o estilo atual do zero
      reprocess(el);
    }
  }

  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(sweep, 250);   // ao parar de rolar
  }

  /* =====================================================================
     CSS novo (modais carregam CSS sob demanda): relê folhas e página
     Pausa para juntar várias folhas de uma vez; no máximo 1x a cada 1,5 s.
     ===================================================================== */

  let rescanTimer = null;
  let lastRescan = 0;

  function rescanSoon() {
    if (!enabled || rescanTimer) return;
    const wait = Math.max(350, 1500 - (performance.now() - lastRescan));
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      lastRescan = performance.now();
      if (!enabled || !document.body) return;
      processSheets();
      cache = new WeakMap();
      enqueueTree(document.body);
    }, wait);
  }

  function onStyleNode(n) {
    if (n.nodeType !== 1 || (n.id && n.id.startsWith('adb-'))) return;
    if (n.tagName === 'STYLE') rescanSoon();
    else if (n.tagName === 'LINK' && /stylesheet/i.test(n.rel)) {
      n.addEventListener('load', rescanSoon, { once: true });
    }
  }

  /* =====================================================================
     Ciclo de vida
     ===================================================================== */

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) { onStyleNode(n); enqueueTree(n); }
      } else if (m.target.nodeType === 1) {
        if (m.target.tagName === 'IMG') {        // imagem com lazy-load trocou o src
          m.target.removeAttribute('data-adb-inv');
          checkIcon(m.target);
        } else if (!SKIP.has(m.target.tagName)) {
          fresh.add(m.target);                   // classe mudou (aba selecionada etc.)
          queue.push(m.target);
          schedule();
        }
      }
    }
  }

  function start() {
    if (observer) return;
    cache = new WeakMap();
    const begin = () => {
      // "observer" já criado: liga/desliga/liga antes do DOMContentLoaded registra begin 2x
      if (!enabled || observer) return;
      processSheets();
      window.addEventListener('load', processSheets, { once: true });
      enqueueTree(document.body);
      observer = new MutationObserver(onMutations);
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] });
      sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
      addEventListener('scroll', onScroll, { passive: true });
    };
    if (document.body) begin();
    else document.addEventListener('DOMContentLoaded', begin, { once: true });
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(rescanTimer);
    rescanTimer = null;
    clearInterval(sweepTimer);
    clearTimeout(scrollTimer);
    removeEventListener('scroll', onScroll);
    clearQueue();
  }

  function setFlag(on) {
    enabled = !!on;
    root.toggleAttribute(FLAG, enabled);
    try { localStorage.setItem('adb-dark', enabled ? '1' : '0'); } catch (_) {}
    if (enabled) start(); else stop();
  }

  /* ---------- início (liga/desliga pelo popup) ---------- */

  // Cache síncrono: pinta o fundo escuro antes do storage responder (evita flash branco)
  try { if (localStorage.getItem('adb-dark') === '1') root.setAttribute(FLAG, ''); } catch (_) {}
  chrome.storage.local.get('dark').then(({ dark }) => setFlag(dark));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.dark) setFlag(changes.dark.newValue);
  });
})();
