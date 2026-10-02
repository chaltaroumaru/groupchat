'use strict';

const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { createRealtime } = require('../src/realtime');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function startServer() {
  const db = openDatabase(':memory:');
  const mails = [];
  const mailer = { configured: true, send: async (m) => mails.push(m) };
  const rt = createRealtime(db);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const app = createApp({
    db,
    mailer,
    rt,
    config: { baseUrl, secureCookies: false, exposeDevVerifyLink: false },
  });
  server.on('request', app);
  rt.attach(server);

  return {
    baseUrl,
    db,
    mails,
    client: () => new Client(baseUrl),
    /** 登録 → メール認証 → ログイン済みのクライアントを返す */
    async user(name) {
      const c = new Client(baseUrl);
      const email = `${name}@example.com`;
      await c.post('/api/auth/register', { email, password: 'password123', displayName: name }).expect(201);
      const mail = mails.filter((m) => m.to === email).at(-1);
      const url = mail.text.match(/https?:\/\/\S+/)[0];
      await c.get(url.replace(baseUrl, ''), { redirect: 'manual' });
      const me = await c.post('/api/auth/login', { email, password: 'password123' }).expect(200);
      c.id = me.body.user.id;
      return c;
    },
    async close() {
      rt.close();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Cookie を保持する簡易 HTTP クライアント */
class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
  }

  request(method, url, { json, form, redirect } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const promise = fetch(this.baseUrl + url, { method, headers, body, redirect: redirect || 'follow' }).then(async (res) => {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0];
      const type = res.headers.get('content-type') || '';
      const out = { status: res.status, headers: res.headers };
      if (type.includes('application/json')) out.body = await res.json();
      else out.buffer = Buffer.from(await res.arrayBuffer());
      return out;
    });
    // .expect(status) で状態コードを検証できるようにする
    promise.expect = async (status) => {
      const res = await promise;
      if (res.status !== status) {
        throw new Error(`${method} ${url}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res;
    };
    return promise;
  }

  get(url, opts) {
    return this.request('GET', url, opts);
  }
  post(url, json) {
    return this.request('POST', url, { json });
  }
  postForm(url, form) {
    return this.request('POST', url, { form });
  }
  patch(url, json) {
    return this.request('PATCH', url, { json });
  }
  put(url, json) {
    return this.request('PUT', url, { json });
  }
  del(url) {
    return this.request('DELETE', url);
  }
}

module.exports = { startServer, PNG };
