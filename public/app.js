'use strict';

/* ============================================================
 * 学祭グループチャット フロントエンド(ビルド不要の素の JS)
 * ============================================================ */

const PERM_LABEL = { write: '閲覧・送信', read: '閲覧のみ', none: '参加させない' };
const SOURCE_LABEL = {
  admin: '管理者',
  creator: 'チャット作成者',
  override: '個別設定',
  role: 'ロール',
  default: 'チャット既定',
  level: 'ロールの権限(閲覧のみ)',
};
/** ロールの権限レベル */
const LEVEL_LABEL = { read: '閲覧のみ', write: '閲覧・送信', moderator: 'リーダー', admin: '管理者' };
const LEVEL_HELP = {
  read: 'チャットの閲覧のみ(送信不可)',
  write: 'チャットの閲覧・送信',
  moderator: '閲覧・送信 + チャット作成・アナウンス(作成したチャットは管理可)',
  admin: '全てのチャットの管理・ロール付与・グループ設定の編集',
};
const LEVEL_ICON = { read: '👁', write: '💬', moderator: '📣', admin: '⭐' };
const ROLE_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280'];

const state = {
  me: null,
  groups: [],
  group: null, // { group, me, roles, members }
  channels: [],
  view: null, // { type: 'channel', id } | { type: 'announcements' }
  messages: [],
  hasMore: false,
  announcements: [],
  memberCount: 0,
  unreadChannels: new Set(),
  sidebarOpen: false,
  annBannerOpen: false, // チャット上部のアナウンスを全文表示しているか
  pushStatus: null, // この端末の通知の状態(pushStatus() の値)
};
let socket = null;
let pendingFiles = [];

// ---------- 汎用ヘルパー ----------

