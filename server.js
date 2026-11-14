import http from "node:http";
import fs from "node:fs";
import pg from "pg";

const ADMIN = (process.env.ADMIN_CODE || "Admin-01").toLowerCase();
const TOKEN = process.env.BOT_TOKEN || "";
const SECRET = process.env.TG_SECRET || "";
const API_URL = (process.env.API_URL || "https://api.staticgram.top").replace(/\/$/, "");
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";
const PORT = process.env.PORT || 10000;
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
const mnMult = (n, k) => { let m = 0.97; for (let i = 0; i < k; i++) m *= (25 - i) / (25 - n - i); return +m.toFixed(2); };
const crashMult = (t0) => Math.exp((0.12 * (Date.now() - t0)) / 1000);
const nextCP = () => Math.max(1, Math.floor((100 * 0.96) / (1 - Math.random())) / 100);

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (key text PRIMARY KEY, data jsonb NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS payments (id text PRIMARY KEY)`);
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

// ---------- вебхук бота: оплата статиками ----------
async function hook(headers, b) {
  if (SECRET && headers["x-telegram-bot-api-secret-token"] !== SECRET) return err("forbidden", 403);
  if (b.pre_checkout_query) {
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: b.pre_checkout_query.id, ok: true });
    return json({ ok: true });
  }
  const m = b.message, sp = m?.successful_payment;
  if (sp && sp.currency === "XTR" && String(sp.invoice_payload).startsWith("dep:")) {
    const cid = sp.telegram_payment_charge_id;
    const key = "u:" + String(sp.invoice_payload).slice(4).toLowerCase();
    const credited = await tx(async (c) => {
      const ins = await c.query("INSERT INTO payments(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id", [cid]);
      if (!ins.rowCount) return false; // уже зачислено
      const r = await c.query("SELECT data FROM users WHERE key=$1 FOR UPDATE", [key]);
      if (!r.rowCount) return false;
      const u = r.rows[0].data;
      u.balance = (u.balance || 0) + sp.total_amount;
      await c.query("UPDATE users SET data=$2 WHERE key=$1", [key, u]);
      return true;
    });
    if (credited) await tg("sendMessage", { chat_id: m.chat.id, text: `Зачислено ${sp.total_amount} ★. Вернитесь в игру.` });
  } else if (m?.text?.startsWith("/start")) {
    await tg("sendMessage", { chat_id: m.chat.id, text: "Murder Game. Пополнение делается в игре кнопкой «+»." });
  }
  return json({ ok: true });
}

async function route(path, b, headers) {
  if (path === "tg") return hook(headers, b);

  // ---------- подарки для вывода ----------
  if (path === "gifts") {
    const d = await tg("getAvailableGifts", {});
    const list = (d?.result?.gifts || []).map((g) => ({ id: g.id, price: g.star_count })).filter((g) => g.id && g.price > 0).sort((a, c) => a.price - c.price);
    return json({ gifts: list });
  }

  // ---------- админ ----------
  if (path === "admin" || path === "admin_close") {
    if (String(b.code || "").toLowerCase() !== ADMIN) return err("Нет доступа", 403);
    if (path === "admin") {
      const q = String(b.q || "").trim().replace(/^@/, "").toLowerCase();
      const r = q
        ? await pool.query("SELECT id, data FROM tickets WHERE position($1 in lower(data->>'user')) > 0 OR position($1 in lower(coalesce(data->>'owner',''))) > 0 ORDER BY id DESC LIMIT 100", [q])
        : await pool.query("SELECT id, data FROM tickets WHERE data->>'status'='open' ORDER BY id DESC LIMIT 100");
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

  return tx(async (c) => {
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
      if (path === "register" || path === "me") return out({ daily: u.daily });

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
        const d = await tg("createInvoiceLink", { title: "Пополнение", description: `Пополнение баланса на ${amount} ★`, payload: "dep:" + u.name, currency: "XTR", prices: [{ label: "Звёзды", amount }] });
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
        const amount = Math.floor(+b.amount), payoutName = String(b.username || u.name).replace(/^@/, "");
        if (!(amount >= 100 && amount <= 1e7)) return err("Минимум 100 ★");
        if (!/^[A-Za-z0-9_]{3,32}$/.test(payoutName)) return err("Укажите свой @username");
        if (amount > u.balance) return err("Недостаточно звёзд");
        u.balance -= amount; save();
        const data = { user: payoutName, owner: u.name, amount, gift: !!b.gift_id, status: "open", ts: Date.now() };
        const ins = await c.query("INSERT INTO tickets(data) VALUES($1) RETURNING id", [data]);
        return out({ ticket: { id: ins.rows[0].id, ...data } });
      }
      if (path === "my_tickets") {
        const r2 = await c.query("SELECT id, data FROM tickets WHERE lower(coalesce(data->>'owner', data->>'user')) = $1 ORDER BY id", [name.toLowerCase()]);
        return json({ tickets: r2.rows.map(tkRow) });
      }

      return err("Не найдено", 404);
    })();

    if (dirty) await c.query("UPDATE users SET data=$2 WHERE key=$1", [key, u]);
    return res;
  });
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
