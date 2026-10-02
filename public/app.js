'use strict';

/* ============================================================
 * 学祭グループチャット フロントエンド(ビルド不要の素の JS)
 * ============================================================ */

const PERM_LABEL = { write: '閲覧・送信', read: '閲覧のみ', none: '参加させない' };
const SOURCE_LABEL = { admin: '管理者', override: '個別設定', role: 'ロール', default: 'チャット既定' };
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

function openLightbox(src) {
  const box = h('div', { class: 'lightbox', onclick: () => box.remove() }, h('img', { src, alt: '' }));
  document.body.append(box);
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
  bg.querySelector('input, textarea, select')?.focus();
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

async function startMain() {
  connectSocket();
  await loadGroups();
  const saved = Number(localStorage.getItem('groupId'));
  const gid = state.groups.find((g) => g.id === saved)?.id ?? state.groups[0]?.id;
  if (gid) await selectGroup(gid);
  else render();
}

async function loadGroups() {
  state.groups = (await api('GET', '/api/groups')).groups;
}

async function selectGroup(gid) {
  state.group = await api('GET', `/api/groups/${gid}`);
  localStorage.setItem('groupId', gid);
  state.unreadChannels.clear();
  await Promise.all([loadChannels(), loadAnnouncements()]);
  const first = state.channels[0];
  state.view = first ? { type: 'channel', id: first.id } : { type: 'announcements' };
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
          isAdmin() ? h('button', { title: 'チャットを作成', onclick: () => channelModal() }, '＋') : null,
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
    h('button', { class: 'btn small', onclick: () => channelMembersModal(ch) }, isAdmin() ? '👥 参加者・権限' : '👥 参加者'),
    isAdmin() ? h('button', { class: 'btn small', onclick: () => channelModal(ch) }, '✏️ 編集') : null,
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

  return h('main', { class: 'main' }, head, list, renderComposer(ch));
}

function renderMessage(m) {
  const name = m.author?.displayName ?? '退会したユーザー';
  const canDelete = m.author?.id === state.me.id || isAdmin();
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
    attachments.map((a) => h('img', { src: a.url, alt: a.name, title: a.name, loading: 'lazy', onclick: () => openLightbox(a.url) })),
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

/** 画像選択・プレビュー付きの入力欄 */
function imagePicker(onChange) {
  const previews = h('div', { class: 'previews' });
  const input = h('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/gif,image/webp',
    multiple: true,
    class: 'hidden',
    onchange: () => {
      for (const f of input.files) if (pendingFiles.length < 5) pendingFiles.push(f);
      if (input.files.length + pendingFiles.length > 5) toast('画像は一度に5枚まで添付できます', 'error');
      input.value = '';
      draw();
    },
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
  return { previews, input, button, draw };
}

function renderComposer(ch) {
  if (ch.myPermission !== 'write') {
    return h('div', { class: 'composer' }, h('div', { class: 'readonly' }, '👁 このチャットは閲覧のみです'));
  }
  const textarea = h('textarea', {
    name: 'body',
    rows: 1,
    placeholder: `#${ch.name} にメッセージを送信(Enter で送信 / Shift+Enter で改行)`,
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    },
    onpaste: (e) => {
      const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) {
        pendingFiles.push(...imgs.slice(0, 5 - pendingFiles.length));
        picker.draw();
      }
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
          textarea.focus();
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
        const imgs = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
        pendingFiles.push(...imgs.slice(0, 5 - pendingFiles.length));
        picker.draw();
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
  render();
}

async function markAllRead() {
  for (const a of state.announcements.filter((x) => !x.readByMe)) {
    const res = await api('POST', `/api/announcements/${a.id}/read`);
    a.readByMe = true;
    a.readCount = res.readCount;
  }
  render();
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
        ['members', 'メンバー・ロール付与'],
        ['roles', 'ロール管理'],
        ['info', 'グループ情報・招待'],
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
              return h(
                'span',
                {
                  class: `chip toggle ${on ? 'on' : ''}`,
                  style: on ? { background: r.color } : null,
                  onclick: guard(async () => {
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
      if (me.isOwner && !mem.isOwner) {
        actions.push(
          h(
            'label',
            { class: 'check', style: { margin: 0 } },
            h('input', {
              type: 'checkbox',
              checked: mem.isAdmin,
              onchange: guard(async (e) => {
                await api('PATCH', `/api/groups/${g.group.id}/members/${mem.id}`, { isAdmin: e.target.checked });
                await refresh();
              }),
            }),
            '管理者',
          ),
        );
      }
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
          h('div', { class: 'muted' }, mem.isOwner ? '👑 オーナー' : mem.isAdmin ? '⭐ 管理者' : 'メンバー'),
        ),
        h('td', {}, roles),
        h('td', {}, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' } }, actions)),
      );
    }),
  );
}

function rolesTab(g, refresh) {
  const row = (r) => {
    const name = h('input', { type: 'text', value: r?.name ?? '', maxlength: 30, placeholder: '例: 調理班' });
    const color = h(
      'select',
      {},
      ROLE_COLORS.map((c) => h('option', { value: c, selected: (r?.color ?? ROLE_COLORS[5]) === c, style: { background: c } }, c)),
    );
    const swatch = h('span', { class: 'chip', style: { background: color.value, width: '22px', height: '22px', padding: 0 } });
    color.addEventListener('change', () => (swatch.style.background = color.value));
    const canAnnounce = h('input', { type: 'checkbox', checked: !!r?.canAnnounce });
    const save = guard(async () => {
      const body = { name: name.value, color: color.value, canAnnounce: canAnnounce.checked };
      if (r) await api('PATCH', `/api/groups/${g.group.id}/roles/${r.id}`, body);
      else await api('POST', `/api/groups/${g.group.id}/roles`, body);
      await refresh();
    });
    return h(
      'tr',
      {},
      h('td', {}, name),
      h('td', {}, h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, swatch, color)),
      h('td', {}, h('label', { class: 'check', style: { margin: 0 } }, canAnnounce, 'アナウンス可')),
      h(
        'td',
        { style: { whiteSpace: 'nowrap' } },
        h('button', { class: 'btn small primary', onclick: save }, r ? '保存' : '追加'),
        r
          ? h(
              'button',
              {
                class: 'btn small danger',
                style: { marginLeft: '4px' },
                onclick: guard(async () => {
                  if (!confirm(`ロール「${r.name}」を削除しますか?このロールで閲覧していた制限付きチャットは見えなくなります。`)) return;
                  await api('DELETE', `/api/groups/${g.group.id}/roles/${r.id}`);
                  await refresh();
                }),
              },
              '削除',
            )
          : null,
      ),
    );
  };
  return h(
    'div',
    {},
    h(
      'p',
      { class: 'muted' },
      'ロールは「メンバー・ロール付与」タブでメンバーに付与できます。制限付きチャットではロールごとに閲覧・送信を許可できます。「アナウンス可」のロールを持つメンバーは全体アナウンスを送信できます。',
    ),
    h(
      'table',
      { class: 'list' },
      h('tr', {}, h('th', {}, 'ロール名'), h('th', {}, '色'), h('th', {}, '権限'), h('th', {}, '')),
      g.roles.map(row),
      row(null),
    ),
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
      h('h4', {}, '招待コード'),
      h('p', { class: 'muted' }, 'このコードをメンバーに共有すると、グループに参加できます。'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { class: 'code' }, g.group.inviteCode),
        h(
          'button',
          {
            class: 'btn small',
            onclick: guard(async () => {
              await navigator.clipboard.writeText(g.group.inviteCode);
              toast('コピーしました');
            }),
          },
          'コピー',
        ),
        h(
          'button',
          {
            class: 'btn small',
            onclick: guard(async () => {
              if (!confirm('招待コードを再発行しますか?古いコードは使えなくなります。')) return;
              await api('POST', `/api/groups/${g.group.id}/invite-code`);
              await refresh();
            }),
          },
          '再発行',
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
    h('p', { class: 'muted' }, '選択したロールを持つメンバーだけがこのチャットを閲覧できます(管理者は常に閲覧・送信可)。'),
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
  const admin = isAdmin();
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
                  mem.isAdmin
                    ? h('span', { class: 'muted' }, '管理者は常に閲覧・送信可')
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
    if (!mine) toast(`📢 ${a.title}`);
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
// 起動
// ============================================================

(async function boot() {
  const params = new URLSearchParams(location.search);
  const verified = params.get('verified');
  if (verified !== null) history.replaceState(null, '', '/');

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
    await startMain();
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