/** DOM 要素を生成する。文字列の子は textContent として扱うので XSS にならない */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (res.status === 401 && !url.startsWith('/api/auth/login')) {
    state.me = null;
    renderAuth();
  }
  if (!res.ok) {
    const err = new Error(data.error || `エラーが発生しました (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

function toast(message, type = '') {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

/** 非同期処理のエラーをトーストで表示する */
const guard =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

function colorFor(id) {
  const palette = ['#f97316', '#3b82f6', '#22c55e', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#ef4444'];
  return palette[id % palette.length];
}

const fmtTime = (t) => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
const fmtDateTime = (t) => `${fmtDate(t)} ${fmtTime(t)}`;

function roleById(id) {
  return state.group?.roles.find((r) => r.id === id);
}

function roleChip(role) {
  return h('span', { class: 'chip', style: { background: role.color } }, role.name);
}

function isAdmin() {
  return !!state.group?.me.isAdmin;
}

// ---------- 画像ビューア ----------

const MAX_ZOOM = 5;
// スマホの「戻る」で前の画面ではなく開いているビューアを閉じる。
// ✕ などで閉じたときに自分で呼ぶ history.back() の popstate は無視する
let activeLightboxClose = null;
let lightboxBackPending = false;
window.addEventListener('popstate', () => {
  if (lightboxBackPending) {
    lightboxBackPending = false;
    // 戻る処理の途中で次のビューアが開かれていたら、ここで履歴に積む
    if (activeLightboxClose) history.pushState({ lightbox: true }, '');
    return;
  }
  activeLightboxClose?.(true);
});
const DOUBLE_TAP_ZOOM = 2.5;

/** 画像を保存する。スマホでは共有シート(「画像を保存」で写真アプリへ)、PC ではダウンロード */
async function saveImage(att) {
  const res = await fetch(att.url);
  if (!res.ok) throw new Error('画像を取得できませんでした');
  const blob = await res.blob();
  const file = new File([blob], att.name, { type: blob.type });
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: att.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 画像を全画面で表示する。
 * ピンチ・ダブルタップ・ホイールで拡大、拡大中はドラッグで移動、
 * 左右スワイプ(または ← →)で前後の画像へ、下スワイプ・✕・Esc・背景タップで閉じる。
 */
function openLightbox(attachments, startIndex = 0) {
  let index = startIndex;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const pointers = new Map();
  let gesture = null;
  let lastTap = null;

  const img = h('img', { class: 'lb-img', alt: '', draggable: false });
  const counter = h('span', { class: 'lb-counter' });
  const prevBtn = h('button', { class: 'lb-nav lb-prev', 'aria-label': '前の画像', onclick: (e) => (e.stopPropagation(), go(-1)) }, '‹');
  const nextBtn = h('button', { class: 'lb-nav lb-next', 'aria-label': '次の画像', onclick: (e) => (e.stopPropagation(), go(1)) }, '›');
  const saveBtn = h(
    'button',
    {
      class: 'lb-btn',
      onclick: guard(async (e) => {
        e.stopPropagation();
        saveBtn.disabled = true;
        try {
          await saveImage(attachments[index]);
        } finally {
          saveBtn.disabled = false;
        }
      }),
    },
    '⬇ 保存',
  );
  const closeBtn = h('button', { class: 'lb-btn lb-close', 'aria-label': '閉じる', onclick: (e) => (e.stopPropagation(), close()) }, '✕');
  const stage = h('div', { class: 'lb-stage' }, img);
  const box = h(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': '画像ビューア' },
    h('div', { class: 'lb-bar' }, counter, h('span', { class: 'lb-spacer' }), saveBtn, closeBtn),
    stage,
    prevBtn,
    nextBtn,
  );

  // ---- 表示・切り替え ----

  function apply(animate) {
    img.classList.toggle('animate', !!animate);
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    box.classList.toggle('zoomed', scale > 1);
  }

  function reset(animate) {
    scale = 1;
    tx = 0;
    ty = 0;
    apply(animate);
  }

  function show(i) {
    index = i;
    const att = attachments[index];
    img.src = att.url;
    img.alt = att.name;
    counter.textContent = attachments.length > 1 ? `${index + 1} / ${attachments.length}` : '';
    prevBtn.classList.toggle('hidden', index === 0);
    nextBtn.classList.toggle('hidden', index === attachments.length - 1);
    reset(false);
  }

  function go(delta) {
    const next = index + delta;
    if (next < 0 || next >= attachments.length) return reset(true);
    show(next);
  }

  // ---- 拡大・移動 ----

  const center = () => {
    const r = stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  /** 画面上の点 (x, y) を固定したまま倍率を変える */
  function zoomAt(x, y, newScale, animate) {
    newScale = Math.min(MAX_ZOOM, Math.max(1, newScale));
    const c = center();
    const px = (x - c.x - tx) / scale;
    const py = (y - c.y - ty) / scale;
    scale = newScale;
    tx = x - c.x - scale * px;
    ty = y - c.y - scale * py;
    clamp();
    apply(animate);
  }

  /** 拡大した画像が画面外へ行き過ぎないように移動量を制限する */
  function clamp() {
    if (scale <= 1) {
      tx = 0;
      ty = 0;
      return;
    }
    const r = stage.getBoundingClientRect();
    const maxX = Math.max(0, (img.offsetWidth * scale - r.width) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - r.height) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function startGesture(afterPinch = false) {
    const pts = [...pointers.values()];
    if (pts.length >= 2) {
      gesture = { type: 'pinch', dist: dist(pts[0], pts[1]), scale, mid: mid(pts[0], pts[1]), tx, ty };
    } else if (pts.length === 1) {
      // ピンチ直後に残った指を離したときはタップ扱いにしない
      gesture = { type: 'drag', x: pts[0].x, y: pts[0].y, tx, ty, moved: afterPinch, afterPinch };
    }
  }

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size > 2) return;
    startGesture();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.values()];
    if (gesture.type === 'pinch' && pts.length >= 2) {
      const m = mid(pts[0], pts[1]);
      const c = center();
      // ピンチ開始時に指の間にあった画像上の点を、指の中心に追従させる
      const px = (gesture.mid.x - c.x - gesture.tx) / gesture.scale;
      const py = (gesture.mid.y - c.y - gesture.ty) / gesture.scale;
      scale = Math.min(MAX_ZOOM, Math.max(0.8, (gesture.scale * dist(pts[0], pts[1])) / gesture.dist));
      tx = m.x - c.x - scale * px;
      ty = m.y - c.y - scale * py;
      apply(false);
    } else if (gesture.type === 'drag') {
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      if (Math.hypot(dx, dy) > 8) gesture.moved = true;
      if (scale > 1) {
        tx = gesture.tx + dx;
        ty = gesture.ty + dy;
        clamp();
      } else {
        // 等倍のときはスワイプ操作の手応えとして画像を指に追従させる
        tx = dx;
        ty = Math.max(0, dy);
        box.style.setProperty('--lb-fade', String(Math.max(0.3, 1 - ty / 400)));
      }
      apply(false);
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const g = gesture;
    pointers.delete(e.pointerId);
    if (g?.type === 'pinch') {
      if (scale < 1.05) reset(true);
      else {
        clamp();
        apply(true);
      }
      // 指が 1 本残っていればそのまま移動に切り替える
      startGesture(true);
      return;
    }
    gesture = null;
    if (!g || e.type === 'pointercancel') return;
    box.style.removeProperty('--lb-fade');

    if (g.afterPinch) return;
    if (scale <= 1 && g.moved) {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (dy > 120 && dy > Math.abs(dx)) return close();
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) return go(dx < 0 ? 1 : -1);
      return reset(true);
    }
    if (g.moved) return;

    // タップ: ダブルタップで拡大 / 縮小、画像の外をタップで閉じる
    const now = Date.now();
    if (lastTap && now - lastTap.time < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null;
      if (scale > 1) reset(true);
      else zoomAt(e.clientX, e.clientY, DOUBLE_TAP_ZOOM, true);
      return;
    }
    lastTap = { time: now, x: e.clientX, y: e.clientY };
    if (e.target !== img && scale <= 1) {
      setTimeout(() => {
        if (lastTap && lastTap.time === now) close();
      }, 300);
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, scale * Math.exp(-e.deltaY / 300), false);
    },
    { passive: false },
  );
  img.addEventListener('dblclick', (e) => e.preventDefault());

  // ---- 開閉 ----

  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  }

  let closed = false;
  function close(fromHistory) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    activeLightboxClose = null;
    box.remove();
    if (!fromHistory && history.state?.lightbox) {
      lightboxBackPending = true;
      history.back();
    }
  }

  document.addEventListener('keydown', onKey);
  if (!lightboxBackPending) history.pushState({ lightbox: true }, '');
  activeLightboxClose = close;
  document.body.append(box);
  show(index);
  closeBtn.focus();
}

// ---------- モーダル ----------

function modal(title, body, { wide } = {}) {
  const close = () => bg.remove();
  const bg = h(
    'div',
    { class: 'modal-bg', onmousedown: (e) => e.target === bg && close() },
    h(
      'div',
      { class: 'modal', style: wide ? { maxWidth: '760px' } : null },
      h(
        'div',
        { class: 'modal-head' },
        h('h3', {}, title),
        h('button', { class: 'btn icon', onclick: close, 'aria-label': '閉じる' }, '✕'),
      ),
      h('div', { class: 'modal-body' }, body),
    ),
  );
  document.body.append(bg);
  bg.querySelector('input:not([type=checkbox]), textarea, select')?.focus();
  return { close, root: bg };
}

/** 入力フォーム付きモーダル。onSubmit が例外を投げたらフォーム内に表示する */
function formModal(title, fields, submitLabel, onSubmit) {
  const err = h('div', { class: 'error' });
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          await onSubmit(new FormData(form), m);
          m.close();
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
    fields,
    err,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', type: 'submit' }, submitLabel)),
  );
  const m = modal(title, form);
  return m;
}

const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);

// ============================================================
// 認証画面
// ============================================================

function renderAuth(tab = 'login', notice = null) {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  const app = document.getElementById('app');
  const err = h('div', { class: 'error' });

  const loginForm = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const fd = new FormData(e.target);
        try {
          const { user } = await api('POST', '/api/auth/login', { email: fd.get('email'), password: fd.get('password') });
          state.me = user;
          await startMain();
        } catch (ex) {
          err.textContent = ex.message;
          if (ex.code === 'EMAIL_NOT_VERIFIED') err.append(' ', resendLink(fd.get('email')));
        }
      },
    },
    field('メールアドレス', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
    field('パスワード', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'ログイン'),
  );

  const registerForm = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const fd = new FormData(e.target);
        try {
          const res = await api('POST', '/api/auth/register', {
            email: fd.get('email'),
            password: fd.get('password'),
            displayName: fd.get('displayName'),
          });
          renderAuth('login', verifyNotice(res, fd.get('email')));
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    field('表示名(チャットに表示されます)', h('input', { type: 'text', name: 'displayName', required: true, maxlength: 40 })),
    field('メールアドレス', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
    field(
      'パスワード(8文字以上)',
      h('input', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
    ),
    h('button', { class: 'btn primary', type: 'submit' }, 'アカウント作成'),
  );

  const tabs = h(
    'div',
    { class: 'tabs' },
    h('button', { class: tab === 'login' ? 'active' : '', onclick: () => renderAuth('login') }, 'ログイン'),
    h('button', { class: tab === 'register' ? 'active' : '', onclick: () => renderAuth('register') }, '新規登録'),
  );

  app.replaceChildren(
    h(
      'div',
      { class: 'auth-wrap' },
      h(
        'div',
        { class: 'auth-card' },
        h('h1', {}, '🎪 学祭グループチャット'),
        h('div', { class: 'muted' }, '出店メンバーの連絡をひとまとめに'),
        tabs,
        inviteNotice(),
        notice,
        tab === 'login' ? loginForm : registerForm,
        err,
      ),
    ),
  );
}

function verifyNotice(res, email) {
  return h(
    'div',
    { class: 'notice' },
    `${email} に確認メールを送信しました。メール内のリンクを開いて認証を完了してから、ログインしてください。`,
    res.devVerifyUrl ? h('div', { style: { marginTop: '8px' } }, '(開発用)', h('a', { href: res.devVerifyUrl }, '今すぐ認証する')) : null,
  );
}

function resendLink(email) {
  return h(
    'a',
    {
      href: '#',
      onclick: guard(async (e) => {
        e.preventDefault();
        const res = await api('POST', '/api/auth/resend', { email });
        renderAuth('login', verifyNotice(res, email));
      }),
    },
    '確認メールを再送',
  );
}

// ============================================================
// メイン画面
// ============================================================

// ---------- 招待リンク(/?invite=コード) ----------

function storage(fn) {
  try {
    return fn(localStorage);
  } catch {
    return null; // プライベートブラウズなどで使えない場合
  }
}
const pendingInvite = {
  get: () => storage((s) => s.getItem('pendingInvite')),
  set: (code) => storage((s) => s.setItem('pendingInvite', code)),
  clear: () => storage((s) => s.removeItem('pendingInvite')),
};

/** 招待リンクから来た場合、ログイン後にそのグループへ参加する。参加したグループの ID を返す */
async function acceptPendingInvite() {
  const code = pendingInvite.get();
  if (!code) return null;
  try {
    const res = await api('POST', '/api/groups/join', { inviteCode: code });
    pendingInvite.clear();
    toast(res.alreadyMember ? '参加済みのグループを開きました' : 'グループに参加しました');
    return res.id;
  } catch (err) {
    if (err.status === 404) pendingInvite.clear();
    toast(err.status === 404 ? '招待リンクが無効です。最新のリンクを代表者に確認してください' : err.message, 'error');
    return null;
  }
}

function inviteNotice() {
  if (!pendingInvite.get()) return null;
  return h('div', { class: 'notice' }, '🎟 グループへの招待を受け取りました。ログイン(初めての人は新規登録)すると自動で参加します。');
}

async function startMain(navTarget = null) {
  connectSocket();
  syncPush();
  const invitedGroup = await acceptPendingInvite();
  await loadGroups();
  if (invitedGroup) return selectGroup(invitedGroup);
  if (navTarget && state.groups.some((g) => g.id === navTarget.groupId)) return selectGroup(navTarget.groupId, navTarget.view);
  const saved = Number(localStorage.getItem('groupId'));
  const gid = state.groups.find((g) => g.id === saved)?.id ?? state.groups[0]?.id;
  if (gid) await selectGroup(gid);
  else render();
}

async function loadGroups() {
  state.groups = (await api('GET', '/api/groups')).groups;
}

async function selectGroup(gid, view = null) {
  state.group = await api('GET', `/api/groups/${gid}`);
  localStorage.setItem('groupId', gid);
  state.unreadChannels.clear();
  state.annBannerOpen = false;
  await Promise.all([loadChannels(), loadAnnouncements()]);
  const first = state.channels[0];
  if (view?.type === 'channel' && !state.channels.some((c) => c.id === view.id)) view = null;
  state.view = view ?? (first ? { type: 'channel', id: first.id } : { type: 'announcements' });
  await openView(state.view);
}

async function reloadGroup() {
  if (!state.group) return;
  state.group = await api('GET', `/api/groups/${state.group.group.id}`);
  await loadChannels();
}

async function loadChannels() {
  state.channels = (await api('GET', `/api/groups/${state.group.group.id}/channels`)).channels;
}

async function loadAnnouncements() {
  const res = await api('GET', `/api/groups/${state.group.group.id}/announcements`);
  state.announcements = res.announcements;
  state.memberCount = res.memberCount;
}

function currentChannel() {
  return state.view?.type === 'channel' ? state.channels.find((c) => c.id === state.view.id) : null;
}

async function openView(view) {
  state.view = view;
  state.sidebarOpen = false;
  pendingFiles = [];
  if (view.type === 'channel') {
    state.unreadChannels.delete(view.id);
    const res = await api('GET', `/api/channels/${view.id}/messages?limit=50`);
    state.messages = res.messages;
    state.hasMore = res.hasMore;
  } else {
    await loadAnnouncements();
  }
  render();
  scrollToBottom();
  sendPresence();
}

function scrollToBottom() {
  const box = document.querySelector('.messages');
  if (box) box.scrollTop = box.scrollHeight;
}

function render() {
  const app = document.getElementById('app');
  app.replaceChildren(h('div', { class: 'layout' }, renderSidebar(), renderMain()));
}

function renderSidebar() {
  const g = state.group;
  const unreadAnn = state.announcements.filter((a) => !a.readByMe).length;
  const head = h(
    'div',
    { class: 'sidebar-head' },
    state.groups.length
      ? h(
          'select',
          { onchange: guard((e) => selectGroup(Number(e.target.value))), 'aria-label': 'グループ' },
          state.groups.map((gr) => h('option', { value: gr.id, selected: g && gr.id === g.group.id }, gr.name)),
        )
      : h('div', {}, 'グループ未参加'),
    g
      ? h(
          'div',
          { class: 'my-level', title: LEVEL_HELP[g.me.level] },
          'あなたの権限: ',
          g.me.isOwner ? '👑 オーナー' : `${LEVEL_ICON[g.me.level]} ${LEVEL_LABEL[g.me.level]}`,
        )
      : null,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn', onclick: createGroupModal }, '＋ 作成'),
      h('button', { class: 'btn', onclick: joinGroupModal }, '招待コードで参加'),
    ),
  );

  const body = h('div', { class: 'sidebar-body' });
  if (g) {
    body.append(
      ...[
        h(
          'div',
          {
            class: `nav-item ${state.view?.type === 'announcements' ? 'active' : ''} ${unreadAnn ? 'unread' : ''}`,
            onclick: guard(() => openView({ type: 'announcements' })),
          },
          h('span', {}, '📢'),
          h('span', { class: 'name' }, 'アナウンス'),
          unreadAnn ? h('span', { class: 'badge' }, unreadAnn) : null,
        ),
        h(
          'div',
          { class: 'section-title' },
          h('span', {}, 'チャット'),
          g.me.canCreateChannels ? h('button', { title: 'チャットを作成', onclick: () => channelModal() }, '＋') : null,
        ),
        state.channels.map((c) =>
          h(
            'div',
            {
              class: `nav-item ${state.view?.type === 'channel' && state.view.id === c.id ? 'active' : ''} ${state.unreadChannels.has(c.id) ? 'unread' : ''}`,
              onclick: guard(() => openView({ type: 'channel', id: c.id })),
            },
            h('span', {}, c.restricted ? '🔒' : '#'),
            h('span', { class: 'name' }, c.name),
            c.myPermission === 'read' ? h('span', { class: 'tag', title: '閲覧のみ' }, '👁') : null,
            state.unreadChannels.has(c.id) ? h('span', { class: 'dot' }) : null,
          ),
        ),
        h('div', { class: 'section-title' }, h('span', {}, 'グループ')),
        h(
          'div',
          { class: `nav-item ${state.pushStatus && state.pushStatus !== 'on' ? 'push-off' : ''}`, onclick: guard(notificationModal) },
          h('span', {}, state.pushStatus === 'on' ? '🔔' : '🔕'),
          h('span', { class: 'name' }, state.pushStatus === 'on' || !state.pushStatus ? '通知設定' : '通知をオンにする'),
        ),
        h(
          'div',
          { class: 'nav-item', onclick: () => groupSettingsModal() },
          h('span', {}, isAdmin() ? '⚙️' : '👥'),
          h('span', { class: 'name' }, isAdmin() ? 'グループ設定・ロール' : 'メンバー一覧'),
        ),
      ].flat(),
    );
  }

  const foot = h(
    'div',
    { class: 'sidebar-foot' },
    h('span', { class: 'me', title: state.me.email }, `👤 ${state.me.displayName}`),
    h('button', { class: 'btn small', onclick: profileModal }, '編集'),
    h(
      'button',
      {
        class: 'btn small',
        onclick: guard(async () => {
          // ログアウト後はこの端末に通知を送らない(次にログインしたときに自動で登録し直す)
          await disablePush({ keepPreference: true });
          await api('POST', '/api/auth/logout');
          state.me = null;
          state.group = null;
          renderAuth();
        }),
      },
      'ログアウト',
    ),
  );

  return h('aside', { class: `sidebar ${state.sidebarOpen ? 'open' : ''}` }, head, body, foot);
}

function menuButton() {
  return h(
    'button',
    {
      class: 'btn icon menu-btn',
      'aria-label': 'メニュー',
      onclick: () => {
        state.sidebarOpen = true;
        document.querySelector('.sidebar').classList.add('open');
      },
    },
    '☰',
  );
}

function renderMain() {
  if (!state.group) {
    return h(
      'main',
      { class: 'main' },
      h('div', { class: 'main-head' }, menuButton(), h('h2', {}, 'ようこそ')),
      h(
        'div',
        { class: 'empty' },
        h(
          'div',
          {},
          h('p', {}, 'まだグループに参加していません。'),
          h('p', {}, '出店チームのグループを作成するか、代表者から共有された招待コードで参加してください。'),
          h(
            'div',
            { class: 'row', style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
            h('button', { class: 'btn primary', onclick: createGroupModal }, 'グループを作成'),
            h('button', { class: 'btn', onclick: joinGroupModal }, '招待コードで参加'),
          ),
        ),
      ),
    );
  }
  return state.view?.type === 'channel' ? renderChannel() : renderAnnouncements();
}

// ---------- チャット ----------

function renderChannel() {
  const ch = currentChannel();
  if (!ch)
    return h(
      'main',
      { class: 'main' },
      h('div', { class: 'main-head' }, menuButton()),
      h('div', { class: 'empty' }, 'チャットを選択してください'),
    );

  const head = h(
    'div',
    { class: 'main-head' },
    menuButton(),
    h('h2', {}, `${ch.restricted ? '🔒' : '#'} ${ch.name}`),
    h('span', { class: 'desc muted' }, ch.description),
    h(
      'button',
      { class: 'btn small', title: '参加者', onclick: () => channelMembersModal(ch) },
      '👥',
      h('span', { class: 'label' }, ch.canManage ? ' 参加者・権限' : ' 参加者'),
    ),
    ch.canManage
      ? h(
          'button',
          { class: 'btn small', title: 'チャットを編集', onclick: () => channelModal(ch) },
          '✏️',
          h('span', { class: 'label' }, ' 編集'),
        )
      : null,
  );

  const list = h('div', { class: 'messages' });
  if (state.hasMore) {
    list.append(
      h('div', { class: 'load-more' }, h('button', { class: 'btn small', onclick: guard(loadOlder) }, '過去のメッセージを読み込む')),
    );
  }
  if (state.messages.length === 0) list.append(h('div', { class: 'empty' }, 'まだメッセージはありません'));
  let lastDay = '';
  for (const m of state.messages) {
    const day = fmtDate(m.createdAt);
    if (day !== lastDay) {
      list.append(h('div', { class: 'day-sep' }, day));
      lastDay = day;
    }
    list.append(renderMessage(m));
  }

  return h('main', { class: 'main' }, head, renderAnnBanner(), list, renderComposer(ch));
}

/** チャット画面の上部に常に表示するアナウンス(未読があれば最新の未読、なければ最新のもの) */
function renderAnnBanner() {
  const a = state.announcements.find((x) => !x.readByMe) ?? state.announcements[0];
  if (!a) return h('div', { class: 'ann-banner', hidden: true });
  const open = state.annBannerOpen;
  const otherUnread = state.announcements.filter((x) => !x.readByMe && x !== a).length;
  const toggle = () => {
    state.annBannerOpen = !state.annBannerOpen;
    rerenderAnnBanner();
  };
  return h(
    'div',
    { class: `ann-banner ${a.readByMe ? '' : 'unread'} ${open ? 'open' : ''}` },
    h(
      'button',
      { class: 'ann-banner-head', type: 'button', onclick: toggle, 'aria-expanded': String(open) },
      h('span', { class: 'ann-banner-icon' }, '📢'),
      h('span', { class: 'ann-banner-text' }, h('strong', {}, a.title), a.body ? h('span', { class: 'ann-banner-body' }, a.body) : null),
      h('span', { class: 'ann-banner-caret' }, open ? '▲' : '▼'),
    ),
    open
      ? h(
          'div',
          { class: 'ann-banner-detail' },
          renderImages(a.attachments),
          h(
            'div',
            { class: 'ann-banner-foot' },
            h('span', { class: 'muted' }, `${a.author?.displayName ?? '退会したユーザー'} ・ ${fmtDateTime(a.createdAt)}`),
            a.readByMe
              ? h('span', { class: 'muted' }, '✓ 確認済み')
              : h('button', { class: 'btn small primary', onclick: guard(() => markRead(a)) }, '確認しました'),
            h('button', { class: 'link-btn', onclick: guard(() => openView({ type: 'announcements' })) }, 'アナウンス一覧へ'),
          ),
        )
      : null,
    otherUnread && !open ? h('div', { class: 'ann-banner-more' }, `ほかに未読のアナウンスが ${otherUnread} 件あります`) : null,
  );
}

function rerenderAnnBanner() {
  const old = document.querySelector('.ann-banner');
  if (old) old.replaceWith(renderAnnBanner());
}

function renderMessage(m) {
  const name = m.author?.displayName ?? '退会したユーザー';
  const canDelete = m.author?.id === state.me.id || !!currentChannel()?.canManage;
  return h(
    'div',
    { class: 'msg', 'data-id': m.id },
    h('div', { class: 'avatar', style: { background: colorFor(m.author?.id ?? 0) } }, name.slice(0, 1)),
    h(
      'div',
      { class: 'content' },
      h(
        'div',
        { class: 'meta' },
        h('span', { class: 'author' }, name),
        h('span', { class: 'muted' }, fmtTime(m.createdAt)),
        canDelete
          ? h('span', { class: 'actions' }, h('button', { class: 'link-btn', onclick: guard(() => deleteMessage(m)) }, '削除'))
          : null,
      ),
      m.body ? h('div', { class: 'body' }, m.body) : null,
      renderImages(m.attachments),
    ),
  );
}

function renderImages(attachments) {
  if (!attachments?.length) return null;
  return h(
    'div',
    { class: 'images' },
    attachments.map((a, i) =>
      h('img', { src: a.url, alt: a.name, title: a.name, loading: 'lazy', onclick: () => openLightbox(attachments, i) }),
    ),
  );
}

async function deleteMessage(m) {
  if (!confirm('このメッセージを削除しますか?')) return;
  await api('DELETE', `/api/messages/${m.id}`);
}

async function loadOlder() {
  const ch = currentChannel();
  const box = document.querySelector('.messages');
  const prevHeight = box.scrollHeight;
  const res = await api('GET', `/api/channels/${ch.id}/messages?limit=50&before=${state.messages[0].id}`);
  state.messages = [...res.messages, ...state.messages];
  state.hasMore = res.hasMore;
  render();
  const nbox = document.querySelector('.messages');
  nbox.scrollTop = nbox.scrollHeight - prevHeight;
}

const MAX_IMAGES = 5;
const MAX_IMAGE_EDGE = 1600;
const isTouch = matchMedia('(pointer: coarse)').matches;

/**
 * モバイル回線での通信量を抑えるため、大きな写真は送信前に縮小・JPEG 圧縮する。
 * GIF(アニメーションが消えるため)と十分小さい画像はそのまま送る。
 */
async function compressImage(file) {
  if (file.type === 'image/gif') return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // 読み込めない場合はサーバー側の検証に任せる
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 500 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 透過 PNG の背景を白にする
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

/** 画像選択・プレビュー付きの入力欄 */
function imagePicker(onChange) {
  const previews = h('div', { class: 'previews' });
  const input = h('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/gif,image/webp',
    multiple: true,
    class: 'hidden',
    onchange: () => {
      const files = [...input.files];
      input.value = '';
      addFiles(files);
    },
  });
  const addFiles = guard(async (files) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    const room = MAX_IMAGES - pendingFiles.length;
    if (imgs.length > room) toast(`画像は一度に${MAX_IMAGES}枚まで添付できます`, 'error');
    const compressed = await Promise.all(imgs.slice(0, Math.max(room, 0)).map(compressImage));
    pendingFiles.push(...compressed.slice(0, MAX_IMAGES - pendingFiles.length));
    draw();
  });
  function draw() {
    previews.replaceChildren(
      ...pendingFiles.map((f, i) => {
        const url = URL.createObjectURL(f);
        return h(
          'div',
          { class: 'preview' },
          h('img', { src: url, alt: f.name, onload: () => URL.revokeObjectURL(url) }),
          h(
            'button',
            {
              type: 'button',
              'aria-label': '削除',
              onclick: () => {
                pendingFiles.splice(i, 1);
                draw();
              },
            },
            '✕',
          ),
        );
      }),
    );
    onChange?.();
  }
  const button = h('button', { type: 'button', class: 'btn icon', title: '画像を添付', onclick: () => input.click() }, '🖼️');
  return { previews, input, button, draw, addFiles };
}

function renderComposer(ch) {
  if (ch.myPermission !== 'write') {
    return h('div', { class: 'composer' }, h('div', { class: 'readonly' }, '👁 このチャットは閲覧のみです'));
  }
  const textarea = h('textarea', {
    name: 'body',
    rows: 1,
    // スマホでは改行キーで誤送信しないよう、送信ボタンでのみ送信する
    placeholder: isTouch ? `#${ch.name} にメッセージ` : `#${ch.name} にメッセージを送信(Enter で送信 / Shift+Enter で改行)`,
    onkeydown: (e) => {
      if (!isTouch && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    },
    onpaste: (e) => {
      const files = [...e.clipboardData.files];
      if (files.some((f) => f.type.startsWith('image/'))) picker.addFiles(files);
    },
  });
  const picker = imagePicker();
  const send = h('button', { class: 'btn primary', type: 'submit' }, '送信');
  const form = h(
    'form',
    {
      onsubmit: guard(async (e) => {
        e.preventDefault();
        if (!textarea.value.trim() && pendingFiles.length === 0) return;
        send.disabled = true;
        try {
          const fd = new FormData();
          fd.append('body', textarea.value);
          for (const f of pendingFiles) fd.append('images', f, f.name);
          await api('POST', `/api/channels/${ch.id}/messages`, fd);
          textarea.value = '';
          pendingFiles = [];
          picker.draw();
        } finally {
          send.disabled = false;
          if (!isTouch) textarea.focus();
        }
      }),
    },
    picker.input,
    picker.button,
    textarea,
    send,
  );
  // ドラッグ&ドロップでも画像を添付できる
  const wrap = h(
    'div',
    {
      class: 'composer',
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => {
        e.preventDefault();
        picker.addFiles([...e.dataTransfer.files]);
      },
    },
    picker.previews,
    form,
  );
  picker.draw();
  return wrap;
}

