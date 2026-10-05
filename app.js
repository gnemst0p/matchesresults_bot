const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.themeParams?.bg_color) document.documentElement.style.setProperty('--bg', tg.themeParams.bg_color);
if (tg?.initDataUnsafe?.user) document.getElementById('avatar').textContent = (tg.initDataUnsafe.user.first_name || 'G').slice(0, 1).toUpperCase();

function readFavoriteTeams() {
  try { return JSON.parse(localStorage.getItem('gg-live-favorite-teams') || '{}') || {}; }
  catch { return {}; }
}
function readDeviceFavorites() {
  try {
    const saved = localStorage.getItem('gg-live-device-favorite-teams');
    if (saved !== null) return JSON.parse(saved) || {};
    const legacy = readFavoriteTeams();
    localStorage.setItem('gg-live-device-favorite-teams', JSON.stringify(legacy));
    return legacy;
  } catch { return readFavoriteTeams(); }
}
const deviceFavorites = readDeviceFavorites();
const state = { game: 'all', status: 'live', busy: false, date: moscowToday(), tournamentStatus: 'running', favoritesOnly: false, favorites: readFavoriteTeams(), notifications: {}, searchMode: false, calendarStart: null };
let authClient = null;
let authSession = null;
let authMode = 'login';
let syncingFavorites = false;
let lastFavoriteUser = null;
const list = document.getElementById('match-list');
const notice = document.getElementById('notice');
const titles = { live: 'Идут прямо сейчас', upcoming: 'Предстоящие матчи', past: 'Завершённые матчи' };
const labels = { live: 'LIVE · СЕЙЧАС', upcoming: 'РАСПИСАНИЕ', past: 'РЕЗУЛЬТАТЫ' };
const matchSection = document.getElementById('match-section');
const tournamentSection = document.getElementById('tournament-section');
const tournamentList = document.getElementById('tournament-list');
const tournamentNotice = document.getElementById('tournament-notice');
const searchSection = document.getElementById('search-results-section');
const searchResults = document.getElementById('search-results');

function moscowToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shiftDate(value, offset) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function mondayOf(value) {
  const date = new Date(`${value}T12:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}
function dateTitle(value) {
  if (value === moscowToday()) return 'СЕГОДНЯ';
  if (value === shiftDate(moscowToday(), -1)) return 'ВЧЕРА';
  if (value === shiftDate(moscowToday(), 1)) return 'ЗАВТРА';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${value}T12:00:00Z`)).toUpperCase();
}

function updateClock() {
  document.getElementById('local-clock').textContent = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date()) + ' MSK';
}
updateClock(); setInterval(updateClock, 30_000);

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }
function favoriteKey(game, teamId) { return `${game}:${teamId}`; }
function isFavorite(game, teamId) { return Boolean(state.favorites[favoriteKey(game, teamId)]); }
function persistFavorites() {
  try { localStorage.setItem('gg-live-favorite-teams', JSON.stringify(state.favorites)); } catch {}
}
async function saveFavoriteToAccount(game, teamId, name, enabled) {
  if (!authClient || !authSession?.user || syncingFavorites) return;
  const row = { user_id: authSession.user.id, game, team_id: String(teamId), team_name: String(name).slice(0, 120) };
  try {
    const query = authClient.from('gg_live_user_favorites');
    const result = enabled
      ? await query.upsert(row, { onConflict: 'user_id,game,team_id' })
      : await query.delete().eq('user_id', authSession.user.id).eq('game', game).eq('team_id', String(teamId));
    if (result.error) throw result.error;
  } catch (error) {
    showAccountMessage('Не удалось сохранить избранное в облаке. Проверьте таблицу и правила доступа Supabase.', true);
    console.warn('Favorite save error:', error.message);
  }
}
async function syncFavoritesWithAccount(user) {
  if (!authClient || !user || lastFavoriteUser === user.id) return;
  syncingFavorites = true;
  lastFavoriteUser = user.id;
  try {
    const { data, error } = await authClient.from('gg_live_user_favorites').select('game,team_id,team_name').eq('user_id', user.id);
    if (error) throw error;
    const cloud = {};
    for (const row of data || []) cloud[favoriteKey(row.game, row.team_id)] = { game: row.game, id: String(row.team_id), name: row.team_name };
    const local = { ...deviceFavorites };
    state.favorites = { ...cloud, ...local };
    persistFavorites();
    const missing = Object.entries(local).filter(([key]) => !cloud[key]).map(([, item]) => ({ user_id: user.id, game: item.game, team_id: String(item.id), team_name: String(item.name || '').slice(0, 120) }));
    if (missing.length) {
      const { error: saveError } = await authClient.from('gg_live_user_favorites').upsert(missing, { onConflict: 'user_id,game,team_id' });
      if (saveError) throw saveError;
    }
    for (const key of Object.keys(deviceFavorites)) delete deviceFavorites[key];
    try { localStorage.setItem('gg-live-device-favorite-teams', '{}'); } catch {}
    refreshFavoriteButton();
    document.dispatchEvent(new CustomEvent('gg-favorites-synced'));
    if (state.favoritesOnly) loadMatches();
  } catch (error) {
    lastFavoriteUser = null;
    showAccountMessage('Не удалось синхронизировать избранное. Проверьте настройки Supabase.', true);
    console.warn('Favorite sync error:', error.message);
  } finally { syncingFavorites = false; }
}
function saveFavorite(game, teamId, name) {
  const key = favoriteKey(game, teamId);
  if (state.favorites[key]) {
    delete state.favorites[key];
    if (!authSession?.user) delete deviceFavorites[key];
  }
  else {
    state.favorites[key] = { game, id: String(teamId), name };
    if (!authSession?.user) deviceFavorites[key] = { game, id: String(teamId), name };
  }
  if (!authSession?.user) try { localStorage.setItem('gg-live-device-favorite-teams', JSON.stringify(deviceFavorites)); } catch {}
  persistFavorites();
  saveFavoriteToAccount(game, teamId, name, Boolean(state.favorites[key]));
  if (state.favoritesOnly) loadMatches();
  refreshFavoriteButton();
  document.querySelectorAll('.favorite-team-toggle').forEach(toggle => {
    if (toggle.dataset.favoriteKey !== key) return;
    const active = isFavorite(game, teamId);
    toggle.textContent = active ? '★ Убрать из избранного' : '☆ В избранное';
    toggle.setAttribute('aria-pressed', String(active));
  });
}

