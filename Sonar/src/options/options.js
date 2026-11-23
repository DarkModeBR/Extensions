/* Página de configurações do Sonar. Tudo é salvo na hora. */
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { icon, secs } = UI;

  const settings = await sonarGetSettings();
  let { stats = {} } = await chrome.storage.local.get('stats');
  const controls = {}; // chave → componentes (há cópias do mesmo controle em seções diferentes)

  UI.applyTheme(settings.theme);
  $('#version').textContent = `versão ${chrome.runtime.getManifest().version}`;
  for (const n of $$('[data-icon]')) n.insertAdjacentHTML('afterbegin', icon(n.dataset.icon));

  async function save(patch) {
    Object.assign(settings, patch);
    await chrome.storage.local.set(patch);
  }
  const register = (key, api) => (controls[key] ||= []).push(api);
  const sync = (key, value, except) => {
    for (const c of controls[key] || []) if (c !== except) c.set(value);
  };
  const modelName = (id) => SONAR_MODELS.find((m) => m.id === id)?.name || id.split('/').pop();

  /* ---------------- Navegação ---------------- */

  const views = $$('.view');
  function route() {
    const view = $(`#view-${location.hash.slice(1)}`) || $('#view-overview');
    for (const v of views) v.hidden = v !== view;
    for (const a of $$('.nav a')) {
      if (`view-${a.dataset.view}` === view.id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    $('#view-title').textContent = view.dataset.title;
    document.title = `Sonar — ${view.dataset.title}`;
    $('#main').scrollTop = 0;
    if (view.id === 'view-voice') refreshModels();
    if (view.id === 'view-overview') drawEq();
    renderStatus();
  }
  window.addEventListener('hashchange', route);

  /* ---------------- Controles ---------------- */

  for (const btn of $$('[data-switch]')) {
    const key = btn.dataset.switch;
    const api = UI.switchControl(btn, {
      value: settings[key],
      onChange: (v) => {
        save({ [key]: v }).then(renderStatus);
        sync(key, v, api);
      },
    });
    register(key, api);
  }

  register(
    'theme',
    UI.segmented($('#theme'), {
      label: 'Tema',
      value: settings.theme,
      options: [
        { value: 'auto', icon: 'auto', label: 'Auto' },
        { value: 'light', icon: 'sun', label: 'Claro' },
        { value: 'dark', icon: 'moon', label: 'Escuro' },
      ],
      onChange: (v) => {
        save({ theme: v });
        UI.applyTheme(v);
      },
    })
  );

  register(
    'localDevice',
    UI.select($('#device-select'), {
      label: 'Processar com',
      value: settings.localDevice,
      options: [
        { value: 'wasm', label: 'CPU', hint: 'Funciona em qualquer computador' },
        { value: 'webgpu', label: 'GPU (WebGPU)', hint: 'Experimental. Volta para a CPU se falhar' },
      ],
      onChange: (v) => save({ localDevice: v }).then(renderStatus),
    })
  );

  register(
    'maxAttempts',
    UI.stepper($('#attempts'), {
      label: 'Tentativas por desafio',
      min: 1,
      max: 10,
      value: settings.maxAttempts,
      onChange: (v) => save({ maxAttempts: v }),
    })
  );

  /* ---------------- Atalho ---------------- */

  const shortcut = (await chrome.commands.getAll()).find((c) => c.name === 'solve')?.shortcut || '';
  for (const n of $$('[data-shortcut]')) {
    n.innerHTML = shortcut
      ? shortcut
          .split('+')
          .map((k) => `<kbd>${k}</kbd>`)
          .join('<span>+</span>')
      : '<span class="faint">Sem atalho definido</span>';
  }
  $('#change-shortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  /* ---------------- Estado do motor ---------------- */

  async function renderStatus() {
    const st = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
    const loaded = st?.ready && st.model === settings.localModel;
    const name = `Whisper ${modelName(settings.localModel)}`;
    const where = settings.localDevice === 'webgpu' ? 'GPU' : st?.threads > 1 ? `CPU com ${st.threads} núcleos` : 'CPU';

    const pill = $('#engine-pill');
    $('#summary-name').textContent = name;
    if (!settings.setupDone) {
      pill.dataset.state = 'error';
      pill.textContent = 'Nenhum modelo baixado';
      $('#summary-detail').textContent = 'Baixe um modelo em Reconhecimento de voz para começar.';
    } else {
      pill.dataset.state = loaded ? 'ready' : 'idle';
      pill.textContent = loaded ? `${name} pronto` : `${name} em espera`;
      $('#summary-detail').textContent = loaded
        ? `Carregado na memória (${where})`
        : 'Carrega sozinho quando um reCAPTCHA aparece na página';
    }
    $('#threads-detail').textContent =
      st?.threads > 1
        ? `Usando ${st.threads} núcleos agora.`
        : settings.multiThread
          ? 'Transcreve mais rápido. Desliga sozinho se o navegador não suportar.'
          : 'Desligado: usa um núcleo.';

    const eq = $('#overview-eq');
    eq.classList.toggle('idle', !loaded && !settings.autoSolve);
    $('#hero-title').textContent = settings.autoSolve ? 'Resolvendo sozinho' : 'Pronto para resolver';
    $('#hero-text').textContent = settings.autoSolve
      ? 'Quando um desafio aparecer, o Sonar cobre a tela e resolve sem você clicar.'
      : 'Clique no ícone de ondas dentro do desafio ou use o atalho.';
  }

  const restartBtn = $('#restart-engine');
  restartBtn.innerHTML = `${icon('refresh')}Liberar agora`;
  restartBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'restartEngine' });
    UI.toast('Memória liberada. O motor abre de novo quando precisar.', 'ok');
    renderStatus();
  });

  /* ---------------- Modelos ---------------- */

  const downloading = new Map(); // modelo → % atual

  async function removeModel(m) {
    const cache = await caches.open(SONAR_CACHE);
    for (const req of await cache.keys()) if (req.url.includes(`/${m.id}/`)) await cache.delete(req);
    await chrome.runtime.sendMessage({ type: 'restartEngine' });
    if (settings.localModel === m.id) {
      // Passa para outro modelo já baixado; sem nenhum, volta para a tela de boas-vindas no menu.
      const left = await sonarModelCache();
      const other = SONAR_MODELS.find((x) => left[x.id]?.complete);
      await save(other ? { localModel: other.id } : { setupDone: false });
    }
    UI.toast(`Modelo ${m.name} removido do navegador`);
  }

  async function downloadModel(m) {
    downloading.set(m.id, 0);
    refreshModels();
    try {
      await sonarLoadModel(m.id, settings.localDevice);
      if (settings.localModel === m.id) await save({ setupDone: true });
      UI.toast(`Modelo ${m.name} baixado`, 'ok');
    } catch (e) {
      UI.toast(`Não deu para baixar: ${e.message}`, 'error', 6000);
    } finally {
      downloading.delete(m.id);
      refreshModels();
      renderStatus();
    }
  }

  const meter = (label, n) =>
    `<div class="meter"><span>${label}</span>${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;

  async function refreshModels() {
    const info = await sonarModelCache();
    const root = $('#models');
    root.setAttribute('role', 'radiogroup');
    root.setAttribute('aria-label', 'Modelo Whisper');
    root.innerHTML = '';

    for (const m of SONAR_MODELS) {
      const available = !!info[m.id]?.complete;
      const pct = downloading.get(m.id);
      const inUse = m.id === settings.localModel;
      const state = pct != null ? 'loading' : available ? 'cached' : 'none';
      const status =
        pct != null
          ? `Baixando ${pct}%`
          : available
            ? `Baixado (${Math.round(info[m.id].bytes / 1048576)} MB)`
            : 'Não baixado';
      let action = '';
      if (pct == null) {
        action = available
          ? `<button class="btn btn-sm btn-danger" data-act="remove" type="button">${icon('trash')}Remover</button>`
          : `<button class="btn btn-sm btn-ghost" data-act="download" type="button">${icon('download')}Baixar</button>`;
      }

      const card = UI.el('div', { class: 'model', role: 'radio', tabindex: '0', 'aria-checked': String(inUse) });
      card.innerHTML = `
        <div class="model-head">
          <h3>${m.name}</h3>
          ${inUse ? '<span class="tag-in-use">Em uso</span>' : `<span>~${m.size} MB</span>`}
        </div>
        <p>${m.note}</p>
        <div class="meters">${meter('Velocidade', m.speed)}${meter('Precisão', m.accuracy)}</div>
        ${pct != null ? `<div class="progress"><span style="width:${pct}%"></span></div>` : ''}
        <div class="model-foot"><span class="model-state" data-state="${state}">${status}</span>${action}</div>`;

      const choose = async () => {
        if (inUse && available) return;
        await save({ localModel: m.id });
        if (!available) return downloadModel(m); // baixa já, com progresso no cartão
        refreshModels();
        renderStatus();
        UI.toast(`Usando o modelo ${m.name}`);
      };
      card.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'download') return downloadModel(m);
        if (act === 'remove') {
          await removeModel(m);
          refreshModels();
          renderStatus();
          return;
        }
        choose();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose();
        }
      });
      root.append(card);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target !== 'ui' || msg.type !== 'modelProgress' || msg.status !== 'progress') return false;
    if (!downloading.has(msg.model)) return false;
    downloading.set(msg.model, msg.percent);
    const card = $$('#models .model')[SONAR_MODELS.findIndex((m) => m.id === msg.model)];
    const bar = card?.querySelector('.progress span');
    if (bar) bar.style.width = `${msg.percent}%`;
    const st = card?.querySelector('.model-state');
    if (st) st.textContent = `Baixando ${msg.percent}%`;
    return false;
  });

  /* ---------------- Estatísticas ---------------- */

  function renderStats() {
    const solved = stats.solved || 0;
    const failed = stats.failed || 0;
    const total = solved + failed;
    $('#fig-solved').textContent = solved.toLocaleString('pt-BR');
    $('#fig-failed').textContent = failed.toLocaleString('pt-BR');
    $('#fig-rate').textContent = total ? `${Math.round((solved / total) * 100)}%` : '—';
    $('#fig-avg').textContent = solved ? secs(stats.totalMs / solved) : '—';
  }

  const resetBtn = $('#reset-stats');
  const resetLabel = `${icon('trash')}Zerar`;
  resetBtn.innerHTML = resetLabel;
  let armed = 0;
  resetBtn.addEventListener('click', async () => {
    if (!armed) {
      resetBtn.innerHTML = `${icon('trash')}Clique de novo para zerar`;
      armed = setTimeout(() => {
        armed = 0;
        resetBtn.innerHTML = resetLabel;
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    resetBtn.innerHTML = resetLabel;
    await chrome.storage.local.set({ stats: { solved: 0, failed: 0, totalMs: 0 } });
    UI.toast('Contadores zerados', 'ok');
  });

  /* ---------------- Sincronização ---------------- */

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.stats) {
      stats = changes.stats.newValue || {};
      renderStats();
    }
    // Mudanças feitas pelo menu do ícone ou pelo service worker
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (!(k in SONAR_DEFAULTS) || settings[k] === newValue) continue;
      settings[k] = newValue;
      sync(k, newValue);
      if (k === 'theme') UI.applyTheme(newValue);
      renderStatus();
    }
  });

  let resizeT = 0;
  const drawEq = () => {
    const eq = $('#overview-eq');
    UI.equalizer(eq, Math.max(24, Math.min(110, Math.floor((eq.clientWidth || 900) / 11))));
  };
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(drawEq, 150);
  });

  drawEq();
  renderStats();
  route();
})();