// ---------- アナウンス ----------

function renderAnnouncements() {
  const head = h(
    'div',
    { class: 'main-head' },
    menuButton(),
    h('h2', {}, '📢 アナウンス'),
    h('span', { class: 'desc muted' }, 'グループ全員への連絡事項'),
    state.announcements.some((a) => !a.readByMe)
      ? h('button', { class: 'btn small', onclick: guard(markAllRead) }, 'すべて既読にする')
      : null,
  );
  const list = h('div', { class: 'ann-list' });
  if (state.group.me.canAnnounce) list.append(renderAnnouncementForm());
  if (state.announcements.length === 0) list.append(h('div', { class: 'empty' }, 'アナウンスはまだありません'));
  for (const a of state.announcements) list.append(renderAnnouncement(a));
  return h('main', { class: 'main' }, head, list);
}

function renderAnnouncement(a) {
  const canManage = a.author?.id === state.me.id || isAdmin();
  return h(
    'div',
    { class: `ann ${a.readByMe ? '' : 'unread'}` },
    h('h3', {}, a.title),
    h('div', { class: 'muted' }, `${a.author?.displayName ?? '退会したユーザー'} ・ ${fmtDateTime(a.createdAt)}`),
    a.body ? h('div', { class: 'body' }, a.body) : null,
    renderImages(a.attachments),
    h(
      'div',
      { class: 'foot', style: { marginTop: '8px' } },
      a.readByMe
        ? h('span', { class: 'muted' }, '✓ 確認済み')
        : h('button', { class: 'btn small primary', onclick: guard(() => markRead(a)) }, '確認しました'),
      canManage
        ? h(
            'button',
            { class: 'link-btn', style: { color: 'var(--muted)' }, onclick: guard(() => readsModal(a)) },
            `既読 ${a.readCount}/${state.memberCount}`,
          )
        : h('span', { class: 'muted' }, `既読 ${a.readCount}/${state.memberCount}`),
      canManage ? h('button', { class: 'link-btn', onclick: guard(() => deleteAnnouncement(a)) }, '削除') : null,
    ),
  );
}

