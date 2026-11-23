/* Componentes personalizados do Sonar (sem elementos nativos visíveis). */
/* eslint-disable no-var */
var UI = (() => {
  const ICONS = {
    chevron: '<path d="M4 6l4 4 4-4"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/>',
    moon: '<path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"/>',
    auto: '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>',
    wave: '<path d="M2 7v2M5 4.5v7M8 2v12M11 5v6M14 7v2"/>',
    cpu: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/>',
    sliders:
      '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.5" fill="currentColor"/><circle cx="10" cy="8" r="1.5" fill="currentColor"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/>',
    download: '<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/>',
    trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>',
    refresh: '<path d="M13 3v3.5H9.5"/><path d="M12.6 6.5A5 5 0 1 0 13 9"/>',
  };

  /** Milissegundos → "3,4 s" */
  const secs = (ms, digits = 1) =>
    `${(ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} s`;

  function icon(name, cls = '') {
    return `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  function el(tag, attrs = {}, html = '') {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    if (html) n.innerHTML = html;
    return n;
  }

  /* ---------- Interruptor ---------- */

  function switchControl(btn, { value = false, onChange } = {}) {
    btn.classList.add('switch');
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    const set = (v) => btn.setAttribute('aria-checked', String(!!v));
    set(value);
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('aria-checked') !== 'true';
      set(v);
      onChange?.(v);
    });
    return { set, get: () => btn.getAttribute('aria-checked') === 'true' };
  }

  /* ---------- Select ---------- */

  let openSelect = null;
  document.addEventListener('pointerdown', (e) => {
    if (openSelect && !openSelect.root.contains(e.target)) openSelect.close();
  });

  function select(root, { options, value, onChange, label }) {
    root.classList.add('select');
    const id = `sel-${Math.random().toString(36).slice(2, 8)}`;
    root.innerHTML = '';
    const trigger = el('button', {
      class: 'select-trigger',
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': id,
      'aria-label': label,
    });
    trigger.innerHTML = `<span class="select-value"></span>${icon('chevron', 'select-chevron')}`;
    const menu = el('ul', { class: 'select-menu', role: 'listbox', id, tabindex: '-1' });
    root.append(trigger, menu);

    let current = value;
    let active = 0;

    const render = () => {
      menu.innerHTML = '';
      options.forEach((o, i) => {
        const li = el('li', {
          class: 'select-option',
          role: 'option',
          'aria-selected': String(o.value === current),
          'data-i': i,
        });
        li.innerHTML = `<span>${o.label}</span>${icon('check', 'check')}${o.hint ? `<small>${o.hint}</small>` : ''}`;
        li.addEventListener('click', () => choose(i));
        li.addEventListener('pointermove', () => highlight(i));
        menu.append(li);
      });
      const sel = options.find((o) => o.value === current);
      trigger.querySelector('.select-value').textContent = sel ? sel.label : '';
    };

    const highlight = (i) => {
      active = (i + options.length) % options.length;
      menu.querySelectorAll('.select-option').forEach((li, j) => li.classList.toggle('active', j === active));
      menu.children[active]?.scrollIntoView({ block: 'nearest' });
    };

    const open = () => {
      if (openSelect && openSelect !== api) openSelect.close();
      const r = trigger.getBoundingClientRect();
      root.classList.toggle('up', window.innerHeight - r.bottom < 280 && r.top > 280);
      root.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      highlight(
        Math.max(
          0,
          options.findIndex((o) => o.value === current)
        )
      );
      openSelect = api;
    };

    const close = () => {
      root.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      if (openSelect === api) openSelect = null;
    };

    const choose = (i) => {
      const o = options[i];
      close();
      trigger.focus();
      if (o.value === current) return;
      current = o.value;
      render();
      onChange?.(current);
    };

    trigger.addEventListener('click', () => (root.classList.contains('open') ? close() : open()));
    trigger.addEventListener('keydown', (e) => {
      const isOpen = root.classList.contains('open');
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        if (!isOpen) open();
        else highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' && isOpen) {
        e.preventDefault();
        highlight(0);
      } else if (e.key === 'End' && isOpen) {
        e.preventDefault();
        highlight(options.length - 1);
      } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) {
        e.preventDefault();
        choose(active);
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        close();
      }
    });

    const api = {
      root,
      close,
      set(v) {
        current = v;
        render();
      },
      get: () => current,
    };
    render();
    return api;
  }

  /* ---------- Stepper ---------- */

  function stepper(root, { min = 1, max = 10, value = 1, onChange, label }) {
    root.classList.add('stepper');
    root.setAttribute('role', 'group');
    if (label) root.setAttribute('aria-label', label);
    root.innerHTML = `<button type="button" aria-label="Diminuir">${icon('minus')}</button><output aria-live="polite"></output><button type="button" aria-label="Aumentar">${icon('plus')}</button>`;
    const [dec, out, inc] = root.children;
    let v = value;
    const render = () => {
      out.textContent = v;
      dec.disabled = v <= min;
      inc.disabled = v >= max;
    };
    const step = (d) => {
      const n = Math.min(max, Math.max(min, v + d));
      if (n === v) return;
      v = n;
      render();
      onChange?.(v);
    };
    dec.addEventListener('click', () => step(-1));
    inc.addEventListener('click', () => step(1));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') step(-1);
    });
    render();
    return {
      set(n) {
        v = n;
        render();
      },
    };
  }

  /* ---------- Segmentado ---------- */

  function segmented(root, { options, value, onChange, label }) {
    root.classList.add('segmented');
    root.setAttribute('role', 'radiogroup');
    if (label) root.setAttribute('aria-label', label);
    root.innerHTML = '';
    const buttons = options.map((o) => {
      const b = el('button', { type: 'button', role: 'radio', 'data-value': o.value, 'aria-label': o.aria || null });
      b.innerHTML = `${o.icon ? icon(o.icon) : ''}${o.label ? `<span>${o.label}</span>` : ''}`;
      b.addEventListener('click', () => {
        set(o.value);
        onChange?.(o.value);
      });
      root.append(b);
      return b;
    });
    const set = (v) => buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === v)));
    root.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const n = buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
      n.click();
      n.focus();
    });
    set(value);
    return { set };
  }

  /* ---------- Notificações ---------- */

  let toastHost = null;
  function toast(message, kind = 'info', ttl = 3200) {
    if (!toastHost) {
      toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(toastHost);
    }
    const t = el('div', { class: 'toast', 'data-kind': kind });
    t.textContent = message;
    toastHost.append(t);
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 220);
    }, ttl);
  }

  /* ---------- Tema ---------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme || 'auto';
  }

  /* ---------- Equalizador (decorativo) ---------- */

  function equalizer(root, bars = 48) {
    root.classList.add('eq');
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '';
    for (let i = 0; i < bars; i++) {
      // Envelope suave + variação: parece uma onda sonora, não ruído
      const env = 0.35 + 0.65 * Math.sin((Math.PI * (i + 0.5)) / bars);
      const h = Math.round(18 + 70 * env * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7))));
      const bar = el('span', { style: `--h:${h}%;--d:${(-(i * 137) % 1600) / 1000}s` });
      root.append(bar);
    }
  }

  return { icon, secs, el, switchControl, select, stepper, segmented, toast, applyTheme, equalizer };
})();
