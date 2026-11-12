/**
 * @file ai.js
 * @brief Local LLM bridge (main process).
 *
 * Talks to an Ollama or OpenAI-compatible server that runs on THIS Mac (loopback only by default).
 * Nothing from the drawing leaves the machine unless the user explicitly allows a non-loopback
 * server in the AI settings.
 *
 * The renderer never talks to the network itself; it calls the IPC handlers registered in main.js,
 * which call the functions exported here.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const fs = require('fs');
const { execFile, spawn } = require('child_process');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Host names that count as "this Mac". */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The API key comes from the environment variable OPENAI_API_KEY (nothing is stored in the
 * settings). A program started from the Dock or Finder does not see what ~/.zshrc exports, so on
 * macOS the login shell is asked once for the variable. The key is only sent to the server address
 * chosen in the AI settings.
 */
const KEY_VAR = 'OPENAI_API_KEY';
const KEY_LOOKUP_TIMEOUT_MS = 4000;
/** An empty key lookup is not repeated for this long (ms). */
const KEY_RETRY_MS = 30000;

const OLLAMA_PORT = 11434;
const OLLAMA_APP = '/Applications/Ollama.app';
/** Places the `ollama` program is looked for, in order. */
const OLLAMA_BIN = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  `${OLLAMA_APP}/Contents/Resources/ollama`,
];

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Static functions for talking to a local language-model server. */
class LocalLlmBridge {
  // ---------------------------------------------------------------- API key

  /**
   * Reads the API key from the environment (and, on macOS, once from the login shell).
   * @param {boolean} [force=false] ignore the cached answer
   * @returns {Promise<string>} the key, or '' when none is set
   */
  static async envApiKey(force = false) {
    const cache = LocalLlmBridge.keyCache;
    if (!force && cache && (cache.key || Date.now() - cache.at < KEY_RETRY_MS)) return cache.key;
    let key = (process.env[KEY_VAR] || '').trim();
    if (!key && process.platform === 'darwin' && !process.env.MACCAD_NO_LOGIN_SHELL) {
      key = await new Promise((resolve) => {
        try {
          execFile(
            process.env.SHELL || '/bin/zsh',
            ['-ilc', `printf '<<K>>%s<<K>>' "$${KEY_VAR}"`],
            { timeout: KEY_LOOKUP_TIMEOUT_MS, env: { ...process.env, TERM: 'dumb' } },
            (err, out) => {
              const m = /<<K>>([\s\S]*?)<<K>>/.exec(String(out || ''));
              resolve(m ? m[1].trim() : '');
            },
          );
        } catch {
          resolve('');
        }
      });
    }
    LocalLlmBridge.keyCache = { key, at: Date.now() };
    return key;
  }

  /** @returns {Promise<{ok: true, name: string, set: boolean}>} whether a key is set; never the key itself. */
  static async keyInfo() {
    return { ok: true, name: KEY_VAR, set: !!(await LocalLlmBridge.envApiKey(true)) };
  }

  // ---------------------------------------------------------------- addresses

