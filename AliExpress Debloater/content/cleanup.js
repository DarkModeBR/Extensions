/* AliExpress Debloater — limpeza que depende do texto ou do estado da página.
 *
 * O que dá para fazer só com seletor está em cleanup.css. Aqui ficam:
 *   - cards de anúncio (identificados pelo rótulo "Anúncio")
 *   - preços com uma casa decimal ("R$14,9" -> "R$14,90")
 *   - itens dos menus "Minha conta" e "Configurações"
 *   - etiquetas de promoção (reserva para quando as classes do site mudarem)
 *   - popups promocionais em tela cheia
 *   - recursos ligáveis pelo popup (atributo data-adb-off no <html>)
 */
(() => {
  'use strict';

  const root = document.documentElement;

  /* ---------- configuração ---------- */

  const AD_LABEL = 'Anúncio';
  const CARD_SELECTOR = '.card-out-wrapper, a[href*="/item/"]';
  const LEAF_SELECTOR = 'span, div, s, del';
  // Etiquetas escondidas só pelo CSS (para a contagem do popup)
  const TAG_SELECTOR = '.FNjFR, [class*="us--serviceTagWrapper--"], .nuPN3, [data-adb-tag]';

  const PROMO_RE = /cashback|\boff\b|poupe|cupom|cupão|desconto de/i;

  // Menu suspenso "Minha conta": links a esconder (texto exato)
  const ACCOUNT_MENU_HIDE_RE = new RegExp(`^(${[
    'info sobre penalidades',
    'denunciar infração de propriedade intelectual',
    'acessibilidade',
    'disputas e recursos',
    'central de ajuda',
    'política de devolução e reembolso',
    'ds center',
    'aliexpress business',
  ].join('|')})$`, 'i');

  // Menu lateral de "Configurações": itens a esconder (início do texto)
  const SETTINGS_HIDE_RE = /^(central de ajuda|gerencie reportagens|sugest[aã]o|centro de dropshipping|info sobre penalidades|retiradas y alertas)/i;

  // Preço inteiro num só nó de texto, com uma casa decimal: "R$14,9"
  const PRICE_ONE_DECIMAL_RE = /^R\$\s?\d[\d.]*,\d$/;
  // Texto que vale reexaminar quando só o conteúdo de um nó muda
  const PRICE_TEXT_RE = /^\s*(R\$\s?[\d.]+,\d|\d)\s*$/;

  // Popups: só nos primeiros segundos, para não afetar janelas abertas de propósito
  const POPUP_WINDOW_MS = 15000;
  const startedAt = performance.now();

  /* ---------- recursos ligáveis (popup) ----------
     chrome.storage.local.off = lista dos recursos DESLIGADOS (vazia = tudo ligado).
     O CSS de cada recurso só vale sem a palavra correspondente em <html data-adb-off>.
     Cópia em localStorage aplica o estado já no início (sem piscar). */

  let off = new Set();
  const isOn = (feature) => !off.has(feature);

  function setOff(list, { cache = true } = {}) {
    const prev = off;
    off = new Set(Array.isArray(list) ? list : []);
    if (off.size) root.setAttribute('data-adb-off', [...off].join(' '));
    else root.removeAttribute('data-adb-off');
    if (cache) {
      try { localStorage.setItem('adb-off', [...off].join(' ')); } catch (_) {}
    }
    // Preços mexem no texto: ao ligar, corrige; ao desligar, devolve o original
    if (started && prev.has('prices') && !off.has('prices')) fixPricesIn(document);
    if (!prev.has('prices') && off.has('prices')) revertPrices();
  }
  // (a leitura inicial fica no fim do arquivo, depois de todas as declarações)

  /* ---------- utilitários ---------- */

  const hide = (el) => el && el.setAttribute('data-adb-hidden', '');
  const normText = (el) => el.textContent.replace(/\s+/g, ' ').trim();

  // querySelectorAll que também testa o próprio root
  function* select(scope, selector) {
    if (scope.nodeType === 1 && scope.matches(selector)) yield scope;
    yield* scope.querySelectorAll(selector);
  }

  /* ---------- anúncios ---------- */

  // Esconde a célula inteira do card (sobe pelos contêineres de filho único), senão
  // sobra um buraco na grade.
  //
  // Na home NÃO pode ser display:none nem tamanho zero: o último card de cada lote de 30
  // é sempre um anúncio, e o site só carrega o próximo lote quando esse card aparece na
  // tela. Por isso, em lista flex, o anúncio (data-adb-ad="flex") mantém o tamanho real,
  // fica invisível e ganha margem negativa igual à própria largura (--adb-w): ocupa zero
  // espaço na linha, mas para o site continua sendo um card "visível".
  // A largura dos cards é uma porcentagem que muda no carregamento e com a janela; o
  // ResizeObserver mantém --adb-w sempre igual (largura errada = cards sobrepostos).
  // Em grade CSS a margem não libera a coluna, então lá ele sai do layout ("grid").
  const adResizer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.borderBoxSize && entry.borderBoxSize[0];
      const width = box ? box.inlineSize : entry.target.getBoundingClientRect().width;
      entry.target.style.setProperty('--adb-w', `${width}px`);
    }
  });

  function hideAd(card) {
    let el = card;
    for (let i = 0; i < 4; i++) {
      const p = el.parentElement;
      if (!p || p === document.body || p.childElementCount !== 1) break;
      el = p;
    }
    if (el.hasAttribute('data-adb-ad')) return;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).display.includes('grid')) {
      el.setAttribute('data-adb-ad', 'grid');
      return;
    }
    // Largura já na marcação (o observer só responde depois) para não piscar sobreposto
    el.style.setProperty('--adb-w', `${el.getBoundingClientRect().width}px`);
    el.setAttribute('data-adb-ad', 'flex');
    adResizer.observe(el);
  }

  /* ---------- preços ---------- */

  // O site mostra "R$14,9" (uma casa decimal). Formatos no DOM:
  //   a) nó de texto "R$14,9" inteiro: sozinho (leitor de tela, preço riscado) ou entre
  //      outros nós, como no preço por unidade "(" "R$51,7" "/" "pça." ")"
  //   b) preço quebrado em spans: "R$" "14" "," "9"  -> acrescenta "0" ao último
  // Edita o PRÓPRIO nó de texto (nodeValue). Trocar por el.textContent = ... cria um nó
  // novo, e o React (que guarda o nó antigo) passa a atualizar algo que saiu da página.
  const fixedPrices = new Map();   // nó de texto -> { original, fixed, box }

  function setPrice(tn, value, box) {
    fixedPrices.set(tn, { original: tn.nodeValue, fixed: value, box });
    tn.nodeValue = value;
  }

  function fixPrice(el) {
    // a) "R$14,9" -> "R$14,90" (mantém os espaços em volta)
    for (let tn = el.firstChild; tn; tn = tn.nextSibling) {
      if (tn.nodeType === 3 && PRICE_ONE_DECIMAL_RE.test(tn.nodeValue.trim())) {
        setPrice(tn, tn.nodeValue.replace(/\d(?=\s*$)/, (d) => `${d}0`), el.parentElement);
      }
    }

    // b) último span de "R$" "14" "," "9"
    const tn = el.firstChild;
    if (!tn || tn.nodeType !== 3 || tn.nextSibling) return;
    if (!/^\d$/.test(tn.nodeValue) || el.nextElementSibling) return;
    const prev = el.previousElementSibling;
    const first = el.parentElement && el.parentElement.firstElementChild;
    if (prev && prev.textContent === ',' && /^R\$/.test(first.textContent.trim())) {
      setPrice(tn, `${tn.nodeValue}0`, el.parentElement);
    }
  }

  function fixPricesIn(scope) {
    for (const el of select(scope, LEAF_SELECTOR)) {
      if (el.childElementCount === 0) fixPrice(el);
    }
  }

  // Desfaz só o que ainda está como deixamos (se o site trocou o texto, é dele)
  function revertPrices() {
    for (const [tn, { original, fixed }] of fixedPrices) {
      if (tn.isConnected && tn.nodeValue === fixed) tn.nodeValue = original;
    }
    fixedPrices.clear();
  }

  /* ---------- varredura de um trecho da página ---------- */

  function scan(scope) {
    const prices = isOn('prices');

    // Folhas de texto: rótulo "Anúncio" ou preço (uma passada só).
    // Anúncios e etiquetas são sempre marcados; o CSS decide se escondem (popup).
    for (const el of select(scope, LEAF_SELECTOR)) {
      if (el.childElementCount !== 0) continue;
      if (el.textContent.trim() === AD_LABEL) {
        const card = el.closest(CARD_SELECTOR);
        if (card) hideAd(card);
      } else if (prices) {
        fixPrice(el);
      }
    }

    for (const a of select(scope, 'li > a')) {
      if (ACCOUNT_MENU_HIDE_RE.test(normText(a))) hide(a.parentElement);
    }

    for (const item of select(scope, '.page-menu-item')) {
      if (SETTINGS_HIDE_RE.test(normText(item))) hide(item);
    }

    // Etiquetas de promoção têm cor inline e o texto no title
    for (const el of select(scope, 'span[title]')) {
      if (el.style.color && PROMO_RE.test(el.title) && el.parentElement) {
        el.parentElement.setAttribute('data-adb-tag', '');
      }
    }
  }

  /* ---------- popups promocionais em tela cheia ---------- */

  // O popup é uma camada fixa SEM classe, com z-index alto, cobrindo a janela.
  // Modais do próprio site (opções do carrinho, login...) têm classe (comet-v2-modal-*)
  // e nunca podem ser escondidos: o site trava a rolagem enquanto estão abertos.
  function isPromoOverlay(el) {
    if (el.getAttribute('class')) return false;
    if (el.querySelector('[class*="comet-v2-modal"], [role="dialog"]')) return false;
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' || s.display === 'none') return false;
    if (!(parseInt(s.zIndex, 10) >= 1000)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) return false;
    return !el.querySelector('input, textarea, select, form');
  }

  // Olha o nó e os filhos até 3 níveis (a camada costuma vir dentro de um contêiner
  // sem classe adicionado ao body)
  function scanPopups(node, depth = 0) {
    if (performance.now() - startedAt > POPUP_WINDOW_MS) return;
    if (node.nodeType !== 1 || node === root) return;
    if (isPromoOverlay(node)) { hide(node); return; }
    if (depth >= 3) return;
    for (const child of node.children) scanPopups(child, depth + 1);
  }

  /* ---------- observação (em lotes, 1x por frame) ---------- */

  const addedRoots = new Set();   // nós novos: varredura completa
  const priceRoots = new Set();   // texto de preço mudou: só preços
  let frame = 0;
  let started = false;

  function flush() {
    frame = 0;
    for (const n of addedRoots) {
      if (n.isConnected) { scan(n); scanPopups(n); }
    }
    if (isOn('prices')) {
      for (const n of priceRoots) if (n.isConnected) fixPricesIn(n);
    }
    addedRoots.clear();
    priceRoots.clear();
  }

  function enqueue(set, node) {
    set.add(node);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        // O React reaproveita o nó ao trocar o preço (ex.: outra variação do produto), o
        // que não gera childList. O avô cobre o formato em spans. A nossa própria edição
        // ("9" -> "90") não casa com PRICE_TEXT_RE, então não volta para cá.
        const p = m.target.parentElement;
        if (p && PRICE_TEXT_RE.test(m.target.nodeValue)) enqueue(priceRoots, p.parentElement || p);
      } else {
        for (const n of m.addedNodes) if (n.nodeType === 1) enqueue(addedRoots, n);
      }
    }
  }

  function start() {
    started = true;
    scan(document);
    for (const child of document.body.children) scanPopups(child);
    new MutationObserver(onMutations).observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  /* ---------- início ---------- */

  try {
    const cached = localStorage.getItem('adb-off');
    if (cached) setOff(cached.split(' '), { cache: false });
  } catch (_) {}
  chrome.storage.local.get('off').then(({ off: list }) => setOff(list));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.off) setOff(changes.off.newValue);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  /* ---------- contagem para o popup ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.type !== 'adb-stats') return;
    const boxes = new Set();
    for (const { box } of fixedPrices.values()) if (box && box.isConnected) boxes.add(box);
    reply({
      ads: document.querySelectorAll('[data-adb-ad]').length,
      tags: document.querySelectorAll(TAG_SELECTOR).length,
      prices: boxes.size,
    });
  });
})();
