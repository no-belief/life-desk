/* 日常规划 · 生活工作台
 * 数据层：GitHub 仓库里的一个 JSON 文件即数据库。
 *   GET  contents API 读（拿 blob sha 做乐观锁）
 *   PUT  contents API 写（带 sha；409/422 时重新拉取并合并后重试）
 * 界面先渲染，再拉数据；读/写失败都有提示与重试，不白屏、不静默丢数据。
 */
(function () {
  'use strict';

  var CFG_KEY = 'workbench.config.v1';
  var CACHE_KEY = 'workbench.cache.v1';
  var API = 'https://api.github.com';

  var DEFAULTS = { owner: '', repo: '', branch: 'main', path: 'data/workspace.json', token: '' };
  var DURATIONS = [0, 15, 30, 45, 60, 90, 120];
  var PRIORITIES = [1, 2, 3];
  var P_LABEL = { 1: '要紧', 2: '照常', 3: '从容' };

  /* ---------------- 小工具 ---------------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseKey(k) { var p = String(k).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function shiftDays(k, n) { var d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); }
  function todayKey() { return keyOf(new Date()); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /* ---------------- 数据模型 ---------------- */
  function emptyData() { return { v: 1, updatedAt: 0, days: {} }; }
  function normTask(t, fallbackAt) {
    if (!t || typeof t !== 'object') return null;
    var text = typeof t.text === 'string' ? t.text.trim() : '';
    if (!text) return null;
    var p = PRIORITIES.indexOf(+t.p) >= 0 ? +t.p : 2;
    var dur = isFinite(+t.dur) ? Math.max(0, Math.min(600, Math.round(+t.dur))) : 0;
    var at = isFinite(+t.at) ? +t.at : (fallbackAt || 0);
    return {
      id: typeof t.id === 'string' && t.id ? t.id : uid(),
      text: text.slice(0, 140),
      done: !!t.done,
      doneAt: t.done && isFinite(+t.doneAt) ? +t.doneAt : 0,
      p: p, dur: dur,
      cat: typeof t.cat === 'string' ? t.cat.slice(0, 16) : '',
      at: at
    };
  }
  function normDay(d) {
    var out = { tasks: [], note: { text: '', at: 0 } };
    if (!d || typeof d !== 'object') return out;
    var list = Array.isArray(d.tasks) ? d.tasks : [];
    for (var i = 0; i < list.length; i++) {
      var t = normTask(list[i], 0);
      if (t) out.tasks.push(t);
    }
    if (d.note && typeof d.note === 'object' && typeof d.note.text === 'string') {
      out.note = { text: d.note.text.slice(0, 400), at: isFinite(+d.note.at) ? +d.note.at : 0 };
    } else if (typeof d.note === 'string') {
      out.note = { text: d.note.slice(0, 400), at: 0 };
    }
    return out;
  }
  function normalize(input) {
    var data = emptyData();
    if (!input || typeof input !== 'object') return data;
    if (input.days && typeof input.days === 'object' && !Array.isArray(input.days)) {
      for (var k in input.days) {
        if (!Object.prototype.hasOwnProperty.call(input.days, k)) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        data.days[k] = normDay(input.days[k]);
      }
    }
    data.updatedAt = isFinite(+input.updatedAt) ? +input.updatedAt : 0;
    return data;
  }
  function parseRemote(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('线上数据文件不是合法 JSON，已保留本机数据未覆盖'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('线上数据文件结构异常，已保留本机数据未覆盖');
    }
    if (obj.days != null && (typeof obj.days !== 'object' || Array.isArray(obj.days))) {
      throw new Error('线上数据文件结构异常（days 字段），已保留本机数据未覆盖');
    }
    return normalize(obj);
  }
  function pickNote(a, b) {
    var an = a && a.note ? a.note : { text: '', at: 0 };
    var bn = b && b.note ? b.note : { text: '', at: 0 };
    return (bn.at || 0) >= (an.at || 0) ? bn : an;
  }
  function mergeData(base, intent) {
    var out = emptyData();
    out.updatedAt = Math.max(base.updatedAt || 0, intent.updatedAt || 0);
    var keys = {}, k;
    for (k in base.days) keys[k] = 1;
    for (k in intent.days) keys[k] = 1;
    for (k in keys) {
      var da = base.days[k], db = intent.days[k];
      var map = {};
      var order = [];
      if (da) da.tasks.forEach(function (t) { if (!map[t.id]) { map[t.id] = t; order.push(t.id); } });
      if (db) db.tasks.forEach(function (t) {
        var prev = map[t.id];
        if (!prev) { map[t.id] = t; order.push(t.id); }
        else if ((t.at || 0) >= (prev.at || 0)) map[t.id] = t;
      });
      out.days[k] = {
        tasks: order.map(function (id) { return map[id]; }),
        note: pickNote(da, db)
      };
    }
    return out;
  }
  function tasksOf(data, k) {
    return (data.days[k] && data.days[k].tasks) || [];
  }
  function sortTasks(list) {
    return list.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.p !== b.p) return a.p - b.p;
      return (a.at || 0) - (b.at || 0);
    });
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    cfg: Object.assign({}, DEFAULTS),
    data: emptyData(),
    rev: '',
    sel: '',
    draft: { p: 2, dur: 0, cat: '' },
    editing: null,
    editDraft: { p: 2, dur: 0, cat: '' },
    noteOpen: false,
    saving: false,
    dirty: false,
    pendingLocal: false,
    editSeq: 0,
    backoff: 0,
    connectedOnce: false,
    status: { kind: 'idle', text: '启动中' }
  };

  var pushTimer = null;
  var banner = { text: '', actionLabel: '', onAction: null };

  /* ---------------- DOM ---------------- */
  var el = {};
  ['syncBtn', 'syncText', 'banner', 'bannerText', 'bannerRetry', 'bannerClose', 'openSettings',
    'days', 'dayNum', 'dayEyebrow', 'dayMon', 'dayCount', 'progressBar', 'prevDay', 'nextDay',
    'carry', 'carryText', 'carryBtn', 'composer', 'entry', 'composerMeta', 'tasks', 'listHint',
    'noteWrap', 'noteToggle', 'notePreview', 'noteInput',
    'settings', 'settingsForm', 'closeSettings', 'repoLabel', 'lastSync',
    'fOwner', 'fRepo', 'fBranch', 'fPath', 'fToken', 'cfgNote', 'saveCfg', 'syncNow', 'clearLocal'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  /* ---------------- 进度/状态 ---------------- */
  function setStatus(kind, text) {
    state.status = { kind: kind, text: text };
    if (!el.syncBtn) return;
    el.syncText.textContent = text;
    el.syncBtn.className = 'status status--' + kind;
    el.syncBtn.title = text;
  }
  function showBanner(text, actionLabel, onAction) {
    banner = { text: text, actionLabel: actionLabel || '', onAction: onAction || null };
    el.bannerText.textContent = text;
    if (banner.actionLabel) {
      el.bannerRetry.textContent = banner.actionLabel;
      el.bannerRetry.hidden = false;
    } else {
      el.bannerRetry.hidden = true;
    }
    el.banner.hidden = false;
  }
  function hideBanner() {
    banner = { text: '', actionLabel: '', onAction: null };
    el.banner.hidden = true;
  }

  /* ---------------- 配置与缓存 ---------------- */
  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      var o = JSON.parse(raw) || {};
      return {
        owner: String(o.owner || '').trim(),
        repo: String(o.repo || '').trim(),
        branch: String(o.branch || 'main').trim() || 'main',
        path: String(o.path || 'data/workspace.json').trim().replace(/^\/+/, '') || 'data/workspace.json',
        token: String(o.token || '').trim()
      };
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
    catch (e) { showBanner('无法在浏览器中保存设置（localStorage 不可用），本次设置只在当前页面有效。', '', null); }
  }
  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.data) return null;
      return {
        data: normalize(o.data),
        rev: typeof o.rev === 'string' ? o.rev : '',
        pending: !!o.pending,
        at: +o.at || 0
      };
    } catch (e) { return null; }
  }
  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        data: state.data, rev: state.rev, pending: !!state.pendingLocal, at: Date.now()
      }));
    } catch (e) { /* 缓存失败不影响线上写入 */ }
  }
  function cfgReady() { return !!(state.cfg.owner && state.cfg.repo && state.cfg.path); }

  /* ---------------- GitHub 数据层 ---------------- */
  function contentsUrl() {
    var c = state.cfg;
    return API + '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) +
      '/contents/' + c.path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(c.branch);
  }
  function headers(extra) {
    var h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (state.cfg.token) h['Authorization'] = 'Bearer ' + state.cfg.token;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  function httpError(res, msg) {
    if (res.status === 401) return new Error('访问令牌无效或已过期（401），请在设置里更新令牌');
    if (res.status === 403) return new Error('没有权限或被限流（403）' + (msg ? '：' + msg : ''));
    if (res.status === 404) return new Error('找不到仓库或数据文件（404），请检查所有者、仓库名、分支与路径');
    if (res.status === 429) return new Error('请求过于频繁（429），请稍后重试');
    if (res.status >= 500) return new Error('GitHub 暂时不可用（' + res.status + '），请稍后重试');
    return new Error('请求失败（' + res.status + '）' + (msg ? '：' + msg : ''));
  }
  async function ghFetch(url, init) {
    var res;
    try { res = await fetch(url, init); }
    catch (e) { throw new Error('网络不可达或请求被浏览器拦截，请检查网络后重试'); }
    if (res.ok) return res;
    var msg = '';
    try { var j = await res.clone().json(); msg = j && j.message ? String(j.message) : ''; } catch (e2) { }
    throw httpError(res, msg);
  }

  // 读取线上文件 -> { exists, data, sha }
  async function readRemote() {
    if (!cfgReady()) throw new Error('尚未配置数据仓库');
    var res = await fetch(contentsUrl(), { headers: headers(), cache: 'no-store' });
    if (res.status === 404) {
      var body = await safeJson(res);
      var m = body && body.message ? String(body.message) : '';
      if (/not found/i.test(m) || res.status === 404) return { exists: false, data: null, sha: '' };
    }
    if (!res.ok) {
      var j = await safeJson(res);
      throw httpError(res, j && j.message ? String(j.message) : '');
    }
    var meta = await res.json();
    if (Array.isArray(meta)) throw new Error('数据路径指向一个目录，请改成具体的 JSON 文件路径');
    if (typeof meta.content !== 'string') throw new Error('线上文件内容为空或格式不支持（可能是大于 1MB 的文件）');
    var text = meta.encoding === 'base64' ? b64ToUtf8(meta.content) : meta.content;
    return { exists: true, data: parseRemote(text), sha: meta.sha || '' };
  }
  async function safeJson(res) { try { return await res.json(); } catch (e) { return null; } }

  // 写入线上文件 -> 新 sha
  async function writeRemote(data, sha) {
    if (!cfgReady()) throw new Error('尚未配置数据仓库');
    var payload = { message: 'plan: ' + new Date().toISOString(), content: utf8ToB64(JSON.stringify(data, null, 2)), branch: state.cfg.branch };
    if (sha) payload.sha = sha;
    var res = await fetch(contentsUrl(), {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    if (res.status === 409 || res.status === 422) {
      var err = new Error('线上文件已被另一台设备更新，正在重新合并后保存'); err.conflict = true; throw err;
    }
    if (!res.ok) {
      var j = await safeJson(res);
      throw httpError(res, j && j.message ? String(j.message) : '');
    }
    var out = await res.json();
    return (out && out.content && out.content.sha) || '';
  }

  // 拉取：远端更新则以远端为准；本机有未推送的更新则保留本机并推送
  async function pull(opts) {
    opts = opts || {};
    if (!cfgReady()) {
      setStatus('idle', '未连接');
      if (!opts.silent) {
        showBanner('还没有连接数据仓库。点「设置」填一次仓库信息，之后每次打开都会自动从线上拉取。', '去设置', openSettings);
      }
      renderRepoLabel();
      return;
    }
    if (!opts.force && (state.dirty || state.saving)) { flush(); return; }
    setStatus('syncing', '拉取中…');
    var remote = await readRemote();
    if (!remote.exists) {
      // 线上还没有这个文件：用本机现有的数据初始化它
      var seed = state.data;
      seed.updatedAt = Date.now();
      var newSha = await writeRemote(seed, '');
      state.rev = newSha;
      state.data = seed;
      state.connectedOnce = true;
      saveCache(); renderAll(); setStatus('ok', '已初始化 · ' + hhmm());
      hideBanner();
      return;
    }
    state.rev = remote.sha;
    state.connectedOnce = true;
    var localNewer = state.pendingLocal || (state.data.updatedAt || 0) > (remote.data.updatedAt || 0);
    if (localNewer && hasContent(state.data)) {
      state.data = mergeData(remote.data, state.data);
      markDirty();
      setStatus('ok', '本机较新 · 已排队保存');
    } else {
      state.data = remote.data;
    }
    saveCache();
    renderAll();
    setStatus('ok', '已同步 · ' + hhmm());
    hideBanner();
    if (state.dirty) flush();
  }
  function hasContent(d) {
    for (var k in d.days) { if (d.days[k].tasks.length || (d.days[k].note.text || '')) return true; }
    return false;
  }

  // 推送：带乐观锁，冲突则重新拉取+合并+重试
  async function flush() {
    if (state.saving) { state.dirty = true; return; }
    if (!state.dirty) return;
    if (!cfgReady()) {
      setStatus('error', '未连接 · 待保存');
      showBanner('本机有改动尚未保存：还没有连接数据仓库。', '去设置', openSettings);
      return;
    }
    state.saving = true;
    state.dirty = false;
    var seq = state.editSeq;
    var intent = clone(state.data);
    setStatus('saving', '保存中…');
    try {
      var written = intent, attempts = 0;
      for (;;) {
        try {
          state.rev = await writeRemote(written, state.rev);
          break;
        } catch (e) {
          if (!e.conflict || attempts >= 2) throw e;
          attempts++;
          var remote = await readRemote();
          if (remote.exists) {
            state.rev = remote.sha;
            written = mergeData(remote.data, written);
            written.updatedAt = Date.now();
          } else {
            state.rev = '';
          }
        }
      }
      var editedDuringSave = state.editSeq !== seq;
      if (editedDuringSave) state.data = mergeData(written, state.data);
      else state.data = written;
      state.backoff = 0;
      state.pendingLocal = false;
      saveCache();
      renderAll();
      setStatus('ok', '已保存 · ' + hhmm());
      setLastSync();
      hideBanner();
      if (editedDuringSave) { state.dirty = true; schedulePush(0); }
    } catch (e) {
      state.dirty = true;
      state.backoff = Math.min(30000, (state.backoff || 800) * 2);
      setStatus('error', '保存失败 · 待重试');
      showBanner('保存失败：' + (e.message || '未知错误') + '。本机改动已保留，恢复后可点重试。', '重试保存', function () {
        hideBanner(); state.backoff = 0; flush();
      });
      schedulePush(state.backoff);
    } finally {
      state.saving = false;
    }
  }

  function markDirty() { state.dirty = true; state.pendingLocal = true; state.editSeq++; }
  function schedulePush(delay) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; flush(); }, typeof delay === 'number' ? delay : 500);
  }

  /* ---------------- 变更入口 ---------------- */
  function mutate(fn, opts) {
    opts = opts || {};
    fn(state.data);
    state.data.updatedAt = Date.now();
    markDirty();
    saveCache();
    schedulePush();
    if (opts.render !== false) renderAll();
  }
  function findTask(data, dayKey, id) {
    var list = tasksOf(data, dayKey);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function ensureDay(data, dayKey) {
    if (!data.days[dayKey]) data.days[dayKey] = { tasks: [], note: { text: '', at: 0 } };
    return data.days[dayKey];
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    renderDays();
    renderDay();
    renderCarry();
    renderRepoLabel();
    renderStatusLine();
  }

  function renderDays() {
    var base = todayKey();
    var sel = state.sel || shiftDays(base, 1);
    var today = base, tomorrow = shiftDays(base, 1);
    var keys = [], maxOpen = 1, i, kk, o;
    for (i = -1; i < 14; i++) {
      kk = shiftDays(base, i);
      keys.push(kk);
      o = tasksOf(state.data, kk).filter(function (t) { return !t.done; }).length;
      if (o > maxOpen) maxOpen = o;
    }
    var html = '';
    keys.forEach(function (k) {
      var d = parseKey(k);
      var open = tasksOf(state.data, k).filter(function (t) { return !t.done; }).length;
      var label = k === today ? '今' : k === tomorrow ? '明' : '日一二三四五六'[d.getDay()];
      var pct = open ? Math.max(24, Math.round(open / maxOpen * 100)) : 0;
      html += '<button type="button" class="day' + (k === today ? ' is-today' : '') + '" data-day="' + k +
        '" aria-current="' + (k === sel ? 'date' : 'false') + '">' +
        '<span class="day__w">' + label + '</span>' +
        '<span class="day__n">' + d.getDate() + '</span>' +
        '<span class="day__bar"><i style="width:' + pct + '%"></i></span>' +
        '</button>';
    });
    el.days.innerHTML = html;
    var selBtn = el.days.querySelector('[aria-current="date"]');
    if (selBtn) {
      var strip = el.days;
      var target = selBtn.offsetLeft - (strip.clientWidth - selBtn.offsetWidth) / 2;
      var max = Math.max(0, strip.scrollWidth - strip.clientWidth);
      strip.scrollLeft = Math.max(0, Math.min(max, target));
    }
  }

  function renderDay() {
    var k = state.sel;
    var d = parseKey(k);
    var t = todayKey();
    var eyebrow = k === t ? '今天' : k === shiftDays(t, 1) ? '明日计划' : '计划';
    el.dayEyebrow.textContent = eyebrow;
    el.dayNum.textContent = d.getDate();
    el.dayMon.textContent = (d.getMonth() + 1) + '月 · 周' + '日一二三四五六'[d.getDay()];

    var list = sortTasks(tasksOf(state.data, k));
    var done = list.filter(function (x) { return x.done; }).length;
    var mins = list.reduce(function (s, x) { return s + (x.dur || 0); }, 0);
    el.dayCount.textContent = list.length
      ? (done + '/' + list.length + (mins ? ' · ' + fmtDur(mins) : ''))
      : '';
    el.progressBar.style.width = list.length ? (done / list.length * 100) + '%' : '0%';

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var task = list[i];
      if (state.editing === task.id) {
        html += '<li class="task is-editing" data-id="' + esc(task.id) + '">' +
          '<span></span>' +
          '<div class="editrow">' +
          '<input class="editrow__input" type="text" maxlength="140" value="' + esc(task.text) + '" aria-label="修改任务">' +
          metaBarHtml(state.editDraft) +
          '<div class="editrow__foot">' +
          '<button type="button" class="btn btn--seal" data-act="edit-save">保存</button>' +
          '<button type="button" class="btn" data-act="edit-cancel">取消</button>' +
          '</div></div>' +
          '<span class="task__act"><button type="button" class="icon" data-act="del" title="删除">删除</button></span>' +
          '</li>';
        continue;
      }
      var meta = '';
      meta += '<span class="tag tag--p' + task.p + '">' + esc(P_LABEL[task.p]) + '</span>';
      if (task.cat) meta += '<span class="tag">' + esc(task.cat) + '</span>';
      if (task.dur) meta += '<span class="tag">' + esc(fmtDur(task.dur)) + '</span>';
      html += '<li class="task' + (task.done ? ' is-done' : '') + '" data-id="' + esc(task.id) + '">' +
        '<button type="button" class="tick" data-act="toggle" aria-pressed="' + (task.done ? 'true' : 'false') +
        '" aria-label="' + (task.done ? '标记为未完成' : '标记为完成') + '"></button>' +
        '<div><button type="button" class="task__title" data-act="edit">' + esc(task.text) + '</button>' +
        '<span class="task__meta">' + meta + '</span></div>' +
        '<span class="task__act"><button type="button" class="icon" data-act="del" title="删除">删除</button></span>' +
        '</li>';
    }
    el.tasks.innerHTML = html;

    var empty = list.length === 0;
    el.listHint.hidden = !empty;
    el.listHint.textContent = empty
      ? (k === shiftDays(t, 1) ? '明天还是空的。写下一件你真正想做完的事，别多。' : '这一天还没有安排。')
      : '';

    if (state.editing) {
      var inp = el.tasks.querySelector('.editrow__input');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }

    var noteText = (state.data.days[k] && state.data.days[k].note.text) || '';
    var keepFocus = document.activeElement === el.noteInput && state.noteDay === k;
    if (!keepFocus) el.noteInput.value = noteText;
    state.noteDay = k;
    el.notePreview.textContent = noteText.replace(/\s+/g, ' ').trim();
    if (state.noteOpen) el.noteWrap.classList.add('is-open');
    else el.noteWrap.classList.remove('is-open');
    el.noteToggle.setAttribute('aria-expanded', state.noteOpen ? 'true' : 'false');
  }

  function fmtDur(m) {
    if (m < 60) return m + ' 分';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' 时' + (r ? ' ' + r + ' 分' : '');
  }

  function metaBarHtml(draft) {
    var p = '';
    for (var i = 0; i < PRIORITIES.length; i++) {
      var v = PRIORITIES[i];
      p += '<button type="button" data-p="' + v + '" class="' + (draft.p === v ? 'is-on' : '') + '">' + P_LABEL[v] + '</button>';
    }
    var dOpts = '';
    DURATIONS.forEach(function (m) {
      dOpts += '<option value="' + m + '"' + (draft.dur === m ? ' selected' : '') + '>' + (m ? fmtDur(m) : '不估时') + '</option>';
    });
    return '<div class="seg" data-act="p" role="group" aria-label="轻重">' + p + '</div>' +
      '<input class="cat" type="text" maxlength="8" data-act="cat" placeholder="分类（可选）" value="' + esc(draft.cat) + '">' +
      '<select class="cat" data-act="dur" aria-label="预计时长">' + dOpts + '</select>';
  }

  // 顺延提示只在前一天确有未完成时出现，占用固定的一行高度
  function renderCarry() {
    var from = shiftDays(state.sel, -1);
    var pending = tasksOf(state.data, from).filter(function (t) { return !t.done; });
    if (!pending.length) {
      el.carry.hidden = true;
      el.carryBtn.disabled = true;
      return;
    }
    el.carry.hidden = false;
    el.carryBtn.disabled = false;
    var preview = pending.slice(0, 2).map(function (t) { return t.text; }).join('、');
    el.carryText.textContent = (from === todayKey() ? '今天' : '上一天') + '有 ' + pending.length +
      ' 项没做完：' + preview + (pending.length > 2 ? ' 等' : '');
    el.carryBtn.textContent = '顺延过来';
  }

  function renderRepoLabel() {
    if (!cfgReady()) {
      el.repoLabel.innerHTML = '<i>尚未连接仓库</i>';
      el.lastSync.textContent = '—';
      return;
    }
    var c = state.cfg;
    el.repoLabel.innerHTML = '<b>' + esc(c.owner + '/' + c.repo) + '</b><br>' +
      '<i>' + esc(c.branch) + ' · ' + esc(c.path) + (c.token ? '' : ' · 只读') + '</i>';
    setLastSync();
  }
  function setLastSync() {
    el.lastSync.textContent = state.status.kind === 'ok' ? hhmm() : (state.status.kind === 'error' ? '待重试' : '—');
  }
  function renderStatusLine() { setLastSync(); }
  function hhmm() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------------- 交互 ---------------- */
  function addTask(text) {
    text = String(text || '').trim();
    if (!text) return;
    var dayKey = state.sel;
    var draft = state.draft;
    mutate(function (data) {
      var day = ensureDay(data, dayKey);
      day.tasks.push({
        id: uid(), text: text.slice(0, 140), done: false, doneAt: 0,
        p: draft.p, dur: draft.dur, cat: String(draft.cat || '').trim().slice(0, 16), at: Date.now()
      });
    });
    el.entry.value = '';
    el.composer.classList.remove('has-value');
  }

  el.composer.addEventListener('submit', function (ev) {
    ev.preventDefault();
    addTask(el.entry.value);
    el.entry.focus();
  });
  el.entry.addEventListener('input', function () {
    el.composer.classList.toggle('has-value', !!el.entry.value.trim());
  });

  el.composerMeta.innerHTML = metaBarHtml(state.draft);
  el.composerMeta.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-p]');
    if (!b) return;
    state.draft.p = +b.getAttribute('data-p');
    el.composerMeta.innerHTML = metaBarHtml(state.draft);
  });
  el.composerMeta.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.getAttribute('data-act') === 'dur') { state.draft.dur = +t.value || 0; }
    if (t.getAttribute('data-act') === 'cat') { state.draft.cat = t.value; }
  });
  el.composerMeta.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.getAttribute('data-act') === 'cat') state.draft.cat = t.value;
  });

  el.tasks.addEventListener('click', function (ev) {
    var li = ev.target.closest('.task');
    if (!li) return;
    var id = li.getAttribute('data-id');
    var actEl = ev.target.closest('[data-act]');
    var act = actEl ? actEl.getAttribute('data-act') : '';
    var dayKey = state.sel;

    if (act === 'toggle') {
      mutate(function (data) {
        var t = findTask(data, dayKey, id);
        if (!t) return;
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : 0;
        t.at = Date.now();
      });
      return;
    }
    if (act === 'del') {
      mutate(function (data) {
        var day = data.days[dayKey];
        if (!day) return;
        day.tasks = day.tasks.filter(function (t) { return t.id !== id; });
        if (!day.tasks.length && !day.note.text) delete data.days[dayKey];
      });
      return;
    }
    if (act === 'edit') {
      var t = findTask(state.data, dayKey, id);
      if (!t) return;
      state.editing = id;
      state.editDraft = { p: t.p, dur: t.dur, cat: t.cat };
      renderDay();
      return;
    }
    if (act === 'edit-save') {
      var inp = li.querySelector('.editrow__input');
      var val = inp ? inp.value.trim() : '';
      if (!val) { state.editing = null; renderDay(); return; }
      var d = state.editDraft;
      mutate(function (data) {
        var t2 = findTask(data, dayKey, id);
        if (!t2) return;
        t2.text = val.slice(0, 140);
        t2.p = d.p; t2.dur = d.dur; t2.cat = String(d.cat || '').trim().slice(0, 16);
        t2.at = Date.now();
      });
      state.editing = null;
      renderDay();
      return;
    }
    if (act === 'edit-cancel') { state.editing = null; renderDay(); return; }
    if (act === 'p') {
      var pb = ev.target.closest('button[data-p]');
      if (!pb) return;
      state.editDraft.p = +pb.getAttribute('data-p');
      var host = li.querySelector('.editrow .seg');
      if (host) {
        Array.prototype.forEach.call(host.querySelectorAll('button'), function (b) {
          b.className = b.getAttribute('data-p') === String(state.editDraft.p) ? 'is-on' : '';
        });
      }
    }
  });
  el.tasks.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.getAttribute('data-act') === 'dur') state.editDraft.dur = +t.value || 0;
  });
  el.tasks.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.getAttribute('data-act') === 'cat') state.editDraft.cat = t.value;
  });
  el.tasks.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target.classList.contains('editrow__input')) {
      ev.preventDefault();
      var li = ev.target.closest('.task');
      var btn = li && li.querySelector('[data-act="edit-save"]');
      if (btn) btn.click();
    }
    if (ev.key === 'Escape' && state.editing) { state.editing = null; renderDay(); }
  });

  el.days.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-day]');
    if (!b) return;
    state.editing = null;
    state.sel = b.getAttribute('data-day');
    renderDays(); renderDay(); renderCarry();
  });
  el.prevDay.addEventListener('click', function () { state.editing = null; state.sel = shiftDays(state.sel, -1); renderDays(); renderDay(); renderCarry(); });
  el.nextDay.addEventListener('click', function () { state.editing = null; state.sel = shiftDays(state.sel, 1); renderDays(); renderDay(); renderCarry(); });

  // 一天一句：默认收起，点开才展开
    el.noteToggle.addEventListener('click', function () {
      state.noteOpen = !state.noteOpen;
      el.noteWrap.classList.toggle('is-open', state.noteOpen);
      el.noteToggle.setAttribute('aria-expanded', state.noteOpen ? 'true' : 'false');
      if (state.noteOpen) el.noteInput.focus();
    });

  var noteTimer = null;
  el.noteInput.addEventListener('input', function () {
    var v = el.noteInput.value;
    mutate(function (data) {
      var day = ensureDay(data, state.sel);
      day.note = { text: v.slice(0, 400), at: Date.now() };
    }, { render: false });
    el.notePreview.textContent = v.replace(/\s+/g, ' ').trim();
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { saveCache(); }, 400);
  });

  el.carryBtn.addEventListener('click', function () {
    var from = shiftDays(state.sel, -1), to = state.sel;
    var pending = tasksOf(state.data, from).filter(function (t) { return !t.done; });
    if (!pending.length) return;
    mutate(function (data) {
      var src = data.days[from];
      var dst = ensureDay(data, to);
      var existing = {};
      dst.tasks.forEach(function (t) { existing[t.text] = 1; });
      src.tasks.forEach(function (t) {
        if (t.done || existing[t.text]) return;
        dst.tasks.push({
          id: uid(), text: t.text, done: false, doneAt: 0,
          p: t.p, dur: t.dur, cat: t.cat, at: Date.now()
        });
      });
      data.days[from].tasks = src.tasks.filter(function (t) { return t.done; });
      if (!data.days[from].tasks.length && !data.days[from].note.text) delete data.days[from];
    });
  });

  /* ---------------- 设置面板 ---------------- */
  function openSettings() {
    var c = state.cfg;
    el.fOwner.value = c.owner;
    el.fRepo.value = c.repo;
    el.fBranch.value = c.branch;
    el.fPath.value = c.path;
    el.fToken.value = c.token;
    el.cfgNote.textContent = c.token
      ? '令牌已保存在这台设备。留空保存则清除令牌。'
      : '没有令牌时只能读取公开仓库；私有仓库必须填令牌。';
    if (typeof el.settings.showModal === 'function') el.settings.showModal();
    else el.settings.setAttribute('open', '');
  }
  function closeSettings() {
    if (typeof el.settings.close === 'function') el.settings.close();
    else el.settings.removeAttribute('open');
  }
  el.openSettings.addEventListener('click', openSettings);
  el.closeSettings.addEventListener('click', function (ev) { ev.preventDefault(); closeSettings(); });

  el.settingsForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var cfg = {
      owner: el.fOwner.value.trim(),
      repo: el.fRepo.value.trim(),
      branch: el.fBranch.value.trim() || 'main',
      path: el.fPath.value.trim().replace(/^\/+/, '') || 'data/workspace.json',
      token: el.fToken.value.trim()
    };
    if (!cfg.owner || !cfg.repo) {
      el.cfgNote.textContent = '仓库所有者和仓库名必填。';
      return;
    }
    state.cfg = cfg;
    saveCfg(cfg);
    state.rev = '';
    closeSettings();
    renderRepoLabel();
    setStatus('syncing', '连接中…');
    pull({ silent: false, force: true }).catch(function (e) {
      setStatus('error', '连接失败');
      showBanner('连接失败：' + (e.message || '未知错误'), '重试连接', function () { hideBanner(); retryPull(); });
    });
  });
  el.syncNow.addEventListener('click', function () { retryPull(); });
  el.syncBtn.addEventListener('click', function () {
    if (banner.onAction) { banner.onAction(); return; }
    retryPull();
  });
  el.bannerRetry.addEventListener('click', function () { if (banner.onAction) banner.onAction(); });
  el.bannerClose.addEventListener('click', hideBanner);
  el.clearLocal.addEventListener('click', function () {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { }
    el.cfgNote.textContent = '已清除本机缓存，重新加载后将从线上读取。';
  });

  function retryPull() {
    setStatus('syncing', '拉取中…');
    pull({ silent: false }).catch(function (e) {
      setStatus('error', '读取失败');
      showBanner('读取失败：' + (e.message || '未知错误'), '重试读取', function () { hideBanner(); retryPull(); });
    });
  }

  /* ---------------- 生命周期 ---------------- */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && cfgReady()) {
      pull({ silent: true }).catch(function () { /* 保持界面，静默失败由下次手动刷新兜底 */ });
    }
  });
  window.addEventListener('online', function () {
    if (state.dirty) { state.backoff = 0; flush(); }
    else if (cfgReady()) pull({ silent: true }).catch(function () { });
  });
  window.addEventListener('beforeunload', function (ev) {
    if (state.dirty || state.saving) { ev.preventDefault(); ev.returnValue = ''; }
  });

  function boot() {
    state.sel = shiftDays(todayKey(), 1);   // 默认停在「明天」
    state.cfg = loadCfg();
    var cached = loadCache();
    if (cached) {
      state.data = cached.data;
      state.rev = cached.rev || '';
      state.pendingLocal = cached.pending;   // 上次没推上去的改动，绝不能被远端覆盖
    }

    // 第一帧：先把界面画出来，再谈数据
    renderAll();
    setStatus(cached ? 'idle' : 'idle', cached ? '本机缓存 · 正在同步' : '正在连接');

    if (!cfgReady()) {
      renderRepoLabel();
      showBanner('还没有连接数据仓库。点「设置」填一次仓库信息，之后每次打开都会自动从线上拉取。', '去设置', openSettings);
      setStatus('idle', '未连接');
      return;
    }
    pull({ silent: false }).catch(function (e) {
      var kind = e && /网络/.test(e.message || '') ? '离线' : '读取失败';
      setStatus('error', kind + ' · 使用本机缓存');
      showBanner(kind + '：' + (e.message || '未知错误') + (cached ? '。当前显示的是本机上次缓存。' : ''), '重试读取', function () {
        hideBanner(); retryPull();
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
