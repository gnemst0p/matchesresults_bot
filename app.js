const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.themeParams?.bg_color) document.documentElement.style.setProperty('--bg', tg.themeParams.bg_color);
if (tg?.initDataUnsafe?.user) document.getElementById('avatar').textContent = (tg.initDataUnsafe.user.first_name || 'G').slice(0, 1).toUpperCase();

const state = { game: 'all', status: 'live', busy: false, date: moscowToday(), tournamentStatus: 'running' };
const list = document.getElementById('match-list');
const notice = document.getElementById('notice');
const titles = { live: 'Идут прямо сейчас', upcoming: 'Предстоящие матчи', past: 'Завершённые матчи' };
const labels = { live: 'LIVE · СЕЙЧАС', upcoming: 'РАСПИСАНИЕ', past: 'РЕЗУЛЬТАТЫ' };
const matchSection = document.getElementById('match-section');
const tournamentSection = document.getElementById('tournament-section');
const tournamentList = document.getElementById('tournament-list');
const tournamentNotice = document.getElementById('tournament-notice');

function moscowToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shiftDate(value, offset) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
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
async function loadMatches() {
  if (state.busy) return;
  state.busy = true;
  const refresh = document.getElementById('refresh'); refresh.classList.add('spinning');
  if (state.status === 'tournaments') { state.busy = false; refresh.classList.remove('spinning'); return loadTournaments(); }
  matchSection.hidden = false; tournamentSection.hidden = true;
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
    const matches = payload.matches || [];
    document.getElementById('live-count').textContent = state.status === 'live' ? matches.length : '·';
    if (!matches.length) showEmpty();
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

document.querySelectorAll('.game-tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.game-tab').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', tab === button ? 'true' : 'false'); });
  state.game = button.dataset.game; loadMatches();
}));
document.querySelectorAll('.status-tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.status-tab').forEach(tab => tab.classList.toggle('active', tab === button));
  state.status = button.dataset.status;
  document.getElementById('match-list').innerHTML = '';
  if (state.status === 'tournaments') loadTournaments(); else loadMatches();
}));
document.getElementById('refresh').addEventListener('click', loadMatches);
function teamRosterMarkup(payload, game, teamName) {
  const players = valuesOf(payload.players);
  if (!players.length) return `<strong>${escapeHtml(teamName)}</strong><p class="detail-muted">Состав пока не опубликован в PandaScore.</p>`;
  const sourceNote = payload.source === 'tournament' ? 'Состав на этом турнире' : 'Состав команды по данным PandaScore';
  const site = game === 'dota2' ? 'Liquipedia' : 'HLTV';
  const siteUrl = game === 'dota2' ? 'https://liquipedia.net/dota2/index.php?search=' : 'https://www.hltv.org/search?query=';
  return `<div class="team-roster-heading"><strong>${escapeHtml(teamName)}</strong><span>${sourceNote}</span></div><ul class="team-roster-players">${players.map(player => {
    const nickname = player.name || player.nickname || player.slug || player.full_name || 'Игрок';
    const role = player.role || player.position;
    const href = `${siteUrl}${encodeURIComponent(nickname)}`;
    return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(nickname)} ↗</a>${role ? `<span>${escapeHtml(role)}</span>` : ''}</li>`;
  }).join('')}</ul><span class="roster-source">Профили игроков откроются в ${site}.</span>`;
}
list.addEventListener('click', async event => {
  const teamButton = event.target.closest('.team-open');
  if (teamButton) {
    const panel = document.getElementById(teamButton.dataset.panelId);
    const expanded = teamButton.getAttribute('aria-expanded') === 'true';
    teamButton.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
    if (expanded) return;
    if (panel.dataset.loaded) return;
    panel.innerHTML = '<span class="detail-muted">Загружаем состав…</span>';
    try {
      const params = new URLSearchParams({ game: teamButton.dataset.game, id: teamButton.dataset.teamId });
      if (teamButton.dataset.tournamentId) params.set('tournament', teamButton.dataset.tournamentId);
      const response = await fetch(`/api/team?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить состав.');
      panel.innerHTML = teamRosterMarkup(payload, teamButton.dataset.game, teamButton.dataset.teamName);
      panel.dataset.loaded = 'true';
    } catch (error) {
      panel.innerHTML = `<span class="detail-muted">${escapeHtml(error.message)}</span>`;
    }
    return;
  }
  const button = event.target.closest('.details-toggle');
  if (!button) return;
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  panel.hidden = expanded;
  button.innerHTML = expanded ? 'Подробнее <span aria-hidden="true">＋</span>' : 'Скрыть <span aria-hidden="true">−</span>';
});
loadMatches();
setInterval(loadMatches, 60_000);

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
  const rows = valuesOf(brackets);
  const data = rows.length ? rows : valuesOf(matches);
  if (!data.length) return '<p class="detail-muted">Сетка для этого турнира не опубликована.</p>';
  return `<div class="bracket-list">${data.map((row, index) => {
    const match = row.match || row;
    const teams = valuesOf(match.opponents).map(op => op.opponent?.name || op.name).filter(Boolean);
    const score = valuesOf(match.opponents).map((op, opponentIndex) => scoreOf(match, op, opponentIndex)).filter(value => value != null).join(' : ');
    const previous = valuesOf(match.previous_matches).map(item => `${item.type === 'loser' ? 'Проигравший' : 'Победитель'} матча ${item.match_id}`).filter(Boolean);
    const title = match.name || match.round || match.stage || `Матч ${index + 1}`;
    const time = match.begin_at || match.scheduled_at;
    return `<div class="bracket-match"><span>${escapeHtml(title)}</span><strong>${escapeHtml(teams.join(' — ') || previous.join(' — ') || 'Участники уточняются')}${score ? ` · ${escapeHtml(score)}` : ''}</strong><small>${escapeHtml(time ? tournamentDate(time) : (match.status || ''))}</small></div>`;
  }).join('')}</div>`;
}
function tournamentDetailMarkup(data) {
  const t = data.tournament || {};
  const items = [['Организатор', t.organizer], ['Формат', t.tournament_type || t.type], ['Призовой фонд', t.prizepool || t.prize_pool], ['Участники', t.expected_roster?.length ? `${t.expected_roster.length} команд` : null], ['Сетка', t.has_bracket ? 'Опубликована' : null]].filter(([, value]) => value);
  return `<div class="tournament-info">${items.map(([label, value]) => `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div><h4>Составы команд</h4>${rosterMarkup(data.rosters, t.expected_roster)}<h4>Турнирная таблица</h4>${standingsMarkup(data.standings)}<h4>Сетка и матчи</h4>${bracketMarkup(data.brackets, data.matches)}<div class="liquipedia-results"><h4>Справка Liquipedia</h4><div class="liquipedia-items"><span class="detail-muted">Ищем страницу турнира…</span></div><small>Источник: <a href="https://liquipedia.net/api-terms-of-use" target="_blank" rel="noopener noreferrer">Liquipedia</a>, лицензия CC BY-SA 3.0.</small></div><p class="data-credit">Матчи и турнирные данные: PandaScore.</p>`;
}
async function loadTournaments() {
  matchSection.hidden = true; tournamentSection.hidden = false;
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
  document.getElementById('match-date').value = state.date;
  document.querySelectorAll('.date-shortcut').forEach(item => item.classList.toggle('active', item === button));
  list.innerHTML = ''; loadMatches();
}));
const dateInput = document.getElementById('match-date');
dateInput.value = state.date;
dateInput.addEventListener('change', () => {
  if (!dateInput.value) return;
  state.date = dateInput.value;
  document.querySelectorAll('.date-shortcut').forEach(button => button.classList.toggle('active', shiftDate(moscowToday(), Number(button.dataset.offset)) === state.date));
  list.innerHTML = ''; loadMatches();
});
document.querySelectorAll('.tournament-tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tournament-tab').forEach(tab => tab.classList.toggle('active', tab === button));
  state.tournamentStatus = button.dataset.tournamentStatus; tournamentList.innerHTML = ''; loadTournaments();
}));
tournamentList.addEventListener('click', async event => {
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
});
