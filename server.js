const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnv();
function supabaseProjectUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    // Render must contain the project base URL. Strip accidental `/rest/v1` or `/auth/v1` suffixes.
    return url.origin;
  } catch { return ''; }
}
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.PANDASCORE_TOKEN;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.TELEGRAM_APP_URL;
const LIQUIPEDIA_CONTACT = process.env.LIQUIPEDIA_CONTACT;
const SUPABASE_URL = supabaseProjectUrl(process.env.SUPABASE_URL);
const SUPABASE_SECRET_KEY = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_PUBLISHABLE_KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
const ROOT = __dirname;
const API = 'https://api.pandascore.co';
const gamePaths = { dota2: 'dota2', cs2: 'csgo' };
const statusPaths = { live: 'running', upcoming: 'upcoming', past: 'past' };
const cache = new Map();
let liquipediaQueue = Promise.resolve();
let liquipediaLastRequest = 0;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

async function fetchMatches(game, status) {
  const key = `${game}:${status}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < 25_000) return hit.data;
  const url = new URL(`${API}/${gamePaths[game]}/matches/${statusPaths[status]}`);
  url.searchParams.set('per_page', status === 'past' ? '100' : '50');
  url.searchParams.set('sort', status === 'past' ? '-begin_at' : 'begin_at');
  url.searchParams.set('token', TOKEN);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) {
    const messages = { 401: 'Ключ PandaScore недействителен.', 403: 'У текущего тарифа нет доступа к этому списку матчей.', 429: 'Превышен лимит запросов PandaScore.' };
    throw new Error(messages[response.status] || `PandaScore ответил с кодом ${response.status}.`);
  }
  const data = await response.json();
  cache.set(key, { time: Date.now(), data });
  return data;
}

function moscowDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function utcDatesForMoscowDay(day) {
  const start = new Date(`${day}T00:00:00+03:00`);
  const end = new Date(`${day}T23:59:59.999+03:00`);
  return [...new Set([start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)])];
}

async function fetchMatchesForDate(game, status, day) {
  const dates = utcDatesForMoscowDay(day);
  const pages = await Promise.all(dates.map(async utcDay => {
    const key = `${game}:${status}:${utcDay}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < 25_000) return hit.data;
    const url = new URL(`${API}/${gamePaths[game]}/matches/${statusPaths[status]}`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('sort', status === 'past' ? '-begin_at' : 'begin_at');
    url.searchParams.set('filter[begin_at]', utcDay);
    url.searchParams.set('token', TOKEN);
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(response.status === 403 ? 'У текущего тарифа PandaScore нет доступа к этому списку.' : `PandaScore ответил с кодом ${response.status}.`);
    const data = await response.json();
    cache.set(key, { time: Date.now(), data });
    return data;
  }));
  return pages.flat().filter(match => moscowDate(match.begin_at || match.scheduled_at || match.original_scheduled_at) === day);
}

