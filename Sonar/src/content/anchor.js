/* Content script do iframe "Não sou um robô" (anchor).
 * - Aquece o Whisper assim que a caixa aparece (ganha tempo antes do desafio).
 * - Marca a caixa sozinho (opcional) ou quando o atalho é usado. */
(() => {
  if (window.__sonarAnchor) return;
  window.__sonarAnchor = true;

  const box = () => document.querySelector('#recaptcha-anchor');
  let lastClick = 0;

  function clickCheckbox() {
    const el = box();
    if (!el || !el.getClientRects().length || el.getAttribute('aria-checked') === 'true') return;
    if (Date.now() - lastClick < 30000) return; // não clica de novo enquanto o desafio está aberto
    lastClick = Date.now();
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: r.left + r.width * (0.3 + Math.random() * 0.4),
      clientY: r.top + r.height * (0.3 + Math.random() * 0.4),
    };
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }

  sonarGetSettings().then((settings) => {
    const el = box();
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      sonarWarmup(settings);
      if (settings.autoClickCheckbox) setTimeout(clickCheckbox, 250 + Math.random() * 350);
    });
    io.observe(el);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'clickCheckbox') clickCheckbox();
    return false;
  });
})();
