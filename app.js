const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
if (tg?.themeParams?.bg_color) document.documentElement.style.setProperty('--bg', tg.themeParams.bg_color);
if (tg?.initDataUnsafe?.user) document.getElementById('avatar').textContent = (tg.initDataUnsafe.user.first_name || 'G').slice(0, 1).toUpperCase();

const state = { game: 'all', status: 'live', busy: false };
const list = document.getElementById('match-list');
const notice = document.getElementById('notice');
const titles = { live: 'Идут прямо сейчас', upcoming: 'Ближайшие матчи', past: 'Последние результаты' };
const labels = { live: 'LIVE · СЕЙЧАС', upcoming: 'СКОРО НА ЭКРАНАХ', past: 'ФИНАЛЬНЫЙ СЧЁТ' };

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
function scoreOf(opponent) { return opponent?.score ?? opponent?.result?.score ?? null; }
function teamMarkup(team, side) {
  const name = team?.opponent?.name || (side === 'left' ? 'Команда 1' : 'Команда 2');
  const image = team?.opponent?.image_url;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return `<div class="team ${side}">${image ? `<img class="team-logo" data-initials="${escapeHtml(initials)}" src="${escapeHtml(image)}" alt="" loading="lazy">` : `<span class="team-logo team-fallback">${escapeHtml(initials)}</span>`}<span class="team-name">${escapeHtml(name)}</span></div>`;
}
function cardMarkup(match) {
  const opponents = match.opponents || [];
  const [first, second] = opponents;
  const scoresReady = first && second && (scoreOf(first) !== null || scoreOf(second) !== null);
  const scores = scoresReady ? `<span class="score">${escapeHtml(scoreOf(first) ?? 0)}<span class="separator">:</span>${escapeHtml(scoreOf(second) ?? 0)}</span>` : '<span class="score pending">VS</span>';
  const tournament = match.tournament?.name || match.league?.name || match.serie?.full_name || 'Матч';
  const round = match.number_of_games ? `BO${match.number_of_games}` : (match.tournament?.name || 'Матч');
  const date = dateOf(match);
  const live = state.status === 'live';
  const klass = live ? 'live-card' : state.status === 'past' ? 'finished-card' : 'scheduled-card';
  const game = match.game === 'cs2' ? 'CS2' : 'DOTA 2';
  const status = live ? '● LIVE' : state.status === 'past' ? 'ЗАВЕРШЁН' : 'НАЧАЛО';
  const center = live || state.status === 'past' ? scores : `<span class="score pending">${date ? escapeHtml(new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', hour:'2-digit', minute:'2-digit' }).format(new Date(date))) : 'TBA'}</span>`;
  return `<article class="match-card ${klass}"><span class="match-status">${status}</span>${teamMarkup(first,'left')}<div class="scoreline">${center}<div class="series">${escapeHtml(round.toUpperCase())}</div><div class="match-meta">${game} · ${escapeHtml(tournament)}</div></div>${teamMarkup(second,'right')}</article>`;
}
function showLoading() { list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>'; }
function showEmpty() {
  const descriptions = { live: 'Как только начнётся матч, он появится здесь.', upcoming: 'Новых матчей пока нет. Загляните чуть позже.', past: 'Завершённые матчи появятся здесь после игры.' };
  list.innerHTML = `<div class="empty"><div class="empty-icon">◉</div>${descriptions[state.status]}</div>`;
}
async function loadMatches() {
  if (state.busy) return;
  state.busy = true;
  const refresh = document.getElementById('refresh'); refresh.classList.add('spinning');
  document.getElementById('section-title').textContent = titles[state.status];
  document.getElementById('date-label').textContent = labels[state.status];
  notice.classList.add('hidden');
  if (!list.children.length || list.querySelector('.empty')) showLoading();
  try {
    const params = new URLSearchParams({ game: state.game, status: state.status });
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
      document.getElementById('date-label').textContent = shortDate(dateOf(matches[0])) + (state.status === 'live' ? ' · LIVE' : '');
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
  state.status = button.dataset.status; list.innerHTML = ''; loadMatches();
}));
document.getElementById('refresh').addEventListener('click', loadMatches);
loadMatches();
setInterval(loadMatches, 60_000);