function renderAnnouncementForm() {
  const picker = imagePicker();
  const err = h('div', { class: 'error' });
  const form = h(
    'form',
    {
      class: 'ann-form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const fd = new FormData(form);
        fd.delete('images');
        for (const f of pendingFiles) fd.append('images', f, f.name);
        try {
          await api('POST', `/api/groups/${state.group.group.id}/announcements`, fd);
          pendingFiles = [];
          form.reset();
          picker.draw();
          toast('アナウンスを送信しました');
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h('strong', {}, '新しいアナウンス'),
    field(
      'タイトル',
      h('input', { type: 'text', name: 'title', required: true, maxlength: 100, placeholder: '例: 明日の集合時間について' }),
    ),
    field('本文', h('textarea', { name: 'body', rows: 3, maxlength: 4000 })),
    picker.previews,
    err,
    h(
      'div',
      { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
      picker.input,
      picker.button,
      h('button', { class: 'btn primary', type: 'submit' }, '全員に送信'),
    ),
  );
  picker.draw();
  return form;
}

async function markRead(a) {
  const res = await api('POST', `/api/announcements/${a.id}/read`);
  a.readByMe = true;
  a.readCount = res.readCount;
  refreshView();
}

async function markAllRead() {
  for (const a of state.announcements.filter((x) => !x.readByMe)) {
    const res = await api('POST', `/api/announcements/${a.id}/read`);
    a.readByMe = true;
    a.readCount = res.readCount;
  }
  refreshView();
}

async function deleteAnnouncement(a) {
  if (!confirm(`アナウンス「${a.title}」を削除しますか?`)) return;
  await api('DELETE', `/api/announcements/${a.id}`);
}

async function readsModal(a) {
  const { reads } = await api('GET', `/api/announcements/${a.id}/reads`);
  modal(
    `既読状況: ${a.title}`,
    h(
      'table',
      { class: 'list' },
      h('tr', {}, h('th', {}, 'メンバー'), h('th', {}, '状態')),
      reads.map((r) =>
        h(
          'tr',
          {},
          h('td', {}, r.displayName),
          h('td', {}, r.readAt ? `✓ ${fmtDateTime(r.readAt)}` : h('span', { style: { color: 'var(--danger)' } }, '未読')),
        ),
      ),
    ),
  );
}

// ============================================================
// モーダル: グループ
// ============================================================

function createGroupModal() {
  formModal(
    '出店グループを作成',
    [
      field('グループ名', h('input', { type: 'text', name: 'name', required: true, maxlength: 60, placeholder: '例: 3年B組 焼きそば屋' })),
      field('説明(任意)', h('textarea', { name: 'description', rows: 2, maxlength: 500 })),
      h('p', { class: 'muted' }, '作成者がオーナー(管理者)になります。「全体チャット」が自動で作成されます。'),
    ],
    '作成',
    async (fd) => {
      const { id } = await api('POST', '/api/groups', { name: fd.get('name'), description: fd.get('description') });
      await loadGroups();
      await selectGroup(id);
    },
  );
}

function joinGroupModal() {
  formModal(
    '招待コードで参加',
    [field('招待コード', h('input', { type: 'text', name: 'code', required: true, maxlength: 32, style: { textTransform: 'uppercase' } }))],
    '参加',
    async (fd) => {
      const { id } = await api('POST', '/api/groups/join', { inviteCode: fd.get('code') });
      await loadGroups();
      await selectGroup(id);
      toast('グループに参加しました');
    },
  );
}

function profileModal() {
  formModal(
    'プロフィール',
    [field('表示名', h('input', { type: 'text', name: 'displayName', required: true, maxlength: 40, value: state.me.displayName }))],
    '保存',
    async (fd) => {
      const { user } = await api('PATCH', '/api/auth/me', { displayName: fd.get('displayName') });
      state.me = user;
      if (state.group) await reloadGroup();
      render();
    },
  );
}

function groupSettingsModal(tab = 'members') {
  const g = state.group;
  const tabs = isAdmin()
    ? [
        ['members', 'メンバー'],
        ['roles', 'ロール'],
        ['info', '招待・設定'],
      ]
    : [
        ['members', 'メンバー'],
        ['info', 'グループ情報'],
      ];
  const content = h('div');
  const m = modal(
    g.group.name,
    [
      h(
        'div',
        { class: 'tabs' },
        tabs.map(([k, label]) =>
          h(
            'button',
            {
              class: k === tab ? 'active' : '',
              onclick: () => {
                m.close();
                groupSettingsModal(k);
              },
            },
            label,
          ),
        ),
      ),
      content,
    ],
    { wide: true },
  );

  const refresh = async () => {
    await reloadGroup();
    render();
    m.close();
    groupSettingsModal(tab);
  };

  if (tab === 'members') content.append(membersTab(g, refresh));
  if (tab === 'roles') content.append(rolesTab(g, refresh));
  if (tab === 'info') content.append(infoTab(g, m, refresh));
}

function membersTab(g, refresh) {
  const me = g.me;
  return h(
    'table',
    { class: 'list' },
    h('tr', {}, h('th', {}, '名前'), h('th', {}, isAdmin() ? 'ロール(クリックで付与/解除)' : 'ロール'), h('th', {}, '')),
    g.members.map((mem) => {
      const roles = isAdmin()
        ? h(
            'div',
            { class: 'chips' },
            g.roles.length === 0 ? h('span', { class: 'muted' }, 'ロールがありません(「ロール管理」で作成)') : null,
            g.roles.map((r) => {
              const on = mem.roleIds.includes(r.id);
              // 管理者ロールの付与・解除はオーナーのみ
              const locked = r.level === 'admin' && !me.isOwner;
              return h(
                'span',
                {
                  class: `chip toggle ${on ? 'on' : ''} ${locked ? 'locked' : ''}`,
                  style: on ? { background: r.color } : null,
                  title: locked ? '管理者ロールの付与・解除はオーナーのみ行えます' : LEVEL_HELP[r.level],
                  onclick: guard(async () => {
                    if (locked) return toast('管理者ロールの付与・解除はオーナーのみ行えます', 'error');
                    const roleIds = on ? mem.roleIds.filter((x) => x !== r.id) : [...mem.roleIds, r.id];
                    await api('PATCH', `/api/groups/${g.group.id}/members/${mem.id}`, { roleIds });
                    await refresh();
                  }),
                },
                on ? '✓ ' : '',
                r.name,
              );
            }),
          )
        : h('div', { class: 'chips' }, mem.roleIds.map(roleById).filter(Boolean).map(roleChip));
      const actions = [];
      if (isAdmin() && !mem.isOwner && mem.id !== state.me.id && (!mem.isAdmin || me.isOwner)) {
        actions.push(
          h(
            'button',
            {
              class: 'btn small danger',
              onclick: guard(async () => {
                if (!confirm(`${mem.displayName} さんをグループから外しますか?`)) return;
                await api('DELETE', `/api/groups/${g.group.id}/members/${mem.id}`);
                await refresh();
              }),
            },
            '外す',
          ),
        );
      }
      return h(
        'tr',
        {},
        h(
          'td',
          {},
          h('div', {}, mem.displayName, mem.id === state.me.id ? '(自分)' : ''),
          h(
            'div',
            { class: 'muted', title: LEVEL_HELP[mem.level] },
            mem.isOwner ? '👑 オーナー' : `${LEVEL_ICON[mem.level]} ${LEVEL_LABEL[mem.level]}`,
          ),
        ),
        h('td', {}, roles),
        h('td', {}, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' } }, actions)),
      );
    }),
  );
}

function rolesTab(g, refresh) {
  // 管理者権限の付与・取り消しはオーナーのみ
  const ownerOnly = !g.me.isOwner;

  /** ロール 1 件分の編集カード(r = null なら新規追加用) */
  const card = (r) => {
    const name = h('input', { type: 'text', value: r?.name ?? '', maxlength: 30, placeholder: '例: 調理班', 'aria-label': 'ロール名' });
    let color = r?.color ?? ROLE_COLORS[5];
    const dot = h('span', { class: 'role-dot', style: { background: color } });
    const swatches = h(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-label': '色' },
      ROLE_COLORS.map((c) =>
        h('button', {
          type: 'button',
          class: `swatch ${c === color ? 'on' : ''}`,
          style: { background: c },
          'aria-label': c,
          onclick: (e) => {
            color = c;
            dot.style.background = c;
            swatches.querySelectorAll('.swatch').forEach((el) => el.classList.toggle('on', el === e.currentTarget));
          },
        }),
      ),
    );
    const current = r?.level ?? 'write';
    const help = h('div', { class: 'muted level-desc' }, LEVEL_HELP[current]);
    const level = h(
      'select',
      { disabled: ownerOnly && current === 'admin', 'aria-label': '権限' },
      Object.entries(LEVEL_LABEL).map(([v, label]) =>
        h(
          'option',
          { value: v, selected: current === v, disabled: ownerOnly && v === 'admin' && current !== 'admin' },
          `${LEVEL_ICON[v]} ${label}`,
        ),
      ),
    );
    level.addEventListener('change', () => (help.textContent = LEVEL_HELP[level.value]));
    const save = guard(async () => {
      const body = { name: name.value, color, level: level.value };
      if (r) await api('PATCH', `/api/groups/${g.group.id}/roles/${r.id}`, body);
      else await api('POST', `/api/groups/${g.group.id}/roles`, body);
      await refresh();
    });
    return h(
      'div',
      { class: `role-card ${r ? '' : 'new'}` },
      r ? null : h('strong', {}, '＋ 新しいロールを追加'),
      h('div', { class: 'role-row' }, dot, name),
      swatches,
      h('div', { class: 'role-row' }, level),
      help,
      h(
        'div',
        { class: 'role-actions' },
        r
          ? h(
              'button',
              {
                class: 'btn small danger',
                disabled: ownerOnly && r.level === 'admin',
                onclick: guard(async () => {
                  if (!confirm(`ロール「${r.name}」を削除しますか?このロールで閲覧していた制限付きチャットは見えなくなります。`)) return;
                  await api('DELETE', `/api/groups/${g.group.id}/roles/${r.id}`);
                  await refresh();
                }),
              },
              '削除',
            )
          : null,
        h('button', { class: 'btn small primary', onclick: save }, r ? '保存' : '追加'),
      ),
    );
  };

  return h(
    'div',
    {},
    // 追加フォームを先頭に置き、スクロールしなくても使えるようにする
    card(null),
    h(
      'details',
      { class: 'level-help' },
      h('summary', {}, 'ロールの権限について'),
      h(
        'table',
        { class: 'list' },
        Object.keys(LEVEL_LABEL).map((l) => h('tr', {}, h('td', {}, `${LEVEL_ICON[l]} ${LEVEL_LABEL[l]}`), h('td', {}, LEVEL_HELP[l]))),
      ),
      h(
        'p',
        { class: 'muted' },
        'ロールは「メンバー」タブでメンバーに付与できます。複数のロールを持つメンバーには最も強い権限が適用され、ロールが無いメンバーは「閲覧・送信」になります。管理者権限の付与・取り消しはオーナーのみ行えます。',
      ),
    ),
    h('h4', {}, `作成済みのロール(${g.roles.length})`),
    g.roles.length ? h('div', { class: 'role-list' }, g.roles.map(card)) : h('p', { class: 'muted' }, 'まだロールがありません'),
  );
}

function infoTab(g, m, refresh) {
  const box = h('div');
  if (isAdmin()) {
    const err = h('div', { class: 'error' });
    const name = h('input', { type: 'text', value: g.group.name, maxlength: 60 });
    const desc = h('textarea', { rows: 2, maxlength: 500 }, g.group.description);
    box.append(
      field('グループ名', name),
      field('説明', desc),
      err,
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            try {
              await api('PATCH', `/api/groups/${g.group.id}`, { name: name.value, description: desc.value });
              await loadGroups();
              await refresh();
            } catch (ex) {
              err.textContent = ex.message;
            }
          },
        },
        '保存',
      ),
      h('h4', {}, 'メンバーを招待する'),
      h(
        'p',
        { class: 'muted' },
        '招待リンクを LINE などで送るか、QR コードをスマホで読み取ってもらいます。開いてログイン(初めての人は新規登録)すると自動でグループに参加します。',
      ),
      h(
        'div',
        { class: 'invite-box' },
        h('img', { class: 'qr', src: `/api/groups/${g.group.id}/invite-qr.svg?code=${g.group.inviteCode}`, alt: '招待用 QR コード' }),
        h(
          'div',
          { class: 'invite-actions' },
          h('input', {
            type: 'text',
            readonly: true,
            value: g.group.inviteUrl,
            onfocus: (e) => e.target.select(),
            'aria-label': '招待リンク',
          }),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                class: 'btn small primary',
                onclick: guard(async () => {
                  await navigator.clipboard.writeText(inviteMessage(g));
                  toast('招待メッセージをコピーしました');
                }),
              },
              'リンクをコピー',
            ),
            h(
              'a',
              {
                class: 'btn small',
                href: `https://line.me/R/share?text=${encodeURIComponent(inviteMessage(g))}`,
                target: '_blank',
                rel: 'noopener',
              },
              'LINE で送る',
            ),
            navigator.share
              ? h(
                  'button',
                  {
                    class: 'btn small',
                    onclick: () => navigator.share({ title: g.group.name, text: inviteMessage(g) }).catch(() => {}),
                  },
                  'その他で共有',
                )
              : null,
          ),
          h('div', { class: 'muted' }, '招待コード(手入力用): ', h('span', { class: 'code small' }, g.group.inviteCode)),
          h(
            'button',
            {
              class: 'btn small',
              onclick: guard(async () => {
                if (!confirm('招待リンクを再発行しますか?古いリンク・QR コード・招待コードは使えなくなります。')) return;
                await api('POST', `/api/groups/${g.group.id}/invite-code`);
                await refresh();
              }),
            },
            '招待リンクを再発行',
          ),
        ),
      ),
    );
  } else {
    box.append(h('p', {}, g.group.description || h('span', { class: 'muted' }, '説明はありません')));
  }

  box.append(h('h4', { style: { marginTop: '24px' } }, '危険な操作'));
  if (g.me.isOwner) {
    box.append(
      h(
        'button',
        {
          class: 'btn danger',
          onclick: guard(async () => {
            if (
              prompt(
                `グループを削除すると全てのチャット・アナウンスが消えます。削除するにはグループ名「${g.group.name}」を入力してください`,
              ) !== g.group.name
            )
              return;
            await api('DELETE', `/api/groups/${g.group.id}`);
            m.close();
            await afterLeaving();
          }),
        },
        'グループを削除',
      ),
    );
  } else {
    box.append(
      h(
        'button',
        {
          class: 'btn danger',
          onclick: guard(async () => {
            if (!confirm('このグループから退出しますか?')) return;
            await api('DELETE', `/api/groups/${g.group.id}/members/${state.me.id}`);
            m.close();
            await afterLeaving();
          }),
        },
        'グループから退出',
      ),
    );
  }
  return box;
}

