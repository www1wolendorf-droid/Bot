import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const ADMIN = (process.env.ADMIN_CODE || "Admin-01").toLowerCase();
const TOKEN = process.env.BOT_TOKEN || "";
const SECRET = process.env.TG_SECRET || "";
const API_URL = (process.env.API_URL || "https://api.staticgram.top").replace(/\/$/, "");
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";
const PORT = process.env.PORT || 10000;
const WITHDRAW_LIMIT = +process.env.WITHDRAW_DAILY_LIMIT || 35000; // макс. вывод одного игрока за 24 часа, ★
const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const PROMOS = { MURDER: 500, TGSTARS: 250, PLUMB: 1000 };
const UP = [[1.5, 60], [2, 45], [3, 25], [5, 15], [10, 9], [50, 1.6], [100, 0.9]];

if (!process.env.DATABASE_URL) { console.error("Нет переменной DATABASE_URL (строка подключения Neon)"); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
pool.on("error", (e) => console.error("pg pool error", e.message));

const json = (o, s = 200) => ({ s, o });
const err = (m, s = 400) => json({ error: m }, s);
const tg = (m, body) =>
  fetch(`${API_URL}/bot${TOKEN}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    .then((r) => r.json()).catch(() => ({}));
// Проверка подписи initData из Mini App: возвращает аккаунт StaticGram, который открыл игру
function tgUser(init) {
  try {
    const p = new URLSearchParams(String(init || ""));
    const hash = p.get("hash");
    if (!hash || !TOKEN) return null;
    p.delete("hash");
    const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const exp = crypto.createHmac("sha256", secret).update(check).digest("hex");
    if (exp.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
    const u = JSON.parse(p.get("user"));
    return u && u.id ? u : null;
  } catch { return null; }
}

const mnMult = (n, k) => { let m = 0.97; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - n - i); return +m.toFixed(2); };
const crashMult = (t0) => Math.exp((0.12 * (Date.now() - t0)) / 1000);
const nextCP = () => Math.max(1, Math.floor((100 * 0.96) / (1 - Math.random())) / 100);

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (key text PRIMARY KEY, data jsonb NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS payments (id text PRIMARY KEY)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS deposits (nonce text PRIMARY KEY, key text NOT NULL, amount bigint NOT NULL, status text NOT NULL DEFAULT 'pending', created bigint NOT NULL, paid_at bigint)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v text NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tickets (id serial PRIMARY KEY, data jsonb NOT NULL)`);
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

const tkRow = (r) => ({ id: r.id, ...r.data });

// ---------- зачисление пополнения (одно место для вебхука и сверки) ----------
// Каждый счёт имеет свой одноразовый номер (nonce) в payload: "dep2:<nonce>". Зачислить его можно только один раз.
async function creditDeposit(payload, amount, chargeId) {
  amount = Math.floor(+amount);
  if (!(amount > 0)) return null;
  const isNew = payload.startsWith("dep2:");
  const ref = payload.slice(isNew ? 5 : 4);
  return tx(async (c) => {
    let key;
    if (isNew) {
      const d = await c.query("UPDATE deposits SET status='paid', paid_at=$2 WHERE nonce=$1 AND status='pending' RETURNING key", [ref, Date.now()]);
      if (!d.rowCount) return null; // неизвестный номер или уже зачислено
      key = d.rows[0].key;
    } else { // старый формат dep:<username>, защита от повторов по номеру платежа
      if (!chargeId) return null;
      const ins = await c.query("INSERT INTO payments(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id", [chargeId]);
      if (!ins.rowCount) return null;
      key = "u:" + ref.toLowerCase();
    }
    const r = await c.query("SELECT data FROM users WHERE key=$1 FOR UPDATE", [key]);
    if (!r.rowCount) return null;
    const u = r.rows[0].data;
    u.balance = (u.balance || 0) + amount;
    await c.query("UPDATE users SET data=$2 WHERE key=$1", [key, u]);
    return { key, amount };
  });
}

// Сверка с историей платежей бота: подхватывает пополнения, если вебхук опоздал или потерялся
let recBusy = false, recAt = 0;
async function reconcile() {
  if (!TOKEN || recBusy || Date.now() - recAt < 2500) return;
  recBusy = true; recAt = Date.now();
  try {
    const pend = await pool.query("SELECT min(created) AS m FROM deposits WHERE status='pending' AND created > $1", [Date.now() - 6 * 36e5]);
    if (!pend.rows[0].m) return;
    const cutoff = Math.floor(Number(pend.rows[0].m) / 1000) - 600;
    const kv = await pool.query("SELECT v FROM kv WHERE k='tx_offset'");
    const LIM = 100;
    let off = Number(kv.rows[0]?.v || 0), ascending = null;
    for (let page = 0; page < 30; page++) {
      const d = await tg("getStarTransactions", { offset: off, limit: LIM });
      const list = d?.result?.transactions;
      if (!Array.isArray(list)) break;
      if (ascending === null && list.length >= 2) ascending = list[0].date <= list[list.length - 1].date;
      for (const x of list) {
        const p = x?.source?.invoice_payload;
        if (typeof p === "string" && p.startsWith("dep2:") && x.amount > 0) { const r = await creditDeposit(p, x.amount); if (r) console.log("reconcile credited", r.amount); }
      }
      off += list.length;
      if (list.length < LIM) break;
      if (ascending === false && list[list.length - 1].date < cutoff) break; // история идёт от новых к старым
    }
    if (ascending) await pool.query("INSERT INTO kv(k,v) VALUES('tx_offset',$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [String(off)]);
  } catch (e) { console.error("reconcile error", e.message); }
  finally { recBusy = false; }
}

// ---------- вебхук бота: оплата статиками (отвечаем сразу, тяжёлое делаем после ответа) ----------
const answerPre = async (id) => { for (let i = 0; i < 3; i++) { const r = await tg("answerPreCheckoutQuery", { pre_checkout_query_id: id, ok: true }); if (r.ok) return; } console.error("answerPreCheckoutQuery failed", id); };
async function hook(headers, b) {
  if (SECRET && headers["x-telegram-bot-api-secret-token"] !== SECRET) return err("forbidden", 403);
  console.log("webhook", new Date().toISOString(), Object.keys(b).join(","));
  if (b.pre_checkout_query) { answerPre(b.pre_checkout_query.id); return json({ ok: true }); }
  const m = b.message, sp = m?.successful_payment;
  if (sp && sp.currency === "XTR" && String(sp.invoice_payload).startsWith("dep")) {
    const res = await creditDeposit(String(sp.invoice_payload), sp.total_amount, sp.telegram_payment_charge_id);
    if (res) tg("sendMessage", { chat_id: m.chat.id, text: `Зачислено ${res.amount} ★. Вернитесь в игру.` });
  } else if (m?.text?.startsWith("/start")) {
    tg("sendMessage", { chat_id: m.chat.id, text: "Murder Game. Пополнение делается в игре кнопкой «+»." });
  }
  return json({ ok: true });
}

function payoutError(d) {
  const s = String(d?.description || "");
  if (/BALANCE_TOO_LOW/.test(s)) return "В банке игры сейчас не хватает звёзд для выплаты. Попробуйте позже. Баланс возвращён";
  if (/user not found|USER_ID_INVALID/i.test(s)) return "Пользователь с таким юзернеймом не найден в StaticGram. Проверьте @username. Баланс возвращён";
  if (/USER_IS_BOT|USER_FROZEN/.test(s)) return "Этому аккаунту нельзя отправить звёзды. Баланс возвращён";
  if (/STAR_WITHDRAWAL_DISABLED/.test(s)) return "Вывод сейчас отключён. Баланс возвращён";
  if (/Too Many Requests/i.test(s) || d?.error_code === 429) return "Слишком много выводов сразу. Повторите через несколько секунд. Баланс возвращён";
  return "Не удалось отправить звёзды. Баланс возвращён";
}

// мгновенный вывод: withdrawStarBalance отправляет звёзды из банка бота на баланс игрока в StaticGram
async function autoPayout(key, t) {
  const call = () => tg("withdrawStarBalance", { user_id: Number(t.uid), star_count: t.amount, request_id: "w" + t.id });
  let d = await call();
  for (let i = 0; i < 2 && !d.ok && !d.error_code; i++) d = await call(); // нет ответа: повтор с тем же request_id безопасен
  if (d.ok) {
    const bal = await tx(async (c) => {
      await c.query(`UPDATE tickets SET data = jsonb_set(data, '{status}', '"closed"') WHERE id=$1`, [t.id]);
      const r = await c.query("SELECT data->>'balance' AS b FROM users WHERE key=$1", [key]);
      return Number(r.rows[0]?.b || 0);
    });
    return json({ balance: bal, ticket: { ...t, status: "closed" } });
  }
  if (!d.error_code) { // ответа так и не было: не возвращаем баланс вслепую, заявка остаётся на ручную проверку
    console.error("withdrawStarBalance no response, ticket", t.id);
    return err("Выплата обрабатывается. Если звёзды не придут в ближайшее время, обратитесь к администратору", 502);
  }
  console.error("withdrawStarBalance failed, ticket", t.id, JSON.stringify(d));
  await tx(async (c) => {
    const upd = await c.query(`UPDATE tickets SET data = jsonb_set(data, '{status}', '"failed"') WHERE id=$1 AND data->>'status'='processing' RETURNING id`, [t.id]);
    if (!upd.rowCount) return;
    const r = await c.query("SELECT data FROM users WHERE key=$1 FOR UPDATE", [key]);
    const u = r.rows[0].data; u.balance += t.amount;
    await c.query("UPDATE users SET data=$2 WHERE key=$1", [key, u]);
  });
  return err(payoutError(d), 502);
}

async function route(path, b, headers) {
  if (path === "tg") return hook(headers, b);

  // ---------- админ ----------
  if (path === "admin" || path === "admin_close") {
    if (String(b.code || "").toLowerCase() !== ADMIN) return err("Нет доступа", 403);
    if (path === "admin") {
      const q = String(b.q || "").trim().replace(/^@/, "").toLowerCase();
      const r = q
        ? await pool.query("SELECT id, data FROM tickets WHERE position($1 in lower(data->>'user')) > 0 OR position($1 in lower(coalesce(data->>'owner',''))) > 0 ORDER BY id DESC LIMIT 100", [q])
        : await pool.query("SELECT id, data FROM tickets WHERE data->>'status' IN ('open','processing') ORDER BY id DESC LIMIT 100");
      return json({ tickets: r.rows.map(tkRow) });
    }
    const r = await pool.query(`UPDATE tickets SET data = jsonb_set(data, '{status}', '"closed"') WHERE id=$1 RETURNING id`, [Math.floor(+b.id) || 0]);
    if (!r.rowCount) return err("Билет не найден", 404);
    return json({ ok: true });
  }

  // ---------- пользователь ----------
  const dev = String(b.dev || ""), name = String(b.user || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,32}$/.test(name)) return err("Неверный юз");
  if (!/^[a-f0-9]{32}$/.test(dev)) return err("Неверное устройство");
  const key = "u:" + name.toLowerCase();

  const done = await tx(async (c) => {
    const fresh = { name, dev, ts: Date.now(), v: 2, balance: 0, turnover: 0, won: 0, games: 0, promos: [], daily: 0 };
    await c.query("INSERT INTO users(key, data) VALUES($1,$2) ON CONFLICT DO NOTHING", [key, fresh]);
    const r = await c.query("SELECT data FROM users WHERE key=$1 FOR UPDATE", [key]);
    const u = r.rows[0].data;
    if (u.dev !== dev) return err("Этот юз уже занят", 409);

    let dirty = false;
    const save = () => { dirty = true; };
    const out = (x = {}) => json({ balance: u.balance, ...x });
    const spend = (a) => { a = Math.floor(+a); if (!(a >= 10) || a > u.balance) return 0; u.balance -= a; u.turnover += a; u.games++; return a; };
    const pay = (a) => { a = Math.floor(a); u.balance += a; u.won += a; return a; };
    const NOFUNDS = "Недостаточно звёзд (мин. ставка 10 ★)";

    const res = await (async () => {
      if (path === "register" || path === "me") { if (path === "me") reconcile(); return out({ daily: u.daily }); }

      if (path === "top") {
        const f = b.by === "won" ? "won" : "turnover";
        const col = `(data->>'${f}')::numeric`;
        const top = await c.query(`SELECT data FROM users WHERE data->>'v'='2' ORDER BY ${col} DESC, (data->>'ts')::numeric ASC LIMIT 10`);
        const rk = await c.query(`SELECT count(*)::int AS n FROM users WHERE data->>'v'='2' AND (${col} > $1 OR (${col} = $1 AND (data->>'ts')::numeric < $2))`, [u[f], u.ts]);
        return json({ top: top.rows.map((x) => ({ name: x.data.name, v: x.data[f], g: x.data.games })), me: { rank: rk.rows[0].n + 1, v: u[f], g: u.games } });
      }

      if (path === "daily") {
        if (Date.now() - u.daily < 864e5) return err("Приходи завтра!");
        u.daily = Date.now(); u.balance += 100; save();
        return out({ daily: u.daily });
      }
      if (path === "promo") {
        const code = String(b.code || "").trim().toUpperCase();
        if (!PROMOS[code]) return err("Неверный промокод");
        if (u.promos.includes(code)) return err("Этот промокод уже использован");
        u.promos.push(code); u.balance += PROMOS[code]; save();
        return out({ amount: PROMOS[code] });
      }

      if (path === "deposit") {
        const amount = Math.floor(+b.amount);
        if (!(amount >= 15 && amount <= 50000)) return err("Сумма от 15 до 50 000 ★");
        if (!TOKEN) return err("Бот не настроен", 500);
        const nonce = crypto.randomBytes(9).toString("hex");
        await pool.query("INSERT INTO deposits(nonce, key, amount, created) VALUES($1,$2,$3,$4)", [nonce, key, amount, Date.now()]); // сразу, до создания счёта
        const d = await tg("createInvoiceLink", { title: "Пополнение", description: `Пополнение баланса на ${amount} ★`, payload: "dep2:" + nonce, currency: "XTR", prices: [{ label: "Звёзды", amount }] });
        if (!d.ok) { console.error("createInvoiceLink failed", JSON.stringify(d)); return err("Не удалось создать счёт", 502); }
        return json({ link: d.result });
      }

      // ---------- мгновенные игры ----------
      if (path === "play") {
        const g = b.game, o = UP[+b.opt];
        if (!["up", "w2", "coin"].includes(g) || (g === "up" && !o)) return err("Ошибка игры");
        if (g === "coin" && !["Орел", "Решка"].includes(b.side)) return err("Ошибка игры");
        const a = spend(b.bet); if (!a) return err(NOFUNDS);
        let win, payout, x = { r: Math.random() };
        if (g === "up") { win = Math.random() * 100 < o[1]; payout = win ? a * o[0] : 0; }
        else if (g === "w2") { win = Math.random() < 0.45; payout = win ? a * 2 : 0; x.s = Math.floor(Math.random() * 4); }
        else { x.res = Math.random() < 0.5 ? "Орел" : "Решка"; win = x.res === b.side; payout = win ? a * 2 : 0; }
        payout = pay(payout); save();
        return out({ win, payout, ...x });
      }

      // ---------- мины ----------
      if (path === "mines_start") {
        const n = [1, 3, 5, 10].includes(+b.mines) ? +b.mines : 0;
        if (!n) return err("Ошибка игры");
        const a = spend(b.bet); if (!a) return err(NOFUNDS);
        const bombs = []; while (bombs.length < n) { const r2 = Math.floor(Math.random() * 25); if (!bombs.includes(r2)) bombs.push(r2); }
        u.mines = { bet: a, n, bombs, open: [] }; save();
        return out();
      }
      if (path === "mines_pick" || path === "mines_cash") {
        const m = u.mines; if (!m) return err("Игра не начата");
        if (path === "mines_pick") {
          const i = +b.i;
          if (!(i >= 0 && i < 25) || m.open.includes(i)) return err("Ошибка клетки");
          if (m.bombs.includes(i)) { u.mines = null; save(); return out({ boom: true, bombs: m.bombs }); }
          m.open.push(i);
          const mult = mnMult(m.n, m.open.length), done = m.open.length === 25 - m.n;
          if (!done) { save(); return out({ step: m.open.length, mult }); }
          const payout = pay(m.bet * mult); u.mines = null; save();
          return out({ step: m.open.length, mult, done: true, payout, bombs: m.bombs });
        }
        if (!m.open.length) return err("Откройте хотя бы одну ячейку");
        const payout = pay(m.bet * mnMult(m.n, m.open.length)); u.mines = null; save();
        return out({ payout, bombs: m.bombs });
      }

      // ---------- краш (момент взрыва знает только сервер) ----------
      if (path === "crash_start") {
        const a = spend(b.bet); if (!a) return err(NOFUNDS);
        u.crash = { bet: a, cp: nextCP(), t0: Date.now() }; save();
        return out();
      }
      if (path === "crash_state" || path === "crash_cash") {
        const cr = u.crash;
        if (!cr) return path === "crash_state" ? json({ crashed: false, none: true }) : err("Раунд завершён");
        const mult = crashMult(cr.t0);
        if (mult >= cr.cp) { u.crash = null; save(); return out({ crashed: true, cp: cr.cp }); }
        if (path === "crash_state") return json({ crashed: false });
        const payout = pay(cr.bet * mult); u.crash = null; save();
        return out({ crashed: false, mult, payout, cp: cr.cp });
      }

      // ---------- вывод ----------
      if (path === "ticket") {
        const amount = Math.floor(+b.amount);
        if (!(amount >= 100 && amount <= 1e7)) return err("Минимум 100 ★");
        const tu = tgUser(b.init);
        if (!tu) return err("Откройте игру внутри StaticGram, чтобы вывести звёзды");
        if (amount > u.balance) return err("Недостаточно звёзд");
        const usedR = await c.query("SELECT coalesce(sum((data->>'amount')::numeric),0)::bigint AS s FROM tickets WHERE (lower(coalesce(data->>'owner', data->>'user')) = $1 OR data->>'uid' = $3) AND (data->>'ts')::numeric > $2 AND data->>'status' <> 'failed'", [name.toLowerCase(), Date.now() - 864e5, String(tu.id)]);
        const left = Math.max(0, WITHDRAW_LIMIT - Number(usedR.rows[0].s));
        if (amount > left) return err(left > 0 ? `Лимит вывода ${spaced(WITHDRAW_LIMIT)} ★ в сутки. Сейчас можно вывести ещё ${spaced(left)} ★` : `Лимит вывода ${spaced(WITHDRAW_LIMIT)} ★ в сутки исчерпан. Попробуйте позже`);
        u.balance -= amount; save();
        const data = { user: tu.username || String(tu.id), uid: String(tu.id), owner: u.name, amount, gift: false, status: "processing", ts: Date.now() };
        const ins = await c.query("INSERT INTO tickets(data) VALUES($1) RETURNING id", [data]);
        const ticket = { id: ins.rows[0].id, ...data };
        return { ...out({ ticket }), after: () => autoPayout(key, ticket) };
      }
      if (path === "my_tickets") {
        const r2 = await c.query("SELECT id, data FROM tickets WHERE lower(coalesce(data->>'owner', data->>'user')) = $1 AND data->>'status' <> 'failed' ORDER BY id", [name.toLowerCase()]);
        return json({ tickets: r2.rows.map(tkRow) });
      }

      return err("Не найдено", 404);
    })();

    if (dirty) await c.query("UPDATE users SET data=$2 WHERE key=$1", [key, u]);
    return res;
  });
  return done.after ? done.after() : done;
}

const html = fs.readFileSync(new URL("./index.html", import.meta.url));

const server = http.createServer(async (req, res) => {
  const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };
  try {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(html);
    }
    if (req.method === "GET" && path === "/health") return send(200, { ok: true });
    if (req.method === "GET" && path === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (!path.startsWith("/api/")) return send(404, { error: "Не найдено" });
    if (req.method !== "POST") return send(405, { error: "POST only" });

    let raw = "";
    for await (const ch of req) { raw += ch; if (raw.length > 200000) return send(413, { error: "Слишком большой запрос" }); }
    let b = {};
    try { b = JSON.parse(raw || "{}"); } catch {}
    const r = await route(path.slice(5).replace(/\/$/, ""), b, req.headers);
    send(r.s, r.o);
  } catch (e) {
    console.error("request error", e);
    send(500, { error: "Ошибка сервера" });
  }
});

await init();
server.listen(PORT, () => console.log("listening on", PORT));

if (TOKEN && PUBLIC_URL) {
  tg("setWebhook", { url: PUBLIC_URL.replace(/\/$/, "") + "/api/tg", ...(SECRET ? { secret_token: SECRET } : {}) })
    .then((r) => console.log("setWebhook:", JSON.stringify(r)));
} else {
  console.log("Вебхук не ставился: нужны BOT_TOKEN и PUBLIC_URL (на Render берётся автоматически)");
}