  /**
   * Validates the server address.
   * @param {string} endpoint the address typed in the AI settings
   * @param {boolean} allowRemote true when the user allowed a non-local server
   * @returns {URL}
   * @throws {Error} with a user-facing message when the address is unusable or not local
   */
  static parseEndpoint(endpoint, allowRemote) {
    let u;
    try {
      u = new URL(String(endpoint || '').trim());
    } catch {
      throw new Error(
        'The AI server address is not a valid URL (example: http://127.0.0.1:11434).',
      );
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new Error('The AI server address must start with http:// or https://.');
    if (!LOOPBACK.has(u.hostname) && !allowRemote)
      throw new Error(
        `"${u.hostname}" is not a local address. Drawings are only sent to servers on this Mac (localhost / 127.0.0.1). Enable "Allow a non-local server" in the AI settings if you really want that.`,
      );
    return u;
  }

  /** @private @returns {string} the URL of `path` below the server address. */
  static join(u, path) {
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${path}`;
  }

  /**
   * Which dialect the server speaks. Ollama listens on 11434; everything else is treated as OpenAI
   * compatible (LM Studio, llama.cpp server, vLLM, ...).
   * @param {URL} u server address
   * @param {string} api 'ollama', 'openai' or 'auto'
   * @returns {'ollama'|'openai'}
   */
  static styleOf(u, api) {
    return api === 'ollama' || api === 'openai'
      ? api
      : u.port === String(OLLAMA_PORT)
        ? 'ollama'
        : 'openai';
  }

  // ---------------------------------------------------------------- HTTP

  /**
   * One JSON request with a time limit and readable errors. Redirects are refused.
   * @private
   * @param {string} url
   * @param {object} opts fetch options
   * @param {number} timeoutMs
   * @returns {Promise<object>} the parsed JSON answer
   */
  static async call(url, opts, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal, redirect: 'error' });
      const text = await r.text();
      if (!r.ok)
        throw new Error(
          `The AI server answered ${r.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`The AI server returned something that is not JSON: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      if (e.name === 'AbortError')
        throw new Error(
          `The AI server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        );
      if (
        e.message === 'fetch failed' ||
        (e.cause && /ECONNREFUSED/.test(String(e.cause.code || e.cause)))
      )
        throw new Error(
          `Cannot connect to the AI server${e.cause && (e.cause.code || e.cause.message) ? ` (${e.cause.code || e.cause.message})` : ''}. Is Ollama (or your OpenAI-compatible server) running?`,
        );
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- chat

  /**
   * Sends a conversation to the model.
   * @param {object} o
   * @param {string} o.endpoint server address
   * @param {string} [o.api='auto'] 'ollama' | 'openai' | 'auto'
   * @param {string} o.model model name
   * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} o.messages the conversation
   * @param {boolean} [o.json=false] ask for a JSON answer
   * @param {object|null} [o.schema=null] a JSON schema the answer must follow (structured output)
   * @param {boolean} [o.think] false switches the "thinking" of models like Qwen3 off (much faster for planning)
   * @param {number} [o.numCtx] context window (Ollama only)
   * @param {number} [o.temperature=0.2]
   * @param {number} [o.timeoutMs=180000]
   * @param {boolean} [o.allowRemote=false] allow a non-local server
   * @param {string} [o.apiKey=''] key; empty = the environment key
   * @returns {Promise<{ok: true, text: string, ms: number, style: string}>}
   */
  static async chat({
    endpoint,
    api = 'auto',
    model,
    messages,
    json = false,
    schema = null,
    think,
    numCtx,
    temperature = 0.2,
    timeoutMs = 180000,
    allowRemote = false,
    apiKey = '',
  }) {
    const t0 = Date.now();
    const u = LocalLlmBridge.parseEndpoint(endpoint, allowRemote);
    const style = LocalLlmBridge.styleOf(u, api);
    if (!model) throw new Error('Choose a model in the AI settings first.');
    apiKey = apiKey || (await LocalLlmBridge.envApiKey());
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    if (style === 'ollama')
      return LocalLlmBridge.chatOllama(
        u,
        headers,
        { model, messages, json, schema, think, numCtx, temperature, timeoutMs },
        t0,
      );
    return LocalLlmBridge.chatOpenAi(
      u,
      headers,
      { model, messages, json, schema, temperature, timeoutMs },
      t0,
    );
  }

  /** @private Chat with an Ollama server (/api/chat). */
  static async chatOllama(u, headers, o, t0) {
    const body = (withThink) =>
      JSON.stringify({
        model: o.model,
        messages: o.messages,
        stream: false,
        keep_alive: '15m',
        ...(o.schema ? { format: o.schema } : o.json ? { format: 'json' } : {}),
        ...(withThink && o.think === false ? { think: false } : {}),
        options: { temperature: o.temperature, ...(o.numCtx ? { num_ctx: o.numCtx } : {}) },
      });
    const url = LocalLlmBridge.join(u, '/api/chat');
    let r;
    try {
      r = await LocalLlmBridge.call(
        url,
        { method: 'POST', headers, body: body(true) },
        o.timeoutMs,
      );
    } catch (e) {
      // an older server / a model without thinking support: ask again without the `think` option
      if (o.think === false && /think/i.test(e.message))
        r = await LocalLlmBridge.call(
          url,
          { method: 'POST', headers, body: body(false) },
          o.timeoutMs,
        );
      else throw e;
    }
    const text = r && r.message && r.message.content;
    if (typeof text !== 'string') throw new Error('Unexpected answer from the Ollama server.');
    return { ok: true, text, ms: Date.now() - t0, style: 'ollama' };
  }

  /** @private Chat with an OpenAI-compatible server (/v1/chat/completions). */
  static async chatOpenAi(u, headers, o, t0) {
    const base = u.pathname.replace(/\/+$/, '').endsWith('/v1')
      ? '/chat/completions'
      : '/v1/chat/completions';
    const rf = o.schema
      ? {
          response_format: { type: 'json_schema', json_schema: { name: 'plan', schema: o.schema } },
        }
      : o.json
        ? { response_format: { type: 'json_object' } }
        : {};
    const r = await LocalLlmBridge.call(
      LocalLlmBridge.join(u, base),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: o.model,
          messages: o.messages,
          temperature: o.temperature,
          stream: false,
          ...rf,
        }),
      },
      o.timeoutMs,
    );
    const text =
      r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
    if (typeof text !== 'string')
      throw new Error('Unexpected answer from the OpenAI-compatible server.');
    return { ok: true, text, ms: Date.now() - t0, style: 'openai' };
  }

  // ---------------------------------------------------------------- model list

  /**
   * Lists the models the server offers.
   * @param {{endpoint: string, api?: string, allowRemote?: boolean, apiKey?: string}} o
   * @returns {Promise<{ok: true, style: string, models: string[]}>}
   */
  static async models({ endpoint, api = 'auto', allowRemote = false, apiKey = '' }) {
    apiKey = apiKey || (await LocalLlmBridge.envApiKey());
    const u = LocalLlmBridge.parseEndpoint(endpoint, allowRemote);
    const style = LocalLlmBridge.styleOf(u, api);
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    if (style === 'ollama') {
      const r = await LocalLlmBridge.call(LocalLlmBridge.join(u, '/api/tags'), { headers }, 8000);
      return { ok: true, style, models: (r.models || []).map((m) => m.name) };
    }
    const path = u.pathname.replace(/\/+$/, '').endsWith('/v1') ? '/models' : '/v1/models';
    const r = await LocalLlmBridge.call(LocalLlmBridge.join(u, path), { headers }, 8000);
    return { ok: true, style, models: (r.data || []).map((m) => m.id) };
  }

  // ---------------------------------------------------------------- starting Ollama

  /** @private @returns {boolean} true when the file exists and can be run. */
  static executable(p) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** @private @returns {Promise<boolean>} true when the server at `u` already answers. */
  static async answers(u) {
    try {
      const r = await fetch(new URL('/api/tags', u), { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * Starts the Ollama server that is installed on THIS Mac: the same as typing `ollama serve` in
   * the Terminal (or opening the Ollama app). Only a fixed, local program is started, and only for
   * a loopback address; the server keeps running after MacCAD quits, like one started by hand.
   * Used by the "Start Ollama" button of the AI window.
   * @param {{endpoint?: string}} [o]
   * @returns {Promise<{ok: boolean, already?: boolean, error?: string}>}
   */
  static async startServer({ endpoint } = {}) {
    let u;
    try {
      u = LocalLlmBridge.parseEndpoint(endpoint || `http://127.0.0.1:${OLLAMA_PORT}`, false); // loopback only
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (await LocalLlmBridge.answers(u)) return { ok: true, already: true };
    const host = `${u.hostname.replace(/^\[|\]$/g, '')}:${u.port || OLLAMA_PORT}`;
    const bin = OLLAMA_BIN.find(LocalLlmBridge.executable);
    try {
      if (fs.existsSync(OLLAMA_APP) && host === `127.0.0.1:${OLLAMA_PORT}`)
        spawn('/usr/bin/open', ['-a', 'Ollama'], { detached: true, stdio: 'ignore' }).unref(); // the menu bar app keeps it running
      else if (bin)
        spawn(bin, ['serve'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, OLLAMA_HOST: host },
        }).unref();
      else
        return {
          ok: false,
          error: 'Ollama is not installed on this Mac. Install it from ollama.com first.',
        };
    } catch (e) {
      return { ok: false, error: `Ollama could not be started: ${e.message}` };
    }
    for (let i = 0; i < 24; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await LocalLlmBridge.answers(u)) return { ok: true };
    }
    return {
      ok: false,
      error:
        'Ollama was started but did not answer within 12 seconds. Try the button again, or run "ollama serve" in the Terminal.',
    };
  }
}

/** @private Cached key lookup: `{key, at}` or null. */
LocalLlmBridge.keyCache = null;

/* ============================================================================================
 * 4. EXPORTS
 * ========================================================================================== */
module.exports = {
  LocalLlmBridge,
  chat: LocalLlmBridge.chat,
  models: LocalLlmBridge.models,
  parseEndpoint: LocalLlmBridge.parseEndpoint,
  styleOf: LocalLlmBridge.styleOf,
  keyInfo: LocalLlmBridge.keyInfo,
  envApiKey: LocalLlmBridge.envApiKey,
  startServer: LocalLlmBridge.startServer,
};