function inviteMessage(g) {
  return `「${g.group.name}」のグループチャットに招待されました。\n下のリンクを開いて登録・ログインすると参加できます。\n${g.group.inviteUrl}`;
}

async function afterLeaving() {
  state.group = null;
  localStorage.removeItem('groupId');
  await loadGroups();
  if (state.groups[0]) await selectGroup(state.groups[0].id);
  else render();
}

// ============================================================
// モーダル: チャット作成・編集 / 参加者権限
// ============================================================

function channelModal(ch = null) {
  const g = state.group;
  const roleSel = new Map((ch?.roles ?? []).map((r) => [r.roleId, r.permission]));
  const restricted = h('input', { type: 'checkbox', name: 'restricted', checked: !!ch?.restricted });
  const defaultPerm = h(
    'select',
    { name: 'defaultPermission' },
    h('option', { value: 'write', selected: (ch?.defaultPermission ?? 'write') === 'write' }, '全員が閲覧・送信できる'),
    h('option', { value: 'read', selected: ch?.defaultPermission === 'read' }, '全員閲覧のみ(管理者・個別許可した人だけ送信)'),
  );
  const roleTable = h(
    'table',
    { class: 'list' },
    h('tr', {}, h('th', {}, 'ロール'), h('th', {}, 'このチャットでの権限')),
    g.roles.length === 0
      ? h('tr', {}, h('td', { colspan: 2, class: 'muted' }, '先に「グループ設定 → ロール管理」でロールを作成してください'))
      : null,
    g.roles.map((r) =>
      h(
        'tr',
        {},
        h('td', {}, roleChip(r)),
        h(
          'td',
          {},
          h(
            'select',
            { 'data-role': r.id },
            ['none', 'read', 'write'].map((p) =>
              h('option', { value: p, selected: (roleSel.get(r.id) ?? 'none') === p }, p === 'none' ? 'なし(見えない)' : PERM_LABEL[p]),
            ),
          ),
        ),
      ),
    ),
  );
  const defaultBox = field('参加者の既定の権限', defaultPerm);
  const roleBox = h(
    'div',
    {},
    h(
      'p',
      { class: 'muted' },
      '選択したロールを持つメンバーだけがこのチャットを閲覧できます(管理者と作成者は常に閲覧・送信可)。権限が「閲覧のみ」のメンバーは、送信を許可しても閲覧のみになります。',
    ),
    roleTable,
  );
  const sync = () => {
    defaultBox.classList.toggle('hidden', restricted.checked);
    roleBox.classList.toggle('hidden', !restricted.checked);
  };
  restricted.addEventListener('change', sync);
  sync();

  const m = formModal(
    ch ? 'チャットを編集' : 'チャットを作成',
    [
      field(
        'チャット名',
        h('input', { type: 'text', name: 'name', required: true, maxlength: 40, value: ch?.name ?? '', placeholder: '例: 買い出し班' }),
      ),
      field('説明(任意)', h('input', { type: 'text', name: 'description', maxlength: 200, value: ch?.description ?? '' })),
      h('label', { class: 'check' }, restricted, '🔒 指定したロールのメンバーのみ参加できるチャットにする'),
      defaultBox,
      roleBox,
      ch
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn danger',
              onclick: guard(async () => {
                if (!confirm(`チャット「${ch.name}」と全てのメッセージを削除しますか?`)) return;
                await api('DELETE', `/api/channels/${ch.id}`);
                m.close();
              }),
            },
            'このチャットを削除',
          )
        : null,
    ],
    ch ? '保存' : '作成',
    async (fd) => {
      const roles = [...roleTable.querySelectorAll('select[data-role]')]
        .filter((s) => s.value !== 'none')
        .map((s) => ({ roleId: Number(s.dataset.role), permission: s.value }));
      const body = {
        name: fd.get('name'),
        description: fd.get('description'),
        restricted: restricted.checked,
        defaultPermission: defaultPerm.value,
        roles,
      };
      if (ch) {
        await api('PATCH', `/api/channels/${ch.id}`, body);
        await loadChannels();
        render();
      } else {
        const { channel } = await api('POST', `/api/groups/${g.group.id}/channels`, body);
        await loadChannels();
        await openView({ type: 'channel', id: channel.id });
      }
    },
  );
}

