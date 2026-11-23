/* Documento offscreen: decodifica o áudio e transcreve com o Whisper local
 * (transformers.js + ONNX Runtime/WASM). Só tem acesso a chrome.runtime —
 * as configurações chegam junto com cada mensagem. */
import { pipeline, env } from '../../engine/runtime/transformers.min.js';

const IDLE_CLOSE_MS = 10 * 60 * 1000; // libera a memória após 10 min sem uso
const MAX_TOKENS = 40; // respostas do reCAPTCHA são curtas; corta alucinações longas

// Quantos núcleos usar: perguntado ao service worker (que lê as configurações).
const config = await chrome.runtime.sendMessage({ type: 'offscreenConfig' }).catch(() => null);
const THREADS = self.crossOriginIsolated ? Math.max(1, config?.threads | 0) : 1;

// Modelos vêm do Hugging Face uma única vez e ficam no Cache Storage da extensão.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('engine/runtime/');
env.backends.onnx.wasm.numThreads = THREADS;
env.backends.onnx.wasm.initTimeout = 20000; // se travar, cai no plano B de 1 núcleo

/* ---------------- Modelo ---------------- */

let asr = null; // { key, model, pipe, warm }
let loading = null; // { key, promise }
let loadChain = Promise.resolve();

// O ONNX Runtime não roda duas inferências ao mesmo tempo: fila simples.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const broadcast = (data) =>
  chrome.runtime.sendMessage({ target: 'ui', type: 'modelProgress', ...data }).catch(() => {});

function progressTracker(model) {
  // Os arquivos aparecem um de cada vez; usar o tamanho esperado evita a porcentagem "voltar".
  const expected = (SONAR_MODELS.find((m) => m.id === model)?.size || 0) * 1048576;
  const files = new Map();
  let last = -1;
  return (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, [p.loaded, p.total]);
    let loaded = 0;
    let total = 0;
    for (const [l, t] of files.values()) {
      loaded += l;
      total += t;
    }
    total = Math.max(total, expected);
    const percent = Math.max(last, Math.min(100, Math.floor((loaded / total) * 100)));
    if (percent !== last) broadcast({ status: 'progress', model, loaded, total, percent: (last = percent) });
  };
}

function createPipe(model, device) {
  return pipeline('automatic-speech-recognition', model, {
    device,
    // Na GPU o encoder quantizado perde precisão: fp32 no encoder, q4 no decoder.
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: progressTracker(model),
  });
}

async function loadModel(model, device) {
  const key = `${model}|${device}`;
  if (asr?.key === key) return asr;
  if (loading?.key === key) return loading.promise;

  // Um carregamento por vez (evita dois downloads grandes disputando a rede e a memória).
  const promise = (loadChain = loadChain
    .catch(() => {})
    .then(async () => {
      let pipe;
      try {
        pipe = await createPipe(model, device);
      } catch (e) {
        if (device !== 'webgpu') throw e;
        console.warn('[Sonar] WebGPU indisponível, usando CPU:', e);
        pipe = await createPipe(model, 'wasm');
      }
      const old = asr?.pipe;
      asr = { key, model, pipe, warm: false };
      // Libera o modelo anterior só depois de qualquer inferência em andamento terminar.
      if (old) exclusive(() => old.dispose?.()).catch(() => {});
      broadcast({ status: 'ready', model });
      return asr;
    }));

  loading = { key, promise };
  try {
    return await promise;
  } catch (e) {
    // Erro de rede/download não tem a ver com núcleos; o resto pode ter.
    const err = /fetch|locate file|network|status|404|offline/i.test(String(e?.message))
      ? new Error('Não deu para baixar o modelo de voz. Confira a internet e tente de novo.')
      : Object.assign(e, { sonarRuntime: true });
    broadcast({ status: 'error', model, error: err.message });
    throw err;
  } finally {
    if (loading?.promise === promise) loading = null;
  }
}

// A 1ª inferência é mais lenta (alocação e otimização do grafo). Faz uma
// "de mentira" com silêncio enquanto o usuário ainda está olhando o desafio.
async function warmUp(model, device) {
  const m = await loadModel(model, device);
  if (m.warm) return;
  await exclusive(() => m.pipe(new Float32Array(16000), { max_new_tokens: 4 }));
  m.warm = true;
}

/* ---------------- Áudio ---------------- */

async function decodeTo16kMono(bytes) {
  // decodeAudioData reamostra para a taxa do contexto (16 kHz).
  const buf = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.buffer);
  const n = buf.numberOfChannels;
  const out = n === 1 ? buf.getChannelData(0) : new Float32Array(buf.length);
  if (n > 1) {
    for (let c = 0; c < n; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / n;
    }
  }
  // Normaliza áudios baixos.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0 && peak < 0.5) {
    const g = 0.9 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function cleanup(text) {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ') // [BLANK_AUDIO], (music), *ruído*
    .toLowerCase()
    .replace(/\b\d\b/g, (d) => DIGITS[d])
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function transcribe(bytes, model, device) {
  const t0 = performance.now();
  // Modelo e decodificação em paralelo.
  const [m, audio] = await Promise.all([loadModel(model, device), decodeTo16kMono(bytes)]);
  const out = await exclusive(() => m.pipe(audio, { max_new_tokens: MAX_TOKENS }));
  m.warm = true;
  return { text: cleanup(out?.text || ''), ms: Math.round(performance.now() - t0) };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------------- Ociosidade ---------------- */

let idleTimer = 0;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => chrome.runtime.sendMessage({ type: 'offscreenIdle' }).catch(() => {}), IDLE_CLOSE_MS);
}
touch();

/* ---------------- Mensagens ---------------- */

// Falha ao iniciar com vários núcleos → avisa o service worker, que recria com 1.
function handleError(e, sendResponse) {
  const error = String(e?.message || e);
  if (THREADS > 1 && !asr && e?.sonarRuntime) {
    sendResponse({ ok: false, code: 'RETRY', error });
    chrome.runtime.sendMessage({ type: 'threadsFailed' }).catch(() => {});
  } else {
    sendResponse({ ok: false, error });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  touch();

  switch (msg.type) {
    case 'ping':
      sendResponse({ ok: true, ready: !!asr, warm: !!asr?.warm, model: asr?.model || null, threads: THREADS });
      return false;

    case 'transcribe':
      transcribe(
        b64ToBytes(msg.audio),
        msg.localModel || SONAR_DEFAULTS.localModel,
        msg.localDevice || SONAR_DEFAULTS.localDevice
      )
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => handleError(e, sendResponse));
      return true;

    case 'preload':
      warmUp(msg.model || SONAR_DEFAULTS.localModel, msg.device || SONAR_DEFAULTS.localDevice)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => handleError(e, sendResponse));
      return true;

    default:
      return false;
  }
});