function showAccountMessage(message, isError = false) {
  const target = document.getElementById('account-message');
  if (!target) return;
  target.textContent = message || '';
  target.classList.toggle('error', Boolean(isError));
}
function updateAccountUI() {
  const signedIn = Boolean(authSession?.user);
  const accountButton = document.getElementById('account-button');
  const user = authSession?.user;
  document.getElementById('account-label').textContent = signedIn ? 'Аккаунт' : 'Войти';
  document.getElementById('avatar').textContent = signedIn ? (user.email?.slice(0, 1) || user.user_metadata?.name?.slice(0, 1) || 'G').toUpperCase() : (tg?.initDataUnsafe?.user?.first_name || 'G').slice(0, 1).toUpperCase();
  accountButton?.classList.toggle('signed-in', signedIn);
  document.getElementById('account-title').textContent = signedIn ? 'Ваш аккаунт' : (authMode === 'signup' ? 'Создать аккаунт' : 'Войти в аккаунт');
  document.getElementById('account-description').textContent = signedIn ? (user.email || user.user_metadata?.name || 'Вы вошли. Избранное синхронизируется между устройствами.') : 'Сохраняйте избранные команды и открывайте их на любом устройстве.';
  document.getElementById('account-email-field').hidden = signedIn;
  document.getElementById('account-password-field').hidden = signedIn;
  document.getElementById('account-submit').hidden = signedIn;
  document.getElementById('account-mode').hidden = signedIn;
  document.getElementById('account-logout').hidden = !signedIn;
  document.getElementById('account-submit').textContent = authMode === 'signup' ? 'Создать аккаунт' : 'Войти';
  document.getElementById('account-mode').textContent = authMode === 'signup' ? 'Уже есть аккаунт? Войти' : 'Создать аккаунт';
  document.getElementById('account-telegram').textContent = signedIn ? 'Привязать Telegram' : 'Продолжить через Telegram';
}
async function initializeAuth() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    const config = await response.json();
    if (!response.ok || !config.supabaseUrl || !config.supabasePublishableKey || !window.supabase?.createClient) return;
    authClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    authClient.auth.onAuthStateChange((_event, session) => {
      authSession = session;
      if (!session?.user) {
        lastFavoriteUser = null;
        state.favorites = { ...deviceFavorites };
        persistFavorites();
        refreshFavoriteButton();
        if (state.favoritesOnly) loadMatches();
      }
      updateAccountUI();
      if (session?.user) void syncFavoritesWithAccount(session.user);
    });
    const { data } = await authClient.auth.getSession();
    authSession = data.session;
    updateAccountUI();
    if (authSession?.user) void syncFavoritesWithAccount(authSession.user);
  } catch (error) {
    console.warn('Account initialization error:', error.message);
  }
}
document.getElementById('account-button').addEventListener('click', () => {
  showAccountMessage(authClient ? '' : 'Аккаунты пока не настроены. Добавьте настройки Supabase и выполните SQL из README.');
  document.getElementById('account-dialog').showModal();
});
document.getElementById('account-close').addEventListener('click', () => document.getElementById('account-dialog').close());
document.getElementById('account-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
document.getElementById('account-mode').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('account-password').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  showAccountMessage(''); updateAccountUI();
});
document.getElementById('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!authClient) return showAccountMessage('Аккаунты не настроены. Добавьте ключ Supabase и выполните SQL из README.', true);
  const button = document.getElementById('account-submit');
  button.disabled = true; showAccountMessage('Подождите…');
  const email = document.getElementById('account-email').value.trim();
  const password = document.getElementById('account-password').value;
  try {
    const result = authMode === 'signup'
      ? await authClient.auth.signUp({ email, password })
      : await authClient.auth.signInWithPassword({ email, password });
    if (result.error) return showAccountMessage(result.error.message, true);
    if (authMode === 'signup' && !result.data.session) return showAccountMessage('Аккаунт создан. Проверьте почту и подтвердите адрес, затем войдите.');
    showAccountMessage('Вход выполнен. Избранные команды синхронизируются.');
  } catch (error) { showAccountMessage(error.message || 'Не удалось выполнить вход. Попробуйте ещё раз.', true); }
  finally { button.disabled = false; }
});
document.getElementById('account-telegram').addEventListener('click', async () => {
  if (!authClient) return showAccountMessage('Сначала настройте Supabase Auth и Telegram OIDC по инструкции в README.', true);
  showAccountMessage('Открываем Telegram…');
  const options = { redirectTo: location.origin };
  try {
    const result = authSession?.user
      ? await authClient.auth.linkIdentity({ provider: 'custom:telegram', options })
      : await authClient.auth.signInWithOAuth({ provider: 'custom:telegram', options: { ...options, scopes: 'openid profile' } });
    if (result.error) showAccountMessage(result.error.message, true);
  } catch (error) { showAccountMessage(error.message || 'Не удалось начать вход через Telegram.', true); }
});
document.getElementById('account-logout').addEventListener('click', async () => {
  if (!authClient) return;
  const { error } = await authClient.auth.signOut();
  if (error) return showAccountMessage(error.message, true);
  showAccountMessage('Вы вышли. Избранное осталось сохранено на этом устройстве.');
});
initializeAuth();
function refreshFavoriteButton() {
  const button = document.getElementById('favorites-filter');
  button.textContent = state.favoritesOnly ? `★ Избранное · фильтр включён (${Object.keys(state.favorites).length})` : `☆ Избранные команды · ${Object.keys(state.favorites).length}`;
  button.setAttribute('aria-pressed', String(state.favoritesOnly));
  button.classList.toggle('active', state.favoritesOnly);
}
function dateOf(match) { return match.begin_at || match.scheduled_at || match.original_scheduled_at; }
function formatDate(value) {
  if (!value) return 'ВРЕМЯ НЕ УКАЗАНО';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)).replace(' г.', '').toUpperCase() + ' MSK';
}
function shortDate(value) {
  if (!value) return state.status === 'live' ? 'СЕГОДНЯ' : 'МАТЧИ';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' }).format(new Date(value)).toUpperCase();
}
function scoreOf(match, opponent, index) {
  const direct = opponent?.score ?? opponent?.result?.score;
  if (direct !== undefined && direct !== null) return direct;
  const teamId = opponent?.opponent?.id;
  const results = Array.isArray(match.results) ? match.results : [];
  const result = results.find(item => teamId != null && [item.team_id, item.opponent_id, item.team?.id, item.opponent?.id].some(id => id != null && String(id) === String(teamId))) || results[index];
  return result?.score ?? result?.result?.score ?? result?.opponent?.score ?? null;
}
function statusLabel(status) {
  return ({ running: 'Матч идёт', not_started: 'Ещё не начался', finished: 'Завершён', canceled: 'Отменён', postponed: 'Перенесён', rescheduled: 'Перенесён' })[status] || status || 'Статус неизвестен';
}
function streamMarkup(match) {
  const streams = Array.isArray(match.streams_list) ? match.streams_list : [];
  const links = streams.map(stream => ({ url: stream.raw_url || stream.embed_url, label: stream.language ? `Трансляция · ${stream.language.toUpperCase()}` : 'Смотреть трансляцию', official: stream.official, main: stream.main }));
  if (!links.length && match.official_stream_url) links.push({ url: match.official_stream_url, label: 'Официальная трансляция', official: true });
  const safeLinks = links.filter(link => {
    try { return ['http:', 'https:'].includes(new URL(link.url).protocol); } catch { return false; }
  });
  if (!safeLinks.length) return '<span class="detail-muted">Ссылка пока не опубликована</span>';
  safeLinks.sort((a, b) => Number(Boolean(b.main || b.official)) - Number(Boolean(a.main || a.official)));
  return safeLinks.slice(0, 3).map(link => `<a class="stream-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a>`).join('');
}
function detailsMarkup(match, id, tournament) {
  const league = match.league?.name;
  const serie = match.serie?.full_name || match.serie?.name;
  const stage = match.tournament?.name;
  const format = match.number_of_games ? `Best of ${match.number_of_games}` : match.match_type?.replaceAll('_', ' ') || 'Формат не указан';
  const when = dateOf(match);
  const winner = match.winner?.name || match.winner?.opponent?.name;
  const [first, second] = match.opponents || [];
  const winnerName = winner || (match.winner_id ? [first, second].find(team => team?.opponent?.id === match.winner_id)?.opponent?.name : null);
  const items = [
    ['Турнир / этап', stage || tournament],
    ['Серия', serie],
    ['Лига', league],
    ['Начало', when ? formatDate(when) : null],
    ['Статус', statusLabel(match.status)],
    ['Формат', format],
    ...(winnerName ? [['Победитель', winnerName]] : [])
  ].filter(([, value]) => value);
  const hltv = match.game === 'cs2' ? `<div class="detail-item detail-streams"><span>Дополнительный источник</span><div class="stream-links"><a class="stream-link" href="https://www.hltv.org/search?query=${encodeURIComponent([tournament, (match.opponents || []).map(team => team?.opponent?.name).filter(Boolean).join(' ')].filter(Boolean).join(' '))}" target="_blank" rel="noopener noreferrer">Найти матч на HLTV ↗</a></div></div>` : '';
  return `<div class="match-details" id="${id}" hidden><div class="details-grid">${items.map(([label, value]) => `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}<div class="detail-item detail-streams"><span>Трансляции</span><div class="stream-links">${streamMarkup(match)}</div></div>${hltv}</div></div>`;
}
function teamMarkup(team, side, match) {
  const name = team?.opponent?.name || (side === 'left' ? 'Команда 1' : 'Команда 2');
  const image = team?.opponent?.image_url;
  const teamId = team?.opponent?.id;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  const logo = image ? `<img class="team-logo" data-initials="${escapeHtml(initials)}" src="${escapeHtml(image)}" alt="" loading="lazy">` : `<span class="team-logo team-fallback">${escapeHtml(initials)}</span>`;
  const content = `${logo}<span class="team-name">${escapeHtml(name)}</span>`;
  if (teamId == null) return `<div class="team ${side}">${content}</div>`;
  const panelId = `team-roster-${String(match.id || match.slug || 'match').replace(/[^A-Za-z0-9_-]/g, '-')}-${teamId}`;
  return `<button class="team ${side} team-open" type="button" data-team-id="${escapeHtml(teamId)}" data-game="${escapeHtml(match.game)}" data-tournament-id="${escapeHtml(match.tournament_id || match.tournament?.id || '')}" data-panel-id="${panelId}" data-team-name="${escapeHtml(name)}" aria-label="Состав команды ${escapeHtml(name)}" aria-expanded="false" aria-controls="${panelId}">${content}</button>`;
}
function cardMarkup(match) {
  const opponents = match.opponents || [];
  const [first, second] = opponents;
  const firstScore = scoreOf(match, first, 0);
  const secondScore = scoreOf(match, second, 1);
  const scoresReady = first && second && firstScore !== null && secondScore !== null;
  const scores = scoresReady
    ? `<span class="score" aria-label="Счёт ${escapeHtml(firstScore)} на ${escapeHtml(secondScore)}">${escapeHtml(firstScore)}<span class="separator">:</span>${escapeHtml(secondScore)}</span>`
    : `<span class="score pending" aria-label="Счёт пока не опубликован">—<span class="separator">:</span>—</span>`;
  const tournament = match.tournament?.name || match.league?.name || match.serie?.full_name || 'Матч';
  const round = match.number_of_games ? `BO${match.number_of_games}` : (match.tournament?.name || 'Матч');
  const date = dateOf(match);
  const live = state.status === 'live';
  const klass = live ? 'live-card' : state.status === 'past' ? 'finished-card' : 'scheduled-card';
  const game = match.game === 'cs2' ? 'CS2' : 'DOTA 2';
  const status = live ? '● LIVE' : state.status === 'past' ? 'ЗАВЕРШЁН' : 'НАЧАЛО';
  const scoreNote = !scoresReady && (live || state.status === 'past') ? `<div class="score-note">${live ? 'LIVE-СЧЁТ НЕ ПЕРЕДАН ИСТОЧНИКОМ' : 'ИТОГОВЫЙ СЧЁТ НЕ ОПУБЛИКОВАН'}</div>` : '';
  const center = live || state.status === 'past' ? `${scores}${scoreNote}` : `<span class="score pending">${date ? escapeHtml(new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', hour:'2-digit', minute:'2-digit' }).format(new Date(date))) : 'TBA'}</span>`;
  const detailsId = `match-details-${escapeHtml(match.id || match.slug || `${match.game}-${date || 'match'}`)}`;
  const firstTeam = teamMarkup(first, 'left', match);
  const secondTeam = teamMarkup(second, 'right', match);
  const rosterPanels = [first, second].map(team => {
    if (team?.opponent?.id == null) return '';
    const panelId = `team-roster-${String(match.id || match.slug || 'match').replace(/[^A-Za-z0-9_-]/g, '-')}-${team.opponent.id}`;
    return `<div class="team-roster-panel" id="${panelId}" hidden aria-live="polite"></div>`;
  }).join('');
  return `<article class="match-card ${klass}"><span class="match-status">${status}</span>${firstTeam}<div class="scoreline">${center}<div class="series">${escapeHtml(round.toUpperCase())}</div><div class="match-meta">${game} · ${escapeHtml(tournament)}</div></div>${secondTeam}${rosterPanels}<button class="details-toggle" type="button" aria-expanded="false" aria-controls="${detailsId}">Подробнее <span aria-hidden="true">＋</span></button>${detailsMarkup(match, detailsId, tournament)}</article>`;
}
function showLoading() { list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'; }
function showEmpty() {
  const descriptions = { live: 'Как только начнётся матч, он появится здесь.', upcoming: `На ${dateTitle(state.date).toLowerCase()} запланированных матчей не найдено.`, past: `За ${dateTitle(state.date).toLowerCase()} завершённых матчей не найдено.` };
  list.innerHTML = `<div class="empty"><div class="empty-icon">◉</div>${descriptions[state.status]}</div>`;
}
function renderWeekCalendar() {
  if (!state.calendarStart) state.calendarStart = mondayOf(state.date);
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(state.calendarStart, index));
  const formatShort = value => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00Z`));
  document.getElementById('calendar-title').textContent = `${formatShort(days[0])} — ${formatShort(days[6])}`;
  document.getElementById('calendar-days').innerHTML = days.map(day => {
    const label = formatShort(day).replace(',', '').split(' ');
    return `<button type="button" class="calendar-day${day === state.date ? ' active' : ''}${day === moscowToday() ? ' today' : ''}" data-date="${day}" aria-pressed="${day === state.date}"><span>${escapeHtml(label[0] || '')}</span><strong>${escapeHtml(label[1] || '')}</strong><small>${escapeHtml(label[2] || '')}</small></button>`;
  }).join('');
}
document.getElementById('calendar-prev').addEventListener('click', () => { state.calendarStart = shiftDate(state.calendarStart || mondayOf(state.date), -7); renderWeekCalendar(); });
document.getElementById('calendar-next').addEventListener('click', () => { state.calendarStart = shiftDate(state.calendarStart || mondayOf(state.date), 7); renderWeekCalendar(); });
document.getElementById('calendar-days').addEventListener('click', event => {
  const button = event.target.closest('.calendar-day');
  if (!button) return;
  state.date = button.dataset.date;
  document.getElementById('match-date').value = state.date;
  document.querySelectorAll('.date-shortcut').forEach(shortcut => shortcut.classList.toggle('active', shiftDate(moscowToday(), Number(shortcut.dataset.offset)) === state.date));
  renderWeekCalendar(); list.innerHTML = ''; loadMatches();
});
async function loadMatches() {
  if (state.busy) return;
  state.busy = true;
  const refresh = document.getElementById('refresh'); refresh.classList.add('spinning');
  if (state.status === 'tournaments') { state.busy = false; refresh.classList.remove('spinning'); return loadTournaments(); }
  matchSection.hidden = false; tournamentSection.hidden = true; searchSection.hidden = true;
  document.getElementById('date-filter').hidden = state.status === 'live';
  document.getElementById('tournament-filter').hidden = true;
  document.getElementById('section-title').textContent = titles[state.status];
  document.getElementById('date-label').textContent = state.status === 'live' ? labels.live : `${dateTitle(state.date)} · ${labels[state.status]}`;
  notice.classList.add('hidden');
  if (!list.children.length || list.querySelector('.empty')) showLoading();
  try {
    const params = new URLSearchParams({ game: state.game, status: state.status });
    if (state.status !== 'live') params.set('date', state.date);
    const response = await fetch(`/api/matches?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить матчи.');
    const allMatches = payload.matches || [];
    const favoriteKeys = new Set(Object.keys(state.favorites));
    const matches = state.favoritesOnly ? allMatches.filter(match => (match.opponents || []).some(opponent => favoriteKeys.has(favoriteKey(match.game, opponent?.opponent?.id)))) : allMatches;
    document.getElementById('live-count').textContent = state.status === 'live' ? matches.length : '·';
    if (!matches.length && state.favoritesOnly && !Object.keys(state.favorites).length) list.innerHTML = '<div class="empty">Добавьте команду в избранное, нажав на неё в карточке матча.</div>';
    else if (!matches.length) showEmpty();
    else {
      list.innerHTML = matches.map(cardMarkup).join('');
      list.querySelectorAll('img.team-logo').forEach(image => image.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'team-logo team-fallback';
        fallback.textContent = image.dataset.initials || '?';
        image.replaceWith(fallback);
      }, { once: true }));
      document.getElementById('date-label').textContent = state.status === 'live' ? shortDate(dateOf(matches[0])) + ' · LIVE' : `${dateTitle(state.date)} · ${labels[state.status]}`;
    }
    document.getElementById('updated-at').textContent = 'обновлено ' + new Intl.DateTimeFormat('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow' }).format(new Date(payload.updatedAt));
  } catch (error) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">⌁</div>Матчи пока не загрузились.</div>`;
    notice.textContent = error.message;
    notice.classList.remove('hidden');
    document.getElementById('live-count').textContent = '—';
  } finally { state.busy = false; refresh.classList.remove('spinning'); }
}