async function channelMembersModal(ch) {
  const { members } = await api('GET', `/api/channels/${ch.id}/members`);
  const admin = !!ch.canManage;
  const m = modal(
    `${ch.name} の参加者${admin ? '・権限' : ''}`,
    [
      admin
        ? h('p', { class: 'muted' }, '個別設定はロールやチャットの既定権限より優先されます。「既定に従う」に戻すと個別設定が解除されます。')
        : null,
      h(
        'table',
        { class: 'list' },
        h('tr', {}, h('th', {}, 'メンバー'), h('th', {}, '現在の権限'), admin ? h('th', {}, '個別設定') : null),
        members.map((mem) =>
          h(
            'tr',
            {},
            h(
              'td',
              {},
              h('div', {}, mem.displayName),
              h('div', { class: 'chips' }, mem.roleIds.map(roleById).filter(Boolean).map(roleChip)),
            ),
            h(
              'td',
              {},
              h('div', {}, mem.permission === 'none' ? '—' : PERM_LABEL[mem.permission]),
              h('div', { class: 'muted' }, SOURCE_LABEL[mem.source] ?? ''),
            ),
            admin
              ? h(
                  'td',
                  {},
                  mem.isAdmin || mem.source === 'creator'
                    ? h('span', { class: 'muted' }, mem.isAdmin ? '管理者は常に閲覧・送信可' : '作成者は常に閲覧・送信可')
                    : h(
                        'select',
                        {
                          onchange: guard(async (e) => {
                            const permission = e.target.value === '' ? null : e.target.value;
                            await api('PUT', `/api/channels/${ch.id}/members/${mem.id}`, { permission });
                            m.close();
                            await channelMembersModal(ch);
                          }),
                        },
                        h('option', { value: '', selected: mem.override === null }, '既定に従う'),
                        ['write', 'read', 'none'].map((p) => h('option', { value: p, selected: mem.override === p }, PERM_LABEL[p])),
                      ),
                )
              : null,
          ),
        ),
      ),
    ],
    { wide: true },
  );
}