async function pandascore(pathname, params = {}) {
  const url = new URL(`${API}${pathname}`);
  url.searchParams.set('token', TOKEN);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
  const key = `pandascore:${url.pathname}:${url.searchParams.toString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < 10 * 60_000) return hit.data;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(response.status === 403 ? 'Эти данные недоступны на текущем тарифе PandaScore.' : `PandaScore ответил с кодом ${response.status}.`);
  const data = await response.json();
  cache.set(key, { time: Date.now(), data });
  return data;
}

function readJsonBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { reject(new Error('Запрос слишком большой.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Некорректные данные запроса.')); }
    });
    req.on('error', reject);
  });
}

function telegramUserFromInitData(initData) {
  if (!BOT_TOKEN || !initData || initData.length > 8192) throw new Error('Откройте приложение через Telegram и отправьте боту /start.');
  const params = new URLSearchParams(initData);
  const providedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!providedHash || !/^[a-f0-9]{64}$/i.test(providedHash) || !Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86_400) {
    throw new Error('Сессия Telegram устарела. Закройте мини-приложение и откройте его снова.');
  }
  // For bot-token validation, hash is the only field removed; the newer Telegram `signature` field remains in this HMAC payload.
  params.delete('hash');
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest();
  const actual = Buffer.from(providedHash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('Не удалось проверить пользователя Telegram. Откройте приложение через бота.');
  let user;
  try { user = JSON.parse(params.get('user') || '{}'); } catch {}
  if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) <= 0) throw new Error('Telegram не передал данные пользователя. Отправьте боту /start и откройте приложение ещё раз.');
  return String(user.id);
}

async function supabaseRequest(pathname, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Хранилище уведомлений не настроено: добавьте ключи Supabase в Render.');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      ...(SUPABASE_SECRET_KEY.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SUPABASE_SECRET_KEY}` }),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(12_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Хранилище подписок ответило с кодом ${response.status}.`);
  return text ? JSON.parse(text) : null;
}

function searchLiquipedia(game, query) {
  const key = `liquipedia:${game}:${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < 24 * 60 * 60_000) return Promise.resolve(hit.data);
  const request = liquipediaQueue.then(async () => {
    const wait = 2_000 - (Date.now() - liquipediaLastRequest);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    liquipediaLastRequest = Date.now();
    const wiki = game === 'dota2' ? 'dota2' : 'counterstrike';
    const url = new URL(`https://liquipedia.net/${wiki}/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', '5');
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': `GG-Live-Telegram-Mini-App/1.0 (${APP_URL || 'https://matchesresults-bot.onrender.com'}; ${LIQUIPEDIA_CONTACT})` },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Liquipedia ответила с кодом ${response.status}.`);
    const payload = await response.json();
    const results = payload.query?.search || [];
    const data = results.map(item => ({ title: item.title, snippet: String(item.snippet || '').replace(/<[^>]*>/g, ''), url: `https://liquipedia.net/${wiki}/${encodeURIComponent(item.title.replaceAll(' ', '_'))}` }));
    cache.set(key, { time: Date.now(), data });
    return data;
  });
  liquipediaQueue = request.catch(() => {});
  return request;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/config') return send(res, 200, { supabaseUrl: SUPABASE_URL || '', supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY });
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, configured: Boolean(TOKEN), notificationsConfigured: Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY && BOT_TOKEN), accountAuthConfigured: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY) });
  if (url.pathname === '/api/matches') {
    if (!TOKEN) return send(res, 503, { error: 'Добавьте PANDASCORE_TOKEN в файл .env, чтобы загрузить актуальные матчи.' });
    const game = url.searchParams.get('game') || 'all';
    const status = url.searchParams.get('status') || 'live';
    if (!['all', ...Object.keys(gamePaths)].includes(game) || !Object.hasOwn(statusPaths, status)) return send(res, 400, { error: 'Неверные параметры запроса.' });
    try {
      const games = game === 'all' ? Object.keys(gamePaths) : [game];
      const day = url.searchParams.get('date');
      const dayTimestamp = day ? Date.parse(`${day}T12:00:00Z`) : 0;
      if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(dayTimestamp) || new Date(dayTimestamp).toISOString().slice(0, 10) !== day)) return send(res, 400, { error: 'Укажите существующую дату в формате ГГГГ-ММ-ДД.' });
      const lists = await Promise.all(games.map(async (name) => ({ game: name, matches: day && status !== 'live' ? await fetchMatchesForDate(name, status, day) : await fetchMatches(name, status) })));
      const matches = lists.flatMap(({ game: name, matches: items }) => items
        .filter(item => status === 'live' ? item.status === 'running' : status === 'past' ? item.status === 'finished' : ['not_started', 'not_scheduled'].includes(item.status))
        .map(item => ({ ...item, game: name })));
      matches.sort((a, b) => {
        const at = Date.parse(a.begin_at || a.scheduled_at || '') || 0;
        const bt = Date.parse(b.begin_at || b.scheduled_at || '') || 0;
        return status === 'past' ? bt - at : at - bt;
      });
      return send(res, 200, { matches, updatedAt: new Date().toISOString() });
    } catch (error) {
      console.error('Match API error:', error.message);
      return send(res, 502, { error: error.message || 'Не удалось загрузить матчи. Попробуйте ещё раз.' });
    }
  }
  if (url.pathname === '/api/tournaments') {
    if (!TOKEN) return send(res, 503, { error: 'Для турниров добавьте PANDASCORE_TOKEN в переменные окружения.' });
    const game = url.searchParams.get('game') || 'all';
    const status = url.searchParams.get('status') || 'running';
    if (!['all', ...Object.keys(gamePaths)].includes(game) || !['running', 'upcoming', 'past'].includes(status)) return send(res, 400, { error: 'Неверные параметры турниров.' });
    try {
      const games = game === 'all' ? Object.keys(gamePaths) : [game];
      const lists = await Promise.all(games.map(async name => ({ game: name, tournaments: await pandascore(`/${gamePaths[name]}/tournaments/${status}`, { per_page: '50', sort: status === 'past' ? '-end_at' : 'begin_at' }) })));
      return send(res, 200, { tournaments: lists.flatMap(({ game: name, tournaments }) => tournaments.map(tournament => ({ ...tournament, game: name }))), updatedAt: new Date().toISOString() });
    } catch (error) { return send(res, 502, { error: error.message || 'Не удалось загрузить турниры.' }); }
  }
  if (url.pathname === '/api/search') {
    if (!TOKEN) return send(res, 503, { error: 'Для поиска нужен PANDASCORE_TOKEN.' });
    const game = url.searchParams.get('game') || 'all';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (!['all', ...Object.keys(gamePaths)].includes(game) || query.length < 2) return send(res, 400, { error: 'Введите не менее двух символов для поиска.' });
    try {
      const games = game === 'all' ? Object.keys(gamePaths) : [game];
      const results = await Promise.all(games.map(async name => {
        const params = { 'search[name]': query, per_page: '10', sort: 'name' };
        const [teams, tournaments] = await Promise.all([
          pandascore(`/${gamePaths[name]}/teams`, params),
          pandascore(`/${gamePaths[name]}/tournaments`, { ...params, sort: '-begin_at' })
        ]);
        return { game: name, teams, tournaments };
      }));
      return send(res, 200, {
        teams: results.flatMap(result => result.teams.map(team => ({ ...team, game: result.game }))),
        tournaments: results.flatMap(result => result.tournaments.map(tournament => ({ ...tournament, game: result.game }))),
        updatedAt: new Date().toISOString()
      });
    } catch (error) { return send(res, 502, { error: error.message || 'Не удалось выполнить поиск.' }); }
  }
  if (url.pathname === '/api/notifications') {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return send(res, 503, { error: 'Уведомления не настроены. В Render добавьте SUPABASE_URL и SUPABASE_SECRET_KEY.' });
    let userId;
    try { userId = telegramUserFromInitData(req.headers['x-telegram-init-data']); }
    catch (error) { return send(res, 401, { error: error.message }); }
    try {
      if (req.method === 'GET') {
        const query = new URLSearchParams({ select: 'game,team_id,team_name', telegram_user_id: `eq.${userId}`, enabled: 'eq.true' });
        const subscriptions = await supabaseRequest(`gg_live_subscriptions?${query}`);
        return send(res, 200, { subscriptions });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'Метод не поддерживается.' });
      const body = await readJsonBody(req);
      const game = body.game;
      const teamId = String(body.teamId || '');
      const teamName = String(body.teamName || '').trim().slice(0, 120);
      const enabled = Boolean(body.enabled);
      if (!Object.hasOwn(gamePaths, game) || !/^[A-Za-z0-9_-]{1,32}$/.test(teamId) || !teamName) return send(res, 400, { error: 'Неверные данные команды.' });
      const query = new URLSearchParams({ on_conflict: 'telegram_user_id,game,team_id' });
      await supabaseRequest(`gg_live_subscriptions?${query}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ telegram_user_id: userId, game, team_id: teamId, team_name: teamName, enabled })
      });
      return send(res, 200, { ok: true, enabled });
    } catch (error) { return send(res, 502, { error: error.message || 'Не удалось сохранить настройку уведомлений.' }); }
  }
  if (url.pathname === '/api/tournament') {
    if (!TOKEN) return send(res, 503, { error: 'Для турниров добавьте PANDASCORE_TOKEN.' });
    const game = url.searchParams.get('game');
    const id = url.searchParams.get('id');
    if (!Object.hasOwn(gamePaths, game) || !id || !/^[A-Za-z0-9_-]+$/.test(id)) return send(res, 400, { error: 'Неверный идентификатор турнира.' });
    try {
      // PandaScore exposes tournament details and child resources through global /tournaments routes.
      const root = `/tournaments/${encodeURIComponent(id)}`;
      const [tournament, rosters, standings, brackets, matches] = await Promise.all([
        pandascore(root),
        pandascore(`${root}/rosters`).catch(() => []),
        pandascore(`${root}/standings`).catch(() => []),
        pandascore(`${root}/brackets`).catch(() => []),
        pandascore(`${root}/matches`, { per_page: '100', sort: 'begin_at' }).catch(() => [])
      ]);
      return send(res, 200, { tournament, rosters, standings, brackets, matches, game, liquipediaConfigured: Boolean(LIQUIPEDIA_CONTACT), updatedAt: new Date().toISOString() });
    } catch (error) { return send(res, 502, { error: error.message || 'Не удалось загрузить сведения о турнире.' }); }
  }
  if (url.pathname === '/api/team') {
    if (!TOKEN) return send(res, 503, { error: 'Для загрузки составов нужен PANDASCORE_TOKEN.' });
    const game = url.searchParams.get('game');
    const teamId = url.searchParams.get('id');
    const tournamentId = url.searchParams.get('tournament');
    if (!Object.hasOwn(gamePaths, game) || !teamId || !/^[A-Za-z0-9_-]+$/.test(teamId) || (tournamentId && !/^[A-Za-z0-9_-]+$/.test(tournamentId))) return send(res, 400, { error: 'Неверные параметры команды.' });
    try {
      const teamPath = `/teams/${encodeURIComponent(teamId)}`;
      const [team, recentMatches, upcomingMatches, liveMatches] = await Promise.all([
        pandascore(teamPath),
        pandascore(`/teams/${encodeURIComponent(teamId)}/matches`, { 'filter[status]': 'finished', per_page: '10', sort: '-begin_at' }).catch(() => []),
        pandascore(`/teams/${encodeURIComponent(teamId)}/matches`, { 'filter[status]': 'not_started', per_page: '10', sort: 'begin_at' }).catch(() => []),
        pandascore(`/teams/${encodeURIComponent(teamId)}/matches`, { 'filter[status]': 'running', per_page: '10', sort: 'begin_at' }).catch(() => [])
      ]);
      let tournamentRoster = null;
      if (tournamentId) {
        const rosters = await pandascore(`/tournaments/${encodeURIComponent(tournamentId)}/rosters`).catch(() => []);
        const entries = Array.isArray(rosters) ? rosters : Object.values(rosters || {});
        tournamentRoster = entries.find(entry => String(entry.team?.id ?? entry.team_id ?? '') === String(teamId)) || null;
      }
      const rosterPlayers = tournamentRoster?.players || tournamentRoster?.roster || tournamentRoster?.expected_roster;
      const teamPlayers = team.players || team.roster || [];
      return send(res, 200, {
        team,
        players: Array.isArray(rosterPlayers) && rosterPlayers.length ? rosterPlayers : Array.isArray(teamPlayers) ? teamPlayers : [],
        source: Array.isArray(rosterPlayers) && rosterPlayers.length ? 'tournament' : 'team',
        matches: [...(Array.isArray(liveMatches) ? liveMatches : []), ...(Array.isArray(upcomingMatches) ? upcomingMatches : []), ...(Array.isArray(recentMatches) ? recentMatches : [])],
        updatedAt: new Date().toISOString()
      });
    } catch (error) { return send(res, 502, { error: error.message || 'Не удалось загрузить состав команды.' }); }
  }
  if (url.pathname === '/api/liquipedia') {
    const game = url.searchParams.get('game');
    const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!Object.hasOwn(gamePaths, game) || !query) return send(res, 400, { error: 'Нужны игра и название для поиска.' });
    if (!LIQUIPEDIA_CONTACT) return send(res, 503, { error: 'Добавьте LIQUIPEDIA_CONTACT в переменные окружения Render, чтобы включить поиск Liquipedia.' });
    try { return send(res, 200, { results: await searchLiquipedia(game, query) }); }
    catch (error) { return send(res, 502, { error: error.message || 'Liquipedia временно недоступна.' }); }
  }
  const requested = decodeURIComponent(url.pathname.slice(1) || 'index.html');
  const target = path.resolve(ROOT, requested);
  if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.readFile(target, (error, data) => {
    if (error) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(target)] || 'application/octet-stream');
  });
}

http.createServer((req, res) => { handle(req, res).catch(error => { console.error(error); send(res, 500, { error: 'Внутренняя ошибка сервера.' }); }); }).listen(PORT, '0.0.0.0', () => {
  console.log(`GG Live is running at http://localhost:${PORT}`);
  if (BOT_TOKEN && APP_URL) startTelegramBot();
});

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(35_000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result.result;
}

