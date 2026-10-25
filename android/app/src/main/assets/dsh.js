/* ============================================================
 * DSH Web API · 页面驱动脚本（注入 chat.deepseek.com）
 *
 * 移植自 dsh-deepseek-web-login 的协议层（webapi.ts / browser-transport.ts）：
 *   create_pow_challenge → 官方 SHA3 WASM 求解 → chat_session/create
 *   → chat/completion(SSE patch 流) → chat_session/delete
 *
 * 关键点：所有请求都由**页面自己**的 fetch 发出（TLS/HTTP2 指纹、cookie、
 * 反爬头都与真实浏览器一致）；PoW 也**在页面里**用官方 wasm 求解
 * （在 Node/Java 里解挑战是被公开列为封号触发条件的做法）。
 * ============================================================ */
(function () {
  if (window.__DSH_LOADED) {
    try { DSHBridge.log('[DSH] 已注入，跳过'); } catch (e) {}
    return;
  }
  window.__DSH_LOADED = true;

  var BASE = 'https://chat.deepseek.com';
  var WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
  var CLIENT_VERSION = '2.5.0';
  var wasmBytes = null;
  var wasmPromise = null;
  var inflight = {}; // reqId -> AbortController

  function log(m) {
    try { DSHBridge.log('[DSH] ' + m); } catch (e) {}
  }
  function emit(id, obj) {
    try { DSHBridge.emit(id, JSON.stringify(obj)); } catch (e) {}
  }
  function b64(str) {
    try {
      return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
      return btoa(str);
    }
  }
  function b64decodeToBytes(b64s) {
    var bin = atob(b64s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── 登录态 / 指纹 ─────────────────────────────────────────

  // ── 登录态采集（document-start 就装）──────────────────────
  // 页面自己发的每个请求都带 Authorization: Bearer <token>，这是最可靠的来源：
  // 不依赖 localStorage 的键名/结构（上游也吃过 "userToken 是 JSON 串" 的亏）。
  var seenToken = '';
  function rememberAuth(v) {
    try {
      if (!v) return;
      var s = String(v);
      if (/^Bearer\s+/i.test(s)) s = s.replace(/^Bearer\s+/i, '');
      if (s.length > 16 && s.indexOf(' ') < 0) {
        seenToken = s;
        try { localStorage.setItem('dsh_seen_token', s); } catch (e) {}
      }
    } catch (e) {}
  }
  try {
    var _fetch = window.fetch;
    if (_fetch && !_fetch.__dshHooked) {
      var wrapped = function (input, init) {
        try {
          var h = (init && init.headers) || (input && input.headers);
          if (h) {
            if (typeof Headers !== 'undefined' && h instanceof Headers) {
              rememberAuth(h.get('authorization'));
            } else if (Array.isArray(h)) {
              for (var i = 0; i < h.length; i++) if (String(h[i][0]).toLowerCase() === 'authorization') rememberAuth(h[i][1]);
            } else if (typeof h === 'object') {
              for (var k in h) if (String(k).toLowerCase() === 'authorization') rememberAuth(h[k]);
            }
          }
        } catch (e) {}
        return _fetch.apply(this, arguments);
      };
      wrapped.__dshHooked = true;
      window.fetch = wrapped;
    }
  } catch (e) {}
  try {
    var _open = XMLHttpRequest.prototype.open;
    var _set = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function () {
      this.__dshUrl = arguments[1];
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (String(k).toLowerCase() === 'authorization') rememberAuth(v); } catch (e) {}
      return _set.apply(this, arguments);
    };
  } catch (e) {}

  function readUserToken() {
    try {
      var raw = localStorage.getItem('userToken') || '';
      if (raw) {
        if (raw.trim().charAt(0) === '{') {
          var o = JSON.parse(raw);
          var v = o.value || o.token || o.access_token || '';
          if (v) return v;
        } else {
          return raw.trim();
        }
      }
    } catch (e) {}
    for (var i = 0; i < 6; i++) {
      try {
        var k = ['token', 'access_token', 'Authorization', 'auth_token', 'dsh_seen_token', 'ds_token'][i];
        var v2 = localStorage.getItem(k);
        if (v2 && v2.length > 16) {
          if (v2.trim().charAt(0) === '{') {
            try { v2 = JSON.parse(v2).value || JSON.parse(v2).token || ''; } catch (e2) {}
          }
          if (v2 && v2.length > 16) return v2.trim();
        }
      } catch (e3) {}
    }
    if (seenToken) return seenToken;
    try {
      var hs = performance.getEntriesByType('resource');
      for (var j = 0; j < hs.length; j++) {}
    } catch (e4) {}
    return '';
  }

  // 图片上传：/api/v0/file/upload_file（multipart + PoW），返回 file_id
  async function uploadImage(token, device, dataUrl, name) {
    var comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('图片不是 data URL');
    var meta = dataUrl.slice(5, comma);
    var mime = (meta.split(';')[0] || 'image/png').trim();
    var bin = atob(dataUrl.slice(comma + 1));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var blob = new Blob([arr], { type: mime });
    var fd = new FormData();
    fd.append('file', blob, name || ('image.' + (mime.split('/')[1] || 'png')));
    var pow = await powHeader(token, '/api/v0/file/upload_file', device);
    var h = headers(token, device);
    delete h['content-type'];
    h['x-ds-pow-response'] = pow;
    var r = await fetch(BASE + '/api/v0/file/upload_file', { method: 'POST', headers: h, body: fd });
    var txt = await r.text();
    var json = null;
    try { json = JSON.parse(txt); } catch (e) {}
    if (!r.ok) throw new Error('upload HTTP ' + r.status + ': ' + txt.slice(0, 160));
    var biz = json && json.data && json.data.biz_data;
    var id = biz && (biz.id || biz.file_id || (biz.file && biz.file.id));
    if (!id) throw new Error('upload 缺少 id: ' + txt.slice(0, 160));
    return id;
  }
  function readHifLeim() {
    try {
      var v = localStorage.getItem('hif_leim_cached') || '';
      return v.replace(/^"|"$/g, '');
    } catch (e) {
      return '';
    }
  }
  function deviceId() {
    try {
      // 页面自己就有设备 ID（localStorage 的 deepseek-device-id:chat），优先用它
      var own = localStorage.getItem('deepseek-device-id:chat');
      if (own && own.length >= 8) {
        try { own = own.replace(/^"|"$/g, ''); } catch (e) {}
        if (own && own.length >= 8) return own;
      }
    } catch (e) {}
    try {
      var k = 'dsh_device_id';
      var v = localStorage.getItem(k);
      if (!v) {
        var hex = '';
        for (var i = 0; i < 8; i++) {
          hex += ('00000000' + Math.floor(Math.random() * 0xffffffff).toString(16)).slice(-8);
        }
        v = hex.slice(0, 32);
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return '';
    }
  }

  // ── PoW（官方 wasm）────────────────────────────────────────
  function loadWasm() {
    if (wasmPromise) return wasmPromise;
    wasmPromise = (async function () {
      // 优先用页面自己加载过的那份（版本号随发版变化，写死必然过时）
      var url = '';
      try {
        var res = performance.getEntriesByType('resource');
        for (var i = 0; i < res.length; i++) {
          if (/sha3_wasm.*\.wasm/.test(res[i].name)) { url = res[i].name; break; }
        }
      } catch (e) {}
      if (!url) url = WASM_URL;
      try { WASM_URL = url; } catch (e) {}
      var r = await fetch(url);
      if (!r.ok) throw new Error('wasm HTTP ' + r.status);
      wasmBytes = await r.arrayBuffer();
      return wasmBytes;
    })();
    return wasmPromise;
  }

  async function solvePow(challenge) {
    var bytes = await loadWasm();
    var inst = await WebAssembly.instantiate(bytes, { wbg: {} });
    var e = inst.instance.exports;
    if (typeof e.wasm_solve !== 'function' || typeof e.__wbindgen_export_0 !== 'function' || !e.memory) {
      throw new Error('PoW WASM exports missing');
    }
    var enc = new TextEncoder();
    var cB = enc.encode(challenge.challenge);
    var pB = enc.encode(String(challenge.salt) + '_' + String(challenge.expire_at) + '_');
    var cP = e.__wbindgen_export_0(cB.length, 1) >>> 0;
    var pP = e.__wbindgen_export_0(pB.length, 1) >>> 0;
    new Uint8Array(e.memory.buffer).set(cB, cP);
    new Uint8Array(e.memory.buffer).set(pB, pP);
    var sp = e.__wbindgen_add_to_stack_pointer(-16);
    e.wasm_solve(sp, cP, cB.length, pP, pB.length, Number(challenge.difficulty));
    var dv = new DataView(e.memory.buffer);
    var code = dv.getInt32(sp, true);
    var answer = Math.floor(dv.getFloat64(sp + 8, true));
    e.__wbindgen_add_to_stack_pointer(16);
    if (code !== 0 || !isFinite(answer) || answer <= 0) throw new Error('PoW solve code=' + code);
    return answer;
  }

  function headers(token, device, accept) {
    var h = {
      accept: accept || 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json',
      'x-client-platform': 'web',
      'x-client-version': CLIENT_VERSION,
      'x-device-id': device || deviceId(),
      origin: BASE,
      referer: BASE + '/'
    };
    // 只在页面里真的有这个缓存值时才带（空字符串头本身就是异常特征）
    var hif = readHifLeim();
    if (hif) h['x-hif-leim'] = hif;
    var t = token || readUserToken();
    if (t) h.authorization = 'Bearer ' + t;
    return h;
  }

  async function powHeader(token, targetPath, device) {
    var r = await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
      method: 'POST',
      headers: headers(token, device),
      body: JSON.stringify({ target_path: targetPath })
    });
    var text = await r.text();
    var json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('challenge 非 JSON: ' + text.slice(0, 120)); }
    if (!r.ok) throw new Error('challenge HTTP ' + r.status + ': ' + text.slice(0, 160));
    if (json && json.code && json.code !== 0) {
      throw new Error('challenge biz ' + json.code + ': ' + (json.msg || ''));
    }
    var ch = json && json.data && json.data.biz_data && json.data.biz_data.challenge;
    if (!ch || !ch.challenge || !ch.salt || !ch.signature) throw new Error('challenge 字段缺失（登录态可能过期）');
    var answer = await solvePow(ch);
    return b64(JSON.stringify({
      algorithm: ch.algorithm,
      challenge: ch.challenge,
      salt: ch.salt,
      answer: answer,
      signature: ch.signature,
      target_path: targetPath
    }));
  }

  // ── SSE patch 流解析 ──────────────────────────────────────
  function newState() {
    return { resp: null, fragments: [], content: '', thinking: '', status: '', sid: '', mid: 0 };
  }
  function fragText(list, type) {
    var s = '';
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      var t = (f.type || '').toUpperCase();
      if (t === type || (type === 'RESPONSE' && t === 'TEXT')) s += f.content || '';
    }
    return s;
  }
  function applyEvent(st, obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.response_message_id) st.mid = obj.response_message_id;
    if (obj.v && typeof obj.v === 'object' && obj.v.response) {
      st.resp = obj.v.response;
      if (st.resp.message_id) st.mid = st.resp.message_id;
      if (Array.isArray(st.resp.fragments)) st.fragments = st.resp.fragments.slice();
      if (typeof st.resp.content === 'string') st.content = st.resp.content;
      if (typeof st.resp.thinking_content === 'string') st.thinking = st.resp.thinking_content;
      if (st.resp.status) st.status = st.resp.status;
      return;
    }
    var p = obj.p || obj.path || st.lastPath || '';
    if (obj.p) st.lastPath = obj.p;
    var v = obj.v;
    var append = (obj.o || obj.op || '').toUpperCase() === 'APPEND';
    if (!p) {
      // 承接上个 path 的续段
      if (typeof v === 'string') {
        if (st.lastPath && /content$/.test(st.lastPath)) {
          var idx = st.lastPath.match(/fragments\/(-?\d+)\/content/);
          if (idx) {
            var i2 = parseInt(idx[1], 10);
            if (i2 < 0) i2 = st.fragments.length + i2;
            if (st.fragments[i2]) st.fragments[i2].content = (st.fragments[i2].content || '') + v;
          } else if (/thinking_content$/.test(st.lastPath)) {
            st.thinking += v;
          } else if (/response\/content$/.test(st.lastPath)) {
            st.content += v;
          }
        }
      }
      return;
    }
    if (p === 'response/status') {
      st.status = String(v || '');
      return;
    }
    if (p === 'response/fragments') {
      if (append && v && typeof v === 'object') st.fragments.push(v);
      else if (Array.isArray(v)) st.fragments = v.slice();
      return;
    }
    var m = p.match(/response\/fragments\/(-?\d+)\/content$/);
    if (m) {
      var i = parseInt(m[1], 10);
      if (i < 0) i = st.fragments.length + i;
      if (!st.fragments[i]) st.fragments[i] = { type: 'RESPONSE', content: '' };
      if (typeof v === 'string') {
        st.fragments[i].content = append ? (st.fragments[i].content || '') + v : v;
      }
      return;
    }
    if (p === 'response/thinking_content') {
      if (typeof v === 'string') st.thinking = append ? st.thinking + v : v;
      return;
    }
    if (p === 'response/content') {
      if (typeof v === 'string') st.content = append ? st.content + v : v;
      return;
    }
    if (p === 'response/message_id' && v) st.mid = v;
  }

  function texts(st) {
    var t = fragText(st.fragments, 'RESPONSE');
    var k = fragText(st.fragments, 'THINKING');
    if (!t && st.content) t = st.content;
    if (!k && st.thinking) k = st.thinking;
    return { text: t, think: k };
  }

  // ── 请求主体 ──────────────────────────────────────────────
  async function createSession(token, device, omit) {
    var opt = omit ? { credentials: 'omit' } : {};
    var r = await fetch(BASE + '/api/v0/chat_session/create', {
      method: 'POST',
      headers: headers(token, device),
      body: '{}',
      ...opt
    });
    var text = await r.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!r.ok) throw new Error('create_session HTTP ' + r.status + ': ' + text.slice(0, 160));
    if (json && json.code && json.code !== 0) throw new Error('create_session biz ' + json.code + ': ' + (json.msg || ''));
    var sid = json && json.data && json.data.biz_data && json.data.biz_data.chat_session && json.data.biz_data.chat_session.id;
    if (!sid) throw new Error('create_session 缺少 id: ' + text.slice(0, 160));
    return sid;
  }

  async function deleteSession(token, device, sid, omit) {
    var opt = omit ? { credentials: 'omit' } : {};
    var r = await fetch(BASE + '/api/v0/chat_session/delete', {
      method: 'POST',
      headers: headers(token, device),
      body: JSON.stringify({ chat_session_id: sid }),
      ...opt
    });
    return r.ok;
  }

  async function runCompletion(id, args, ctl) {
    var token = args.token || '';
    var device = args.deviceId || '';
    var omit = !!args.omitCookie;
    var sid = args.sessionId || '';
    if (!sid) sid = await createSession(token, device, omit);

    var pow = await powHeader(token, '/api/v0/chat/completion', device);
    var body = {
      chat_session_id: sid,
      parent_message_id: args.parentMessageId === undefined ? null : args.parentMessageId,
      prompt: args.prompt,
      ref_file_ids: args.refFileIds || [],
      thinking_enabled: !!args.thinking,
      search_enabled: !!args.search,
      model_type: args.modelType || 'default',
      action: null,
      preempt: false
    };
    var h = headers(token, device, 'text/event-stream');
    h['x-ds-pow-response'] = pow;
    var opt = omit ? { credentials: 'omit' } : {};
    var r = await fetch(BASE + '/api/v0/chat/completion', {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body),
      signal: ctl.signal,
      ...opt
    });
    if (!r.ok) {
      var bt = await r.text().catch(function () { return ''; });
      var err = { t: 'error', status: r.status, msg: 'completion HTTP ' + r.status + ': ' + bt.slice(0, 300) };
      if (r.status === 401 || r.status === 403) err.code = 'AUTH';
      else if (r.status === 429) err.code = 'RATE_LIMIT';
      else err.code = 'PROVIDER';
      emit(id, err);
      return;
    }
    if (!r.body || !r.body.getReader) {
      emit(id, { t: 'error', code: 'TRANSPORT', msg: '响应没有可读流' });
      return;
    }
    emit(id, { t: 'ready', sid: sid });

    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    var st = newState();
    st.sid = sid;
    var lastText = '';
    var lastThink = '';
    var finished = false;

    function pushDiff() {
      var x = texts(st);
      if (x.think.length > lastThink.length && x.think.indexOf(lastThink) === 0) {
        emit(id, { t: 'thinking', v: x.think.slice(lastThink.length) });
        lastThink = x.think;
      } else if (x.think !== lastThink) {
        emit(id, { t: 'thinking_reset', v: x.think });
        lastThink = x.think;
      }
      if (x.text.length > lastText.length && x.text.indexOf(lastText) === 0) {
        emit(id, { t: 'text', v: x.text.slice(lastText.length) });
        lastText = x.text;
      } else if (x.text !== lastText) {
        emit(id, { t: 'text_reset', v: x.text });
        lastText = x.text;
      }
    }

    while (true) {
      var rd = await reader.read();
      if (rd.done) break;
      buf += dec.decode(rd.value, { stream: true });
      var idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.indexOf('data:') !== 0) {
          if (line.indexOf('event:') === 0) st.eventName = line.slice(6).trim();
          continue;
        }
        var payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        var obj = null;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        if (st.eventName === 'ready' || (obj && obj.response_message_id)) {
          if (obj.response_message_id) st.mid = obj.response_message_id;
        }
        applyEvent(st, obj);
        pushDiff();
        if (st.status === 'FINISHED') { finished = true; break; }
      }
      if (finished) break;
      if (ctl.signal.aborted) break;
    }
    pushDiff();
    emit(id, {
      t: 'end',
      sid: sid,
      mid: st.mid || 0,
      status: st.status || (finished ? 'FINISHED' : ''),
      textLen: lastText.length,
      thinkLen: lastThink.length
    });
    if (args.deleteAfter) {
      try { await deleteSession(token, device, sid, omit); } catch (e) {}
    }
  }

  // ── 对外入口 ──────────────────────────────────────────────
  var API = {
    run: function (id, method, argsJson) {
      var args = {};
      try { args = JSON.parse(argsJson || '{}'); } catch (e) {}
      var ctl = { signal: { aborted: false } };
      inflight[id] = ctl;
      (async function () {
        try {
          if (method === 'ping') {
            emit(id, { t: 'pong', url: location.href, token: readUserToken().length, ready: true });
            return;
          }
          if (method === 'uploadFile') {
            var upId = await uploadImage(args.token || readUserToken(), args.deviceId || '', args.dataUrl, args.name);
            emit(id, { t: 'ok', id: upId });
            return;
          }
          if (method === 'capture') {
            var tok = readUserToken();
            emit(id, {
              t: 'ok',
              token: tok,
              hifLeim: readHifLeim(),
              deviceId: deviceId(),
              userAgent: navigator.userAgent,
              url: location.href
            });
            return;
          }
          if (method === 'pow') {
            var ph = await powHeader(args.token || '', args.targetPath || '/api/v0/chat/completion', args.deviceId || '');
            emit(id, { t: 'pow', ok: true, header: ph });
            return;
          }
          if (method === 'sessionCreate') {
            var s1 = await createSession(args.token || '', args.deviceId || '', !!args.omitCookie);
            emit(id, { t: 'session', id: s1 });
            return;
          }
          if (method === 'sessionDelete') {
            var okd = await deleteSession(args.token || '', args.deviceId || '', args.sessionId, !!args.omitCookie);
            emit(id, { t: 'ok', deleted: okd });
            return;
          }
          if (method === 'models') {
            var rm = await fetch(BASE + '/api/v0/client/settings?scope=model', {
              headers: headers(args.token || '', args.deviceId || ''),
              credentials: args.omitCookie ? 'omit' : 'same-origin'
            });
            emit(id, { t: 'ok', status: rm.status, body: (await rm.text()).slice(0, 30000) });
            return;
          }
          if (method === 'usersCurrent') {
            var r2 = await fetch(BASE + '/api/v0/users/current', {
              headers: headers(args.token || '', args.deviceId || ''),
              credentials: args.omitCookie ? 'omit' : 'same-origin'
            });
            var bt = await r2.text();
            emit(id, { t: 'user', status: r2.status, body: bt.slice(0, 4000) });
            return;
          }
          if (method === 'completion') {
            var ac = new AbortController();
            ctl.abort = function () { try { ac.abort(); } catch (e) {} };
            ctl.signal = ac.signal;
            await runCompletion(id, args, ctl);
            return;
          }
          emit(id, { t: 'error', code: 'UNKNOWN_METHOD', msg: '未知方法 ' + method });
        } catch (e) {
          var msg = String((e && e.message) || e);
          var code = 'TRANSPORT';
          if (/abort/i.test(msg)) code = 'ABORTED';
          emit(id, { t: 'error', code: code, msg: msg });
        } finally {
          delete inflight[id];
        }
      })();
    },
    cancel: function (id) {
      var c = inflight[id];
      if (c && c.abort) c.abort();
      if (c) c.signal.aborted = true;
    },
    state: function () {
      return { token: readUserToken().length, url: location.href, deviceId: deviceId() };
    }
  };
  window.__DSH = API;
  log('已就绪 ' + location.href);

  // 登录成功后**自动**上报登录态（用户不用再去点「捕获」）。
  // 只在 token 从无到有、或换了一个新 token 时上报一次。
  var lastReported = '';
  setInterval(function () {
    try {
      var t = readUserToken();
      if (t && t.length > 16 && t !== lastReported) {
        lastReported = t;
        DSHBridge.emit('auto', JSON.stringify({
          t: 'ok',
          token: t,
          hifLeim: readHifLeim(),
          deviceId: deviceId(),
          userAgent: navigator.userAgent,
          url: location.href
        }));
      }
    } catch (e) {}
  }, 2500);
})();
