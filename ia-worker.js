// IA local del Cuaderno (se ejecuta en un Web Worker para no congelar la ventana).
// Modelo: Gemma 3 1B (Google) en ONNX, con transformers.js. Se descarga una vez desde Hugging Face y
// queda guardado en la caché de la app ("transformers-cache"). Con tarjeta gráfica compatible usa
// WebGPU (rápido); si no, el procesador (más lento).
import { pipeline, env, TextStreamer, InterruptableStoppingCriteria } from './transformers.min.js';

const MODEL = 'onnx-community/gemma-3-1b-it-ONNX';
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = { mjs: new URL('./ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href, wasm: new URL('./ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href };

let gen = null, loading = null, device = null;
const stopper = new InterruptableStoppingCriteria();
const post = (type, data = {}) => self.postMessage({ type, ...data });

async function pickDevice() {
  try {
    if (!self.navigator?.gpu) return { device: 'wasm', dtype: 'q4' };
    const ad = await navigator.gpu.requestAdapter();
    if (ad && ad.features.has('shader-f16')) return { device: 'webgpu', dtype: 'q4f16' };
  } catch (e) {}
  return { device: 'wasm', dtype: 'q4' };
}

// ¿Está ya descargada? (mira si los archivos del modelo están en la caché)
async function isDownloaded() {
  try {
    const d = await pickDevice();
    const c = await caches.open('transformers-cache');
    const keys = (await c.keys()).map(r => r.url);
    const file = d.dtype === 'q4f16' ? 'model_q4f16.onnx' : 'model_q4.onnx';
    return keys.some(u => u.includes('gemma-3-1b-it-ONNX') && u.endsWith('/onnx/' + file));
  } catch (e) { return false; }
}

async function load() {
  if (gen) return gen;
  if (loading) return loading;
  loading = (async () => {
    const d = await pickDevice(); device = d.device;
    const files = {};
    gen = await pipeline('text-generation', MODEL, {
      device: d.device, dtype: d.dtype,
      progress_callback: p => {
        if (p.status === 'progress' && p.total) {
          files[p.file] = { loaded: p.loaded, total: p.total };
          const all = Object.values(files), loaded = all.reduce((a, f) => a + f.loaded, 0), total = all.reduce((a, f) => a + f.total, 0);
          post('progress', { loaded, total, file: p.file });
        } else if (p.status === 'ready') post('progress', { ready: true });
      },
    });
    // Calentamiento: la primera ejecución compila los «shaders» de la tarjeta gráfica
    await gen([{ role: 'user', content: 'Hola' }], { max_new_tokens: 1 });
    return gen;
  })();
  try { await loading; post('ready', { device }); return gen; }
  catch (e) { gen = null; throw e; }
  finally { loading = null; }
}

async function generate(id, prompt, maxTokens) {
  const g = await load();
  stopper.reset();
  let out = '';
  const streamer = new TextStreamer(g.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: t => { out += t; post('token', { id, text: t }); },
  });
  await g([{ role: 'user', content: prompt }], {
    max_new_tokens: maxTokens || 700, do_sample: false, repetition_penalty: 1.12,
    streamer, stopping_criteria: stopper,
  });
  return out;
}

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === 'status') post('status', { downloaded: await isDownloaded(), loaded: !!gen, device });
    else if (m.type === 'load') await load();
    else if (m.type === 'stop') stopper.interrupt();
    else if (m.type === 'generate') { const text = await generate(m.id, m.prompt, m.maxTokens); post('done', { id: m.id, text }); }
    else if (m.type === 'delete') {
      gen = null;
      const c = await caches.open('transformers-cache');
      for (const r of await c.keys()) if (r.url.includes('gemma-3-1b-it-ONNX')) await c.delete(r);
      post('deleted');
    }
  } catch (err) {
    post('error', { id: m.id, message: String(err && err.message || err) });
  }
};