async function startTelegramBot() {
  try {
    await telegram('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть GG Live', web_app: { url: APP_URL } } });
    console.log('Telegram menu button is configured.');
  } catch (error) { console.error('Could not configure Telegram menu button:', error.message); }
  let offset = 0;
  while (true) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text || !/^\/(start|app)(@\w+)?(?:\s|$)/i.test(message.text)) continue;
        await telegram('sendMessage', {
          chat_id: message.chat.id,
          text: 'Смотри live-матчи, расписание и результаты Dota 2 и CS2 в GG Live.',
          reply_markup: { inline_keyboard: [[{ text: 'Открыть GG Live', web_app: { url: APP_URL } }]] }
        });
      }
    } catch (error) {
      console.error('Telegram bot polling error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

let notificationCheckBusy = false;
async function notificationMatches(game, status) {
  const url = new URL(`${API}/${gamePaths[game]}/matches/${status}`);
  url.searchParams.set('per_page', '100');
  url.searchParams.set('sort', '-begin_at');
  url.searchParams.set('token', TOKEN);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`PandaScore уведомления (${game}/${status}): HTTP ${response.status}`);
  return response.json();
}

async function checkTelegramNotifications() {
  if (notificationCheckBusy || !TOKEN || !BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  notificationCheckBusy = true;
  try {
    const subscriptions = await supabaseRequest('gg_live_subscriptions?select=telegram_user_id,game,team_id,team_name&enabled=eq.true');
    const active = Array.isArray(subscriptions) ? subscriptions : [];
    if (!active.length) return;
    const safeFetch = (game, status) => notificationMatches(game, status).catch(error => { console.error(error.message); return []; });
    const [dotaRunning, dotaFinished, csRunning, csFinished] = await Promise.all([
      safeFetch('dota2', 'running'), safeFetch('dota2', 'past'), safeFetch('cs2', 'running'), safeFetch('cs2', 'past')
    ]);
    const recentEnough = match => {
      const date = match.status === 'running' ? (match.begin_at || match.scheduled_at) : (match.end_at || match.modified_at || match.begin_at);
      return !date || Date.now() - Date.parse(date) < 4 * 60 * 60_000;
    };
    const matches = [
      ...(dotaRunning || []).filter(recentEnough).map(match => ({ ...match, game: 'dota2', event: 'started' })),
      ...(csRunning || []).filter(recentEnough).map(match => ({ ...match, game: 'cs2', event: 'started' })),
      ...(dotaFinished || []).filter(match => match.status === 'finished' && recentEnough(match)).map(match => ({ ...match, game: 'dota2', event: 'finished' })),
      ...(csFinished || []).filter(match => match.status === 'finished' && recentEnough(match)).map(match => ({ ...match, game: 'cs2', event: 'finished' }))
    ];
    const pending = [];
    for (const match of matches) {
      for (const opponent of match.opponents || []) {
        const teamId = String(opponent.opponent?.id ?? '');
        if (!teamId) continue;
        for (const sub of active) {
          if (sub.game === match.game && String(sub.team_id) === teamId) pending.push({ sub, match, eventKey: `${sub.telegram_user_id}:${match.game}:${match.id}:${match.event}` });
        }
      }
    }
    if (!pending.length) return;
    const keyList = [...new Set(pending.map(item => item.eventKey))];
    const filter = `in.(${keyList.map(key => `"${key}"`).join(',')})`;
    const existing = await supabaseRequest(`gg_live_notification_events?${new URLSearchParams({ select: 'event_key', event_key: filter })}`);
    const existingKeys = new Set((existing || []).map(item => item.event_key));
    for (const item of pending) {
      if (existingKeys.has(item.eventKey)) continue;
      const opponents = (item.match.opponents || []).map(side => side.opponent?.name).filter(Boolean);
      const results = (item.match.opponents || []).map(side => side.score).filter(score => score !== undefined && score !== null);
      const score = results.length >= 2 ? ` Счёт: ${results[0]} : ${results[1]}.` : '';
      const stage = item.match.tournament?.name || item.match.league?.name || '';
      const when = item.match.event === 'started' ? 'начался' : 'завершился';
      const gameName = item.match.game === 'dota2' ? 'Dota 2' : 'CS2';
      const text = `${gameName}: матч команды ${item.sub.team_name} ${when}.\n${opponents.join(' — ') || item.sub.team_name}${score}${stage ? `\nТурнир: ${stage}` : ''}`;
      try {
        await telegram('sendMessage', { chat_id: item.sub.telegram_user_id, text, reply_markup: { inline_keyboard: [[{ text: 'Открыть GG Live', web_app: { url: APP_URL } }]] } });
        await supabaseRequest('gg_live_notification_events', {
          method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({ event_key: item.eventKey })
        });
        existingKeys.add(item.eventKey);
      } catch (error) { console.error('Telegram notification failed:', error.message); }
    }
  } catch (error) { console.error('Notification check failed:', error.message); }
  finally { notificationCheckBusy = false; }
}

if (TOKEN && BOT_TOKEN && SUPABASE_URL && SUPABASE_SECRET_KEY) {
  setTimeout(checkTelegramNotifications, 20_000);
  setInterval(checkTelegramNotifications, 60_000);
  console.log('Best-effort Telegram notifications are enabled.');
}