// ============================================================
// リアルタイム更新
// ============================================================

function inCurrentGroup(groupId) {
  return state.group && state.group.group.id === groupId;
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io();

  // 電波が弱い場所での切断・再接続を利用者に知らせる
  socket.on('disconnect', (reason) => reason !== 'io client disconnect' && setOffline(true));
  socket.on('connect', () => {
    setOffline(false);
    sendPresence();
  });

  socket.on('message:new', (msg) => {
    const ch = currentChannel();
    if (ch && ch.id === msg.channelId) {
      if (state.messages.some((m) => m.id === msg.id)) return;
      const box = document.querySelector('.messages');
      const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      state.messages.push(msg);
      rerenderMessages();
      if (atBottom || msg.author?.id === state.me.id) scrollToBottom();
    } else if (state.channels.some((c) => c.id === msg.channelId)) {
      state.unreadChannels.add(msg.channelId);
      rerenderSidebar();
    }
  });

  socket.on('message:deleted', ({ id }) => {
    const before = state.messages.length;
    state.messages = state.messages.filter((m) => m.id !== id);
    if (state.messages.length !== before) rerenderMessages();
  });

  socket.on('announcement:new', (a) => {
    if (!inCurrentGroup(a.groupId)) return;
    const mine = a.author?.id === state.me.id;
    state.announcements.unshift({ ...a, readByMe: mine });
    if (!mine) state.annBannerOpen = false;
    refreshView();
  });

  socket.on('announcement:read', ({ id, groupId, readCount }) => {
    if (!inCurrentGroup(groupId)) return;
    const a = state.announcements.find((x) => x.id === id);
    if (a) {
      a.readCount = readCount;
      if (state.view?.type === 'announcements') refreshView();
    }
  });

  socket.on('announcement:deleted', ({ id, groupId }) => {
    if (!inCurrentGroup(groupId)) return;
    state.announcements = state.announcements.filter((a) => a.id !== id);
    refreshView();
  });

  socket.on(
    'channels:changed',
    guard(async ({ groupId }) => {
      if (!inCurrentGroup(groupId)) return;
      await loadChannels();
      await ensureViewAccessible();
    }),
  );

  socket.on(
    'group:changed',
    guard(async ({ groupId }) => {
      if (!inCurrentGroup(groupId) || document.querySelector('.modal-bg')) {
        // モーダル操作中は自身の refresh が再描画するので、一覧だけ更新しておく
        if (inCurrentGroup(groupId)) await reloadGroup();
        return;
      }
      await reloadGroup();
      await ensureViewAccessible();
    }),
  );

  socket.on(
    'group:removed',
    guard(async ({ groupId }) => {
      await loadGroups();
      if (inCurrentGroup(groupId)) {
        toast('グループから外れました');
        await afterLeaving();
      } else {
        rerenderSidebar();
      }
    }),
  );

  // 再接続時は取りこぼしを避けるため再読込
  socket.io.on(
    'reconnect',
    guard(async () => {
      if (state.view) await openView(state.view);
    }),
  );
}

/** 権限変更で現在のチャットが見えなくなった場合は移動する */
async function ensureViewAccessible() {
  if (state.view?.type === 'channel' && !currentChannel()) {
    toast('このチャットを閲覧する権限がなくなりました');
    const first = state.channels[0];
    await openView(first ? { type: 'channel', id: first.id } : { type: 'announcements' });
  } else {
    refreshView();
  }
}

/** 入力中の内容を保ちながら画面を更新する */
function refreshView() {
  if (document.querySelector('.composer textarea, .ann-form input')) {
    rerenderSidebar();
    if (state.view?.type === 'channel') {
      rerenderAnnBanner();
      rerenderMessages();
      rerenderComposerIfPermissionChanged();
    } else {
      rerenderAnnouncementList();
    }
  } else {
    const box = document.querySelector('.messages');
    const scroll = box?.scrollTop;
    render();
    const nbox = document.querySelector('.messages');
    if (nbox && scroll !== undefined) nbox.scrollTop = scroll;
  }
}

function rerenderSidebar() {
  const old = document.querySelector('.sidebar');
  if (old) old.replaceWith(renderSidebar());
}

function rerenderMessages() {
  const old = document.querySelector('.messages');
  if (!old) return render();
  const main = renderChannel();
  old.replaceWith(main.querySelector('.messages'));
}

function rerenderComposerIfPermissionChanged() {
  const ch = currentChannel();
  const old = document.querySelector('.composer');
  if (!ch || !old) return;
  const isWritable = !old.querySelector('.readonly');
  if (isWritable !== (ch.myPermission === 'write')) old.replaceWith(renderComposer(ch));
}

function rerenderAnnouncementList() {
  const list = document.querySelector('.ann-list');
  if (!list) return;
  const form = list.querySelector('.ann-form');
  list.replaceChildren(...(form ? [form] : []));
  if (state.announcements.length === 0) list.append(h('div', { class: 'empty' }, 'アナウンスはまだありません'));
  for (const a of state.announcements) list.append(renderAnnouncement(a));
  rerenderSidebar();
}

// ============================================================
// プッシュ通知
// ============================================================

const device = {
  ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  android: /Android/.test(navigator.userAgent),
  // LINE・Instagram などのアプリ内ブラウザは通知もホーム画面追加もできない
  inApp: /\bLine\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent),
  standalone: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  pushCapable: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
};

const pushPref = {
  get: () => storage((s) => s.getItem('pushEnabled')) === '1',
  set: (on) => storage((s) => (on ? s.setItem('pushEnabled', '1') : s.removeItem('pushEnabled'))),
};

/** この端末の通知の状態: unsupported | needs-install | in-app | denied | on | off */
async function pushStatus() {
  if (device.inApp) return 'in-app';
  if (!device.pushCapable()) return device.ios && !device.standalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) && pushPref.get() ? 'on' : 'off';
}

function urlBase64ToUint8Array(base64) {
  const raw = atob((base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api('GET', '/api/push/key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  }
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  pushPref.set(true);
}

/** ボタン操作から呼ぶこと(iPhone はタップ直後でないと許可ダイアログが出ない) */
async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? '通知がブロックされました。下の手順で許可してください' : '通知が許可されませんでした');
  }
  await subscribePush();
}