document.getElementById('favorites-filter').addEventListener('click', () => {
  state.favoritesOnly = !state.favoritesOnly;
  refreshFavoriteButton();
  if (!state.searchMode) loadMatches();
});
refreshFavoriteButton();
document.getElementById('search-form').addEventListener('submit', event => { event.preventDefault(); runSearch(); });

async function runSearch() {
  const query = document.getElementById('search-query').value.trim();
  if (query.length < 2) {
    document.getElementById('search-notice').textContent = 'Введите минимум два символа.';
    document.getElementById('search-notice').classList.remove('hidden');
    return;
  }
  state.searchMode = true;
  matchSection.hidden = true; tournamentSection.hidden = true; searchSection.hidden = false;
  document.getElementById('date-filter').hidden = true;
  document.getElementById('tournament-filter').hidden = true;
  document.getElementById('search-notice').classList.add('hidden');
  searchResults.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const params = new URLSearchParams({ game: state.game, q: query });
    const response = await fetch(`/api/search?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Поиск не выполнен.');
    const teams = payload.teams || [];
    const tournaments = payload.tournaments || [];
    searchResults.innerHTML = teams.length || tournaments.length
      ? `<div class="search-group"><h3>Команды</h3>${teams.map(searchTeamMarkup).join('') || '<p class="detail-muted">Команды не найдены.</p>'}</div><div class="search-group"><h3>Турниры</h3>${tournaments.map(tournamentMarkup).join('') || '<p class="detail-muted">Турниры не найдены.</p>'}</div>`
      : '<div class="empty">Ничего не найдено.</div>';
  } catch (error) {
    searchResults.innerHTML = '<div class="empty">Поиск сейчас недоступен.</div>';
    const searchNotice = document.getElementById('search-notice');
    searchNotice.textContent = error.message; searchNotice.classList.remove('hidden');
  }
}
function searchTeamMarkup(team) {
  const id = String(team.id || team.slug || '');
  const name = team.name || team.slug || 'Команда';
  const game = team.game || state.game;
  const gameLabel = game === 'cs2' ? 'CS2' : 'DOTA 2';
  const panelId = `search-team-${id.replace(/[^A-Za-z0-9_-]/g, '-')}-${game}`;
  const logo = team.image_url ? `<img class="team-logo" src="${escapeHtml(team.image_url)}" alt="" loading="lazy">` : '';
  return `<article class="search-team"><div class="search-team-heading">${logo}<strong>${escapeHtml(name)}</strong><span>${gameLabel}</span></div><button class="team-favorite-action favorite-team-toggle" type="button" data-favorite-key="${escapeHtml(favoriteKey(game,id))}" data-game="${game}" data-team-id="${escapeHtml(id)}" data-team-name="${escapeHtml(name)}" aria-pressed="${isFavorite(game,id)}">${isFavorite(game,id) ? '★ Убрать из избранного' : '☆ В избранное'}</button><button class="details-toggle search-team-open" type="button" data-team-id="${escapeHtml(id)}" data-game="${game}" data-panel-id="${panelId}" data-team-name="${escapeHtml(name)}" aria-expanded="false">Состав и матчи <span>＋</span></button><div class="team-roster-panel" id="${panelId}" hidden aria-live="polite"></div></article>`;
}

document.querySelectorAll('.game-tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.game-tab').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', tab === button ? 'true' : 'false'); });
  state.game = button.dataset.game;
  if (state.searchMode) runSearch(); else loadMatches();
}));
document.querySelectorAll('.status-tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.status-tab').forEach(tab => tab.classList.toggle('active', tab === button));
  state.searchMode = false;
  state.status = button.dataset.status;
  document.getElementById('match-list').innerHTML = '';
  if (state.status === 'tournaments') loadTournaments(); else loadMatches();
}));
document.getElementById('refresh').addEventListener('click', () => state.searchMode ? runSearch() : loadMatches());
function teamRosterMarkup(payload, game, teamName, teamId) {
  const players = valuesOf(payload.players);
  const favorite = isFavorite(game, teamId);
  const key = favoriteKey(game, teamId);
  const notificationControl = tg?.initData
    ? `<button class="team-favorite-action notification-toggle" type="button" data-notification-key="${escapeHtml(key)}" data-game="${escapeHtml(game)}" data-team-id="${escapeHtml(teamId)}" data-team-name="${escapeHtml(teamName)}" aria-pressed="${Boolean(state.notifications[key])}">${state.notifications[key] ? '🔔 Уведомления включены' : '♧ Уведомлять о матчах'}</button><span class="notification-notice" aria-live="polite"></span>`
    : '<span class="detail-muted">Уведомления доступны при открытии мини-приложения через Telegram.</span>';
  const head = `<div class="team-roster-heading"><strong>${escapeHtml(payload.team?.name || teamName)}</strong><div class="team-actions"><button class="team-favorite-action favorite-team-toggle" type="button" data-favorite-key="${escapeHtml(key)}" data-game="${escapeHtml(game)}" data-team-id="${escapeHtml(teamId)}" data-team-name="${escapeHtml(teamName)}" aria-pressed="${favorite}">${favorite ? '★ Убрать из избранного' : '☆ В избранное'}</button>${notificationControl}</div></div>`;
  const roster = players.length ? (() => {
  const sourceNote = payload.source === 'tournament' ? 'Состав на этом турнире' : 'Состав команды по данным PandaScore';
  const site = game === 'dota2' ? 'Liquipedia' : 'HLTV';
  const siteUrl = game === 'dota2' ? 'https://liquipedia.net/dota2/index.php?search=' : 'https://www.hltv.org/search?query=';
  return `<span class="roster-source">${sourceNote}</span><ul class="team-roster-players">${players.map(player => {
    const nickname = player.name || player.nickname || player.slug || player.full_name || 'Игрок';
    const role = player.role || player.position;
    const href = `${siteUrl}${encodeURIComponent(nickname)}`;
    return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(nickname)} ↗</a>${role ? `<span>${escapeHtml(role)}</span>` : ''}</li>`;
  }).join('')}</ul><span class="roster-source">Профили игроков откроются в ${site}.</span>`;
  })() : '<p class="detail-muted">Состав пока не опубликован в PandaScore.</p>';
  const priority = { running: 0, not_started: 1, finished: 2 };
  const matches = [...valuesOf(payload.matches)].sort((a,b) => {
    const rankA = priority[a.status] ?? 3, rankB = priority[b.status] ?? 3;
    if (rankA !== rankB) return rankA - rankB;
    const dateA = Date.parse(dateOf(a) || 0), dateB = Date.parse(dateOf(b) || 0);
    return a.status === 'not_started' ? dateA - dateB : dateB - dateA;
  });
  const history = matches.length ? `<h4>Ближайшие и последние матчи</h4><div class="team-match-history">${matches.map(match => {
    const opponents = valuesOf(match.opponents);
    const names = opponents.map(item => item.opponent?.name || item.name).filter(Boolean);
    const scores = opponents.map((opponent,index) => scoreOf(match,opponent,index));
    const score = scores.length === 2 && scores.every(value => value != null) ? `${scores[0]} : ${scores[1]}` : statusLabel(match.status);
    const when = dateOf(match);
    const tournament = match.tournament?.name || match.league?.name || '';
    return `<div class="team-history-row"><div><strong>${escapeHtml(names.join(' — ') || 'Матч')}</strong><span>${escapeHtml(tournament)}</span></div><b>${escapeHtml(score)}</b><time>${escapeHtml(when ? formatDate(when) : statusLabel(match.status))}</time></div>`;
  }).join('')}</div>` : '<h4>Ближайшие и последние матчи</h4><p class="detail-muted">Матчи команды пока не опубликованы.</p>';
  return `${head}${roster}${history}`;
}
async function loadTeamPanel(teamButton, panel) {
  panel.hidden = false;
  teamButton.setAttribute('aria-expanded', 'true');
  if (panel.dataset.loaded) return;
  panel.innerHTML = '<span class="detail-muted">Загружаем состав и матчи…</span>';
  try {
    const params = new URLSearchParams({ game: teamButton.dataset.game, id: teamButton.dataset.teamId });
    if (teamButton.dataset.tournamentId) params.set('tournament', teamButton.dataset.tournamentId);
    const response = await fetch(`/api/team?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить страницу команды.');
    panel.innerHTML = teamRosterMarkup(payload, teamButton.dataset.game, teamButton.dataset.teamName, teamButton.dataset.teamId);
    panel.dataset.loaded = 'true';
    await refreshNotificationSubscriptions(panel);
  } catch (error) { panel.innerHTML = `<span class="detail-muted">${escapeHtml(error.message)}</span>`; }
}
async function handleTeamClicks(event) {
  const notificationButton = event.target.closest('.notification-toggle');
  if (notificationButton) {
    await toggleNotification(notificationButton);
    return;
  }
  const favoriteButton = event.target.closest('.favorite-team-toggle');
  if (favoriteButton) {
    saveFavorite(favoriteButton.dataset.game, favoriteButton.dataset.teamId, favoriteButton.dataset.teamName);
    return;
  }
  const teamButton = event.target.closest('.team-open, .search-team-open');
  if (teamButton) {
    const panel = document.getElementById(teamButton.dataset.panelId);
    const expanded = teamButton.getAttribute('aria-expanded') === 'true';
    teamButton.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
    if (expanded) return;
    await loadTeamPanel(teamButton, panel);
    return;
  }
}
async function refreshNotificationSubscriptions(panel) {
  if (!tg?.initData) return;
  try {
    const response = await fetch('/api/notifications', { headers: { 'X-Telegram-Init-Data': tg.initData } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить уведомления.');
    state.notifications = {};
    for (const subscription of payload.subscriptions || []) state.notifications[favoriteKey(subscription.game, subscription.team_id)] = true;
    panel.querySelectorAll('.notification-toggle').forEach(button => {
      const enabled = Boolean(state.notifications[button.dataset.notificationKey]);
      button.setAttribute('aria-pressed', String(enabled));
      button.textContent = enabled ? '🔔 Уведомления включены' : '♧ Уведомлять о матчах';
    });
  } catch (error) {
    const notice = panel.querySelector('.notification-notice');
    if (notice) notice.textContent = error.message;
  }
}
async function toggleNotification(button) {
  const key = button.dataset.notificationKey;
  const enabled = !state.notifications[key];
  const notice = button.parentElement.querySelector('.notification-notice');
  button.disabled = true;
  if (notice) notice.textContent = 'Сохраняем настройку…';
  try {
    const response = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg?.initData || '' },
      body: JSON.stringify({ game: button.dataset.game, teamId: button.dataset.teamId, teamName: button.dataset.teamName, enabled })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить настройку.');
    if (enabled) state.notifications[key] = true; else delete state.notifications[key];
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = enabled ? '🔔 Уведомления включены' : '♧ Уведомлять о матчах';
    if (enabled && !isFavorite(button.dataset.game, button.dataset.teamId)) saveFavorite(button.dataset.game, button.dataset.teamId, button.dataset.teamName);
    if (notice) notice.textContent = enabled ? 'Будем присылать сообщения о начале и завершении матчей.' : 'Уведомления отключены.';
  } catch (error) { if (notice) notice.textContent = error.message; }
  finally { button.disabled = false; }
}
list.addEventListener('click', async event => {
  await handleTeamClicks(event);
  if (event.target.closest('.team-open')) return;
  const button = event.target.closest('.details-toggle');
  if (!button) return;
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  panel.hidden = expanded;
  button.innerHTML = expanded ? 'Подробнее <span aria-hidden="true">＋</span>' : 'Скрыть <span aria-hidden="true">−</span>';
});
searchResults.addEventListener('click', async event => {
  await handleTeamClicks(event);
  const button = event.target.closest('.search-team-open');
  if (button) return;
  if (event.target.closest('.tournament-details-toggle')) toggleTournamentDetails(event);
});
loadMatches();
setInterval(() => { if (!state.searchMode) loadMatches(); }, 60_000);

function tournamentDate(value) {
  if (!value) return 'Даты не указаны';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}
function tournamentMarkup(t) {
  const name = t.name || t.slug || 'Турнир';
  const series = t.serie?.full_name || t.serie?.name || t.league?.name;
  const dates = [t.begin_at || t.start_at, t.end_at].filter(Boolean).map(tournamentDate).join(' — ');
  const prize = t.prizepool || t.prize_pool;
  const id = String(t.id || t.slug || '');
  return `<article class="tournament-card"><div class="tournament-topline"><span>${escapeHtml((t.game || '').toUpperCase())}</span>${t.tier ? `<span class="tournament-tier">TIER ${escapeHtml(t.tier)}</span>` : '<span class="tournament-tier">TIER —</span>'}</div><h3>${escapeHtml(name)}</h3><p class="tournament-series">${escapeHtml(series || t.organizer || 'Киберспортивный турнир')}</p><div class="tournament-meta"><span>${escapeHtml(dates || 'Расписание уточняется')}</span>${prize ? `<span>Призовой фонд · ${escapeHtml(prize)}</span>` : ''}</div><button class="details-toggle tournament-details-toggle" data-id="${escapeHtml(id)}" data-game="${escapeHtml(t.game || '')}" aria-expanded="false">Составы, сетка и результаты <span>＋</span></button><div class="tournament-detail" hidden></div></article>`;
}
function tournamentInfoCount(t) {
  return [
    Boolean(t.tier),
    Boolean(t.begin_at || t.start_at || t.end_at),
    Boolean(t.serie?.name || t.serie?.full_name || t.league?.name),
    Boolean(t.organizer),
    Boolean(t.prizepool || t.prize_pool),
    Boolean(t.has_bracket),
    Array.isArray(t.expected_roster) && t.expected_roster.length > 0
  ].filter(Boolean).length;
}
function compareTournamentTier(a, b) {
  const tiers = { s: 0, a: 1, b: 2, c: 3, d: 4 };
  const tierA = tiers[String(a.tier || '').toLowerCase()] ?? 5;
  const tierB = tiers[String(b.tier || '').toLowerCase()] ?? 5;
  if (tierA !== tierB) return tierA - tierB;
  const dateA = Date.parse(a.begin_at || a.start_at || a.end_at || '') || 0;
  const dateB = Date.parse(b.begin_at || b.start_at || b.end_at || '') || 0;
  return state.tournamentStatus === 'past' ? dateB - dateA : dateA - dateB;
}
function valuesOf(value) { return Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []; }
function teamName(item) { return item?.team?.name || item?.opponent?.name || item?.participant?.name || item?.name || 'Участник'; }
function rosterMarkup(rosters, expected) {
  const rows = valuesOf(rosters).length ? valuesOf(rosters) : valuesOf(expected);
  if (!rows.length) return '<p class="detail-muted">Составы пока не опубликованы.</p>';
  return `<div class="tournament-rosters">${rows.map(row => {
    const players = valuesOf(row.players || row.roster || row.expected_roster).map(player => player.name || player.nickname || player.slug).filter(Boolean);
    return `<div class="roster-team"><strong>${escapeHtml(teamName(row))}</strong><span>${escapeHtml(players.join(' · ') || 'Список игроков пока недоступен')}</span></div>`;
  }).join('')}</div>`;
}
function standingsMarkup(standings) {
  const rows = valuesOf(standings);
  if (!rows.length) return '<p class="detail-muted">Таблица ещё не опубликована.</p>';
  return `<div class="standing-list">${rows.map((row, index) => `<div class="standing-row"><b>${escapeHtml(row.rank ?? row.position ?? index + 1)}</b><strong>${escapeHtml(teamName(row))}</strong><span>${escapeHtml([row.points != null ? `${row.points} очк.` : '', row.wins != null ? `Побед ${row.wins}` : '', row.losses != null ? `Поражений ${row.losses}` : ''].filter(Boolean).join(' · ') || row.description || '—')}</span></div>`).join('')}</div>`;
}
function bracketMarkup(brackets, matches) {
  const bracketRows = [];
  const visited = new Set();
  function flatten(value, inheritedRound = '') {
    if (Array.isArray(value)) { value.forEach(item => flatten(item, inheritedRound)); return; }
    if (!value || typeof value !== 'object') return;
    const match = value.match && typeof value.match === 'object' ? value.match : value;
    if (Array.isArray(match.opponents) || Array.isArray(match.previous_matches)) {
      const id = String(match.id || match.match_id || `${match.name || ''}:${match.begin_at || ''}`);
      if (!visited.has(id)) { visited.add(id); bracketRows.push({ match, round: value.round_name || value.round?.name || value.stage?.name || value.name || inheritedRound }); }
      return;
    }
    const label = value.round_name || value.round?.name || value.stage?.name || value.name || inheritedRound;
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') flatten(child, label || key);
  }
  const matchRows = valuesOf(matches);
  matchRows.forEach(match => bracketRows.push({ match, round: match.round_name || match.round?.name || match.stage?.name || match.stage || '' }));
  flatten(brackets);
  if (!bracketRows.length) return '<p class="detail-muted">Для этого турнира PandaScore пока не опубликовал сетку или список матчей.</p>';
  const mergedRows = new Map();
  for (const row of bracketRows) {
    const id = String(row.match.id || row.match.match_id || `${row.match.name || ''}:${row.match.begin_at || ''}`);
    const previous = mergedRows.get(id);
    if (!previous) mergedRows.set(id, row);
    else mergedRows.set(id, {
      match: { ...row.match, ...previous.match, previous_matches: previous.match.previous_matches?.length ? previous.match.previous_matches : row.match.previous_matches },
      round: previous.round || row.round
    });
  }
  const allRows = [...mergedRows.values()];
  const rounds = new Map();
  for (const row of allRows) {
    const round = typeof row.round === 'string' ? row.round : '';
    const label = round || 'Матчи турнира';
    if (!rounds.has(label)) rounds.set(label, []);
    rounds.get(label).push(row.match);
  }
  const roundRank = label => {
    const value = label.toLowerCase();
    if (/final/.test(value) && !/semi|quarter/.test(value)) return 50;
    if (/semi/.test(value)) return 40;
    if (/quarter/.test(value)) return 30;
    if (/round of 16|sixteen|1\/8/.test(value)) return 20;
    if (/round of 32|thirty.?two|1\/16/.test(value)) return 10;
    return 25;
  };
  const ordered = [...rounds.entries()].sort((a, b) => roundRank(a[0]) - roundRank(b[0]) || a[0].localeCompare(b[0]));
  return `<div class="bracket-rounds">${ordered.map(([round, roundMatches]) => `<section class="bracket-round"><h5>${escapeHtml(round)}</h5>${roundMatches.map(match => {
    const opponents = valuesOf(match.opponents);
    const previous = valuesOf(match.previous_matches).map(item => `${item.type === 'loser' ? 'Проигравший' : 'Победитель'} матча ${item.match_id}`);
    const time = match.begin_at || match.scheduled_at || match.original_scheduled_at;
    return `<article class="bracket-game">${opponents.length ? opponents.slice(0, 2).map((opponent, index) => {
      const name = opponent.opponent?.name || opponent.name || 'Участник не определён';
      const score = scoreOf(match, opponent, index);
      const winner = match.winner_id != null && String(match.winner_id) === String(opponent.opponent?.id);
      return `<div class="bracket-team${winner ? ' winner' : ''}"><span>${escapeHtml(name)}</span><b>${score == null ? '—' : escapeHtml(score)}</b></div>`;
    }).join('') : `<div class="bracket-team pending"><span>${escapeHtml(previous.join(' / ') || 'Участники уточняются')}</span></div>`}${previous.length && opponents.length ? `<span class="bracket-dependency">Ветка: ${escapeHtml(previous.join(' · '))}</span>` : ''}<small>${escapeHtml(statusLabel(match.status))}${time ? ` · ${escapeHtml(tournamentDate(time))}` : ''}</small></article>`;
  }).join('')}</section>`).join('')}</div>`;
}
function tournamentDetailMarkup(data) {
  const t = data.tournament || {};
  const items = [['Организатор', t.organizer], ['Формат', t.tournament_type || t.type], ['Призовой фонд', t.prizepool || t.prize_pool], ['Участники', t.expected_roster?.length ? `${t.expected_roster.length} команд` : null], ['Сетка', t.has_bracket ? 'Опубликована' : null]].filter(([, value]) => value);
  return `<div class="tournament-info">${items.map(([label, value]) => `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div><h4>Составы команд</h4>${rosterMarkup(data.rosters, t.expected_roster)}<h4>Турнирная таблица</h4>${standingsMarkup(data.standings)}<h4>Сетка и матчи</h4>${bracketMarkup(data.brackets, data.matches)}<div class="liquipedia-results"><h4>Справка Liquipedia</h4><div class="liquipedia-items"><span class="detail-muted">Ищем страницу турнира…</span></div><small>Источник: <a href="https://liquipedia.net/api-terms-of-use" target="_blank" rel="noopener noreferrer">Liquipedia</a>, лицензия CC BY-SA 3.0.</small></div><p class="data-credit">Матчи и турнирные данные: PandaScore.</p>`;
}
async function loadTournaments() {
  matchSection.hidden = true; tournamentSection.hidden = false; searchSection.hidden = true;
  document.getElementById('date-filter').hidden = true;
  document.getElementById('tournament-filter').hidden = false;
  tournamentNotice.classList.add('hidden');
  if (!tournamentList.children.length) tournamentList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const params = new URLSearchParams({ game: state.game, status: state.tournamentStatus });
    const response = await fetch(`/api/tournaments?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить турниры.');
    const tournaments = (payload.tournaments || []).filter(t => tournamentInfoCount(t) >= 2).sort(compareTournamentTier);
    tournamentList.innerHTML = tournaments.length ? tournaments.map(tournamentMarkup).join('') : '<div class="empty">Пока нет турниров с достаточной информацией для показа.</div>';
    document.getElementById('tournaments-updated').textContent = 'обновлено ' + new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(payload.updatedAt));
  } catch (error) {
    tournamentList.innerHTML = '<div class="empty">Турниры пока не загрузились.</div>';
    tournamentNotice.textContent = error.message; tournamentNotice.classList.remove('hidden');
  }
}

document.querySelectorAll('.date-shortcut').forEach(button => button.addEventListener('click', () => {
  state.date = shiftDate(moscowToday(), Number(button.dataset.offset));
  state.calendarStart = mondayOf(state.date);
  document.getElementById('match-date').value = state.date;
  document.querySelectorAll('.date-shortcut').forEach(item => item.classList.toggle('active', item === button));
  renderWeekCalendar();
  list.innerHTML = ''; loadMatches();
}));
const dateInput = document.getElementById('match-date');
dateInput.value = state.date;
state.calendarStart = mondayOf(state.date);
renderWeekCalendar();
dateInput.addEventListener('change', () => {
  if (!dateInput.value) return;
  state.date = dateInput.value;
  state.calendarStart = mondayOf(state.date);
  document.querySelectorAll('.date-shortcut').forEach(button => button.classList.toggle('active', shiftDate(moscowToday(), Number(button.dataset.offset)) === state.date));
  renderWeekCalendar();
  list.innerHTML = ''; loadMatches();
});
document.querySelectorAll('.tournament-tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tournament-tab').forEach(tab => tab.classList.toggle('active', tab === button));
  state.tournamentStatus = button.dataset.tournamentStatus; tournamentList.innerHTML = ''; loadTournaments();
}));
async function toggleTournamentDetails(event) {
  const button = event.target.closest('.tournament-details-toggle');
  if (!button) return;
  const panel = button.nextElementSibling;
  if (panel.hidden) {
    panel.hidden = false; button.setAttribute('aria-expanded', 'true'); button.innerHTML = 'Скрыть подробности <span>−</span>';
    if (!panel.dataset.loaded) {
      panel.innerHTML = '<div class="detail-muted">Загружаем подробности…</div>';
      try {
        const params = new URLSearchParams({ game: button.dataset.game, id: button.dataset.id });
        const response = await fetch(`/api/tournament?${params}`); const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить подробности.');
        panel.innerHTML = tournamentDetailMarkup(payload); panel.dataset.loaded = 'true';
        const wikiItems = panel.querySelector('.liquipedia-items');
        if (payload.liquipediaConfigured) {
          const wikiParams = new URLSearchParams({ game: button.dataset.game, q: payload.tournament?.name || button.closest('.tournament-card').querySelector('h3').textContent });
          try {
            const wikiResponse = await fetch(`/api/liquipedia?${wikiParams}`); const wikiPayload = await wikiResponse.json();
            if (!wikiResponse.ok) throw new Error(wikiPayload.error || 'Liquipedia временно недоступна.');
            wikiItems.innerHTML = wikiPayload.results?.length ? wikiPayload.results.map(item => `<a class="liquipedia-result" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(item.title)}</strong>${item.snippet ? `<span>${escapeHtml(item.snippet)}</span>` : ''}</a>`).join('') : '<span class="detail-muted">Страница по этому названию не найдена.</span>';
          } catch (error) { wikiItems.innerHTML = `<span class="detail-muted">${escapeHtml(error.message)}</span>`; }
        } else {
          const wiki = button.dataset.game === 'dota2' ? 'dota2' : 'counterstrike';
          const searchUrl = `https://liquipedia.net/${wiki}/index.php?search=${encodeURIComponent(payload.tournament?.name || '')}`;
          wikiItems.innerHTML = `<span class="detail-muted">Добавьте LIQUIPEDIA_CONTACT в переменные Render, чтобы включить поиск в приложении.</span><a class="liquipedia-result" href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener noreferrer"><strong>Открыть поиск на Liquipedia ↗</strong></a>`;
        }
      } catch (error) { panel.innerHTML = `<p class="detail-muted">${escapeHtml(error.message)}</p>`; }
    }
  } else { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); button.innerHTML = 'Составы, сетка и результаты <span>＋</span>'; }
}
tournamentList.addEventListener('click', toggleTournamentDetails);
