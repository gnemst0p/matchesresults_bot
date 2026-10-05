const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

loadEnv();
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.PANDASCORE_TOKEN;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.TELEGRAM_APP_URL;
const LIQUIPEDIA_CONTACT = process.env.LIQUIPEDIA_CONTACT;
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
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, configured: Boolean(TOKEN) });
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
  if (url.pathname === '/api/tournament') {
    if (!TOKEN) return send(res, 503, { error: 'Для турниров добавьте PANDASCORE_TOKEN.' });
    const game = url.searchParams.get('game');
    const id = url.searchParams.get('id');
    if (!Object.hasOwn(gamePaths, game) || !id || !/^[A-Za-z0-9_-]+$/.test(id)) return send(res, 400, { error: 'Неверный идентификатор турнира.' });
    try {
      const root = `/${gamePaths[game]}/tournaments/${encodeURIComponent(id)}`;
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
      const teamPath = `/${gamePaths[game]}/teams/${encodeURIComponent(teamId)}`;
      const team = await pandascore(teamPath);
      let tournamentRoster = null;
      if (tournamentId) {
        const rosters = await pandascore(`/${gamePaths[game]}/tournaments/${encodeURIComponent(tournamentId)}/rosters`).catch(() => []);
        const entries = Array.isArray(rosters) ? rosters : Object.values(rosters || {});
        tournamentRoster = entries.find(entry => String(entry.team?.id ?? entry.team_id ?? '') === String(teamId)) || null;
      }
      const rosterPlayers = tournamentRoster?.players || tournamentRoster?.roster || tournamentRoster?.expected_roster;
      const teamPlayers = team.players || team.roster || [];
      return send(res, 200, {
        team,
        players: Array.isArray(rosterPlayers) && rosterPlayers.length ? rosterPlayers : Array.isArray(teamPlayers) ? teamPlayers : [],
        source: Array.isArray(rosterPlayers) && rosterPlayers.length ? 'tournament' : 'team',
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