/** この端末の通知をオフにする(サーバーから宛先を消す) */
async function disablePush({ keepPreference = false } = {}) {
  if (!device.pushCapable()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  if (!keepPreference) {
    pushPref.set(false);
    await sub?.unsubscribe();
  }
}

/** ログイン時: 以前通知をオンにしていた端末なら宛先を登録し直す(鍵の更新やユーザー切り替えに対応) */
async function syncPush() {
  try {
    if (pushPref.get() && device.pushCapable() && Notification.permission === 'granted') await subscribePush();
  } catch (err) {
    console.warn('通知の再登録に失敗しました', err);
  }
  state.pushStatus = await pushStatus().catch(() => 'unsupported');
  rerenderSidebar();
}

/** 今どの画面を見ているかをサーバーに知らせる(開いているチャットの通知を鳴らさないため) */
function sendPresence() {
  if (!socket?.connected) return;
  socket.emit('presence', {
    groupId: state.group?.group.id ?? null,
    channelId: state.view?.type === 'channel' ? state.view.id : null,
    visible: document.visibilityState === 'visible',
  });
}

/** 通知をタップして開いたときの移動先(?g=グループ&c=チャット / &ann=1) */
function parseNavTarget(search) {
  const p = new URLSearchParams(search);
  const g = Number(p.get('g'));
  if (!g) return null;
  const c = Number(p.get('c'));
  return { groupId: g, view: c ? { type: 'channel', id: c } : p.get('ann') ? { type: 'announcements' } : null };
}

async function navigateTo(target) {
  if (!target || !state.groups.some((g) => g.id === target.groupId)) return;
  if (state.group?.group.id !== target.groupId) return selectGroup(target.groupId, target.view);
  if (target.view) await openView(target.view);
}

const PUSH_HELP = {
  'in-app': () => [
    h('p', {}, 'LINE などのアプリの中で開いているため、通知を受け取れません。'),
    h(
      'ol',
      {},
      h('li', {}, '画面の右上(または右下)の「︙」や共有ボタンをタップ'),
      h('li', {}, device.ios ? '「Safariで開く」を選ぶ' : '「ブラウザで開く」または「Chromeで開く」を選ぶ'),
      h('li', {}, '開いた画面でログインして、もう一度この画面から通知をオンにする'),
    ),
  ],
  'needs-install': () => [
    h('p', {}, 'iPhone で通知を受け取るには、ホーム画面にアプリを追加して、そこから開く必要があります。'),
    h(
      'ol',
      {},
      h('li', {}, 'Safari の下にある共有ボタン(□に↑のアイコン)をタップ'),
      h('li', {}, '「ホーム画面に追加」→ 右上の「追加」をタップ'),
      h('li', {}, 'ホーム画面にできた「学祭チャット」のアイコンから開いてログイン'),
      h('li', {}, 'メニューの「🔔 通知設定」から通知をオンにする'),
    ),
    h('p', { class: 'muted' }, '※ iOS 16.4 以上が必要です(設定 → 一般 → 情報 → iOSバージョン で確認できます)'),
  ],
  unsupported: () => [
    h('p', {}, 'このブラウザは通知に対応していません。'),
    h(
      'p',
      {},
      'Android は Chrome、iPhone は Safari でホーム画面に追加したアプリ、パソコンは Chrome / Edge / Safari / Firefox で開いてください。',
    ),
  ],
  denied: () => [
    h('p', {}, '通知がブロックされています。次の手順で許可してから、この画面を開き直してください。'),
    device.ios
      ? h('ol', {}, h('li', {}, 'iPhone の「設定」→「通知」→「学祭チャット」'), h('li', {}, '「通知を許可」をオンにする'))
      : device.android
        ? h(
            'ol',
            {},
            h('li', {}, 'Chrome のアドレスバーの左にあるアイコンをタップ →「権限」'),
            h('li', {}, '「通知」を「許可」にする'),
            h('li', {}, 'それでも届かない場合: Android の「設定」→「アプリ」→「Chrome」→「通知」をオン'),
          )
        : h(
            'ol',
            {},
            h('li', {}, 'アドレスバーの左にある鍵(またはサイト情報)のアイコンをクリック'),
            h('li', {}, '「通知」を「許可」にする'),
          ),
  ],
};

async function notificationModal() {
  const statusBox = h('div', { class: 'push-status' });
  const { close } = modal('🔔 通知設定', [statusBox, renderMuteList()]);

  async function draw() {
    const status = await pushStatus().catch(() => 'unsupported');
    state.pushStatus = status;
    rerenderSidebar();
    const err = h('div', { class: 'error' });
    const run = (fn) =>
      guard(async (e) => {
        e.target.disabled = true;
        err.textContent = '';
        try {
          await fn();
          await draw();
        } catch (ex) {
          err.textContent = ex.message;
          e.target.disabled = false;
        }
      });
    const title = h('strong', {}, 'この端末の通知');
    if (status === 'on') {
      statusBox.replaceChildren(
        title,
        h('p', { class: 'push-on' }, '✅ オン — アプリを閉じていても新着メッセージとアナウンスが届きます'),
        h(
          'div',
          { class: 'push-actions' },
          h(
            'button',
            {
              class: 'btn small',
              onclick: run(async () => {
                const { delivered } = await api('POST', '/api/push/test');
                toast(
                  delivered ? 'テスト通知を送りました' : 'この端末に届けられませんでした。一度オフにしてからオンにし直してください',
                  delivered ? '' : 'error',
                );
              }),
            },
            'テスト通知を送る',
          ),
          h('button', { class: 'btn small', onclick: run(() => disablePush()) }, 'この端末の通知をオフ'),
        ),
        err,
      );
    } else if (status === 'off') {
      statusBox.replaceChildren(
        title,
        h('p', {}, 'オフになっています。オンにすると、アプリを閉じていても通知が届きます。'),
        h('button', { class: 'btn primary', onclick: run(enablePush) }, '🔔 通知をオンにする'),
        h('p', { class: 'muted' }, '「許可」を求められたら「許可」を選んでください。'),
        err,
      );
    } else {
      statusBox.replaceChildren(title, h('div', { class: 'push-help' }, PUSH_HELP[status]()));
    }
  }
  await draw();
  return close;
}

function renderMuteList() {
  if (!state.group) return null;
  return h(
    'div',
    { class: 'mute-list' },
    h('strong', {}, `チャットごとの通知(${state.group.group.name})`),
    h('p', { class: 'muted' }, 'オフにしたチャットは通知されません(未読の印は付きます)。📢 アナウンスは大事な連絡のため常に通知されます。'),
    state.channels.map((c) => {
      const input = h('input', {
        type: 'checkbox',
        checked: !c.muted,
        onchange: guard(async (e) => {
          const on = e.target.checked;
          try {
            await api('PUT', `/api/channels/${c.id}/mute`, { muted: !on });
            c.muted = !on;
          } catch (ex) {
            e.target.checked = !on;
            throw ex;
          }
        }),
      });
      return h(
        'label',
        { class: 'mute-row' },
        h('span', { class: 'name' }, `${c.restricted ? '🔒' : '#'} ${c.name}`),
        h('span', { class: 'switch' }, input, h('span', { class: 'slider' })),
      );
    }),
  );
}

// ============================================================
// 起動
// ============================================================

function setOffline(offline) {
  let bar = document.getElementById('offline-bar');
  if (!offline) return bar?.remove();
  if (bar) return;
  bar = h('div', { id: 'offline-bar' }, '📡 接続が切れています(自動で再接続します)');
  document.body.append(bar);
}

(async function boot() {
  // ホーム画面に追加して使えるよう Service Worker を登録(HTTPS か localhost のみ)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => {
    if (!socket || socket.connected) setOffline(false);
  });

  const params = new URLSearchParams(location.search);
  const verified = params.get('verified');
  const invite = params.get('invite');
  const navTarget = parseNavTarget(location.search);
  if (invite) pendingInvite.set(invite);
  if (verified !== null || invite || navTarget) history.replaceState(null, '', '/');

  // 通知をタップしたとき(アプリが開いていれば Service Worker から移動先が届く)
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && state.me) guard(() => navigateTo(parseNavTarget(new URL(e.data.url, location.origin).search)))();
  });
  document.addEventListener('visibilitychange', sendPresence);

  // スマホ表示でサイドバー外をタップしたら閉じる
  document.addEventListener('click', (e) => {
    const sb = document.querySelector('.sidebar.open');
    if (sb && !sb.contains(e.target) && !e.target.closest('.menu-btn')) {
      state.sidebarOpen = false;
      sb.classList.remove('open');
    }
  });

  try {
    const { user } = await api('GET', '/api/auth/me');
    state.me = user;
    await startMain(navTarget);
  } catch {
    renderAuth(
      'login',
      verified === '1'
        ? h('div', { class: 'notice' }, '✅ メールアドレスの認証が完了しました。ログインしてください。')
        : verified === '0'
          ? h(
              'div',
              { class: 'notice', style: { background: '#fef2f2', borderColor: '#fecaca' } },
              '認証リンクが無効か期限切れです。ログイン画面から確認メールを再送してください。',
            )
          : null,
    );
  }
})();
