// Клиентская логика: авторизация, каталог знаний, документы ПТО,
// комплектность ИД, замечания, отчёты, уведомления и профиль.
const API_BASE = '/api';

const ROLES = ['Монтажник', 'Старший монтажник', 'Инженер ПТО', 'Администратор'];

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

const state = {
  user: null,
  csrfToken: '',
  permissions: { admin: false, content: false, pto: false },
  vidy: [],
  raboty: [],
  articles: [],
  objects: [],
  ptoMeta: { types: [], statuses: [], closedStatuses: [], objects: [], canManage: false },
  ptoDocs: [],
  users: [],
  objectsForAdmin: [],
  remarkStatuses: [],
  remarks: [],
  report: null,
  searchQuery: '',
  filterVid: 'all',
  ptoFilters: { type: 'all', objectId: 'all', status: 'all', q: '', overdue: false },
  remarkFilters: { status: 'all', objectId: 'all', q: '', overdue: false },
  ptoLoadId: 0
};

const $ = (id) => document.getElementById(id);

// --- Утилиты ---

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '—';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value);
}

function formatDateTime(value) {
  if (!value) return '—';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : formatDate(value);
}

function todayIso() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

function toast(message, type = 'ok') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.textContent = message;
  container.appendChild(item);
  setTimeout(() => item.remove(), type === 'error' ? 7000 : 4000);
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message;
  element.classList.remove('hidden');
}

// --- Сеть ---

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  if (response.status === 401) {
    forceLogin('Сессия истекла, войдите заново');
    throw new AuthError(401, 'Требуется авторизация');
  }
  return response;
}

async function apiJson(url, options = {}) {
  const response = await apiFetch(url, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { success: false, error: text }; }

  if (!response.ok) {
    const error = new Error((data && data.error) || `Ошибка ${response.status}`);
    error.status = response.status;
    error.details = data && data.details;
    error.requestId = data && data.requestId;
    throw error;
  }

  return data;
}

async function apiJsonSafe(url, options = {}) {
  try {
    return await apiJson(url, options);
  } catch (error) {
    if (error instanceof AuthError) return null;
    console.error('API error', url, error.message);
    toast(error.message, 'error');
    return null;
  }
}

// --- Авторизация ---

function forceLogin(message) {
  sessionStorage.removeItem('current_user');
  if (message) sessionStorage.setItem('login_notice', message);
  // Новый документ очищает также результаты поиска, модальные окна и незавершённые запросы прежнего сеанса.
  window.location.reload();
}

function applyRoleVisibility() {
  const canManagePto = state.permissions.pto;
  document.querySelectorAll('[data-permission]').forEach((element) => {
    element.hidden = !state.permissions[element.dataset.permission];
  });
  $('show-add-doc').classList.toggle('hidden', !canManagePto);
  $('show-import').classList.toggle('hidden', !canManagePto);
  $('show-add-object').classList.toggle('hidden', !canManagePto);
  $('show-add-set').classList.toggle('hidden', !canManagePto);
  $('show-add-remark').classList.toggle('hidden', !canManagePto);
}

function renderUserHeader() {
  if (!state.user) return;
  const names = state.user.fullName.split(/\s+/);
  $('profile-btn').textContent = names.slice(0, 2).map((part) => part[0]).join('');
  $('profile-btn').title = state.user.fullName + ' · ' + state.user.role;
  $('dashboard-role').textContent = state.user.role;
  $('greeting').textContent = 'Здравствуйте, ' + (names[1] || names[0]);
  $('today').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' }).format(new Date());
  $('article-author').textContent = state.user.fullName;
}

async function handleLogin(event) {
  event.preventDefault();
  $('login-error').classList.add('hidden');

  const tabNumber = $('tab-number').value.trim();
  const password = $('password').value;

  if (!tabNumber || !password) {
    showError($('login-error'), 'Введите табельный номер и пароль');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabNumber, password })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      showError($('login-error'), data.error || 'Ошибка авторизации');
      return;
    }

    state.user = data.user;
    state.csrfToken = data.csrfToken || '';
    state.permissions = data.permissions || {
      admin: data.user.role === 'Администратор',
      content: ['Администратор', 'Старший монтажник'].includes(data.user.role),
      pto: ['Администратор', 'Инженер ПТО'].includes(data.user.role)
    };
    sessionStorage.setItem('current_user', JSON.stringify(data.user));
    await showApp();
  } catch (error) {
    console.error('Ошибка авторизации:', error);
    showError($('login-error'), 'Ошибка подключения к серверу. Попробуйте позже.');
  }
}

async function handleLogout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: state.csrfToken ? { 'X-CSRF-Token': state.csrfToken } : {}
    });
  } catch (error) {
    console.error('Ошибка выхода:', error);
  }

  forceLogin(null);
}

async function showApp() {
  $('login-page').classList.add('hidden');
  $('app-page').classList.remove('hidden');

  renderUserHeader();
  applyRoleVisibility();

  await Promise.all([loadVidyRabot(), loadRaboty(), loadArticles(), loadPtoMeta()]);
  await loadPtoObjects();

  navigateTo('dashboard');
  refreshNotificationBadge();
}

// --- Навигация ---

const PAGES = {
  dashboard: 'dashboard-page',
  tasks: 'tasks-page',
  objects: 'objects-page',
  executive: 'pto-page',
  instructions: 'instructions-page',
  about: 'about-page',
  pto: 'pto-page',
  completeness: 'completeness-page',
  remarks: 'remarks-page',
  reports: 'reports-page',
  catalog: 'catalog-page',
  'add-article': 'add-article-page',
  'vidy-rabot': 'vidy-rabot-page',
  raboty: 'raboty-page',
  users: 'users-page'
};

async function navigateTo(page) {
  if (!state.user) return;

  const selected = $('nav-' + page);
  if (!selected || selected.closest('[hidden]')) return;
  const previous = state.currentPage;
  if (previous === 'executive' && page !== previous) state.ptoFilters.type = state.registryType || 'all';
  if (page === 'executive' && page !== previous) state.registryType = state.ptoFilters.type;
  state.currentPage = page;
  $('section-title').textContent = selected.textContent.trim();
  hideSearch();
  document.querySelectorAll('.nav-btn').forEach((button) => {
    if (button === selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  Object.values(PAGES).forEach((id) => $(id).classList.add('hidden'));

  const target = PAGES[page] || PAGES.dashboard;
  $(target).classList.remove('hidden');

  const heading = $(target).querySelector('h1');
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  if (page === 'pto' || page === 'executive') {
    const executive = page === 'executive';
    if (executive) state.ptoFilters.type = 'Исполнительная документация';
    $('pto-filter-type').value = state.ptoFilters.type;
    $('pto-filter-type').disabled = executive;
    heading.textContent = executive ? 'Исполнительная документация' : 'Реестр документов ПТО';
  }

  switch (page) {
    case 'about':
      await loadProjectPhotos();
      break;
    case 'objects':
      await loadPtoObjects();
      renderObjects();
      break;
    case 'instructions':
      fillInstructionKinds();
      renderInstructions();
      break;
    case 'executive':
      await loadPtoObjects();
      break;
    case 'dashboard':
      await loadDashboard();
      break;
    case 'tasks':
      await taskUI.load();
      break;
    case 'pto':
      await loadPtoObjects();
      renderPtoStats();
      renderPtoTable();
      renderObjects();
      break;
    case 'completeness':
      await loadCompleteness();
      break;
    case 'remarks':
      await loadRemarks();
      break;
    case 'reports':
      await loadReport();
      break;
    case 'catalog':
      renderArticles();
      break;
    case 'add-article':
      populateRabotySelect();
      break;
    case 'vidy-rabot':
      renderVidyRabot();
      break;
    case 'raboty':
      populateFilterRabotyVid();
      renderRaboty();
      break;
    case 'users':
      await loadUsers();
      break;
    default:
      break;
  }

  if (state.currentPage === page) window.scrollTo(0, 0);
}

// --- Каталог знаний ---

async function loadVidyRabot() {
  const data = await apiJsonSafe(`${API_BASE}/vidy-rabot`);
  state.vidy = data ? data.data : [];

  const filter = $('filter-vid');
  if (filter) {
    filter.innerHTML = '<option value="all">Все виды работ</option>' +
      state.vidy.map((vid) => `<option value="${vid.id}">${escapeHtml(vid.name)}</option>`).join('');
  }
}

async function loadRaboty() {
  const data = await apiJsonSafe(`${API_BASE}/raboty`);
  state.raboty = data ? data.data : [];
}

async function loadArticles() {
  const data = await apiJsonSafe(`${API_BASE}/articles`);
  state.articles = data ? data.data : [];
  renderArticles();
}

function renderArticles() {
  const container = $('articles-list');
  const statsContainer = $('catalog-stats');
  if (!container) return;

  const query = state.searchQuery.toLowerCase();
  const filtered = state.articles.filter((article) => {
    const matchesSearch = !query ||
      (article.title || '').toLowerCase().includes(query) ||
      (article.content || '').toLowerCase().includes(query) ||
      (article.keywords || '').toLowerCase().includes(query) ||
      (article.vidName || '').toLowerCase().includes(query) ||
      (article.rabotaName || '').toLowerCase().includes(query);

    const matchesVid = state.filterVid === 'all' ||
      (article.rabotaId && state.raboty.find((work) => work.id === article.rabotaId && String(work.vidId) === String(state.filterVid)));

    return matchesSearch && matchesVid;
  });

  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="stat-card"><div class="number">${state.articles.length}</div><div class="label">Всего статей</div></div>
      <div class="stat-card"><div class="number blue">${state.vidy.length}</div><div class="label">Видов работ</div></div>
      <div class="stat-card"><div class="number green">${state.raboty.length}</div><div class="label">Работ</div></div>
      <div class="stat-card"><div class="number yellow">${filtered.length}</div><div class="label">Найдено</div></div>
    `;
  }

  if (!filtered.length) {
    container.innerHTML = '<div class="no-articles"><h3>Статьи не найдены</h3><p>Попробуйте изменить параметры поиска или фильтры</p></div>';
    return;
  }

  const renderCard = (article) => `
    <details class="article-card">
      <summary class="article-header">
        <div class="article-header-content">
          <div class="article-badges">
            ${article.vidName ? `<span class="badge badge-vid">${escapeHtml(article.vidName)}</span>` : ''}
            ${article.rabotaName ? `<span class="badge badge-rabota">${escapeHtml(article.rabotaName)}</span>` : ''}
            ${article.file ? '<span class="pdf-badge">PDF</span>' : ''}
          </div>
          <h3 class="article-title">${escapeHtml(article.title)}</h3>
          <div class="article-meta">
            <span>${escapeHtml(article.authorName || 'Неизвестен')}</span>
            <span>${formatDate(article.publishDate)}</span>
            <span>Обновлено: ${formatDate(article.updatedAt)}</span>
          </div>
        </div>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div class="article-content">
        <div class="article-text">${escapeHtml(article.content || '')}</div>
        ${article.keywords ? `<div class="article-keywords">${article.keywords.split(',').map((word) => `<span>${escapeHtml(word.trim())}</span>`).join('')}</div>` : ''}
        ${article.file ? `
          <div class="pdf-viewer-section">
            <div class="pdf-viewer-header"><h4>Документ</h4></div>
            <div class="pdf-actions">
              <a href="${escapeAttr(article.file)}" target="_blank" rel="noopener" class="pdf-download-btn">📄 Открыть файл</a>
              <a href="${escapeAttr(article.file)}" download class="pdf-download-btn">Скачать</a>
            </div>
          </div>` : ''}
        ${state.permissions.content ? `
          <div class="article-actions">
            <button class="btn btn-secondary btn-sm" onclick="openEditArticle(${article.id})">✏️ Редактировать</button>
            ${state.permissions.admin ? `<button class="btn btn-danger btn-sm" onclick="confirmDeleteArticle(${article.id})">Удалить</button>` : ''}
          </div>` : ''}
      </div>
    </details>`;
  const groups = new Map();
  for (const article of filtered) {
    const kind = article.vidName || 'Без вида работ';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(article);
  }
  container.innerHTML = [...groups].map(([kind, articles]) => `
    <section class="material-group"><h2>${escapeHtml(kind)}</h2>
      ${articles.map(renderCard).join('')}
    </section>`).join('');
}

function openArticleModal(id) {
  const article = state.articles.find((item) => item.id === id);
  if (!article) return;

  openModal(`
    <div class="article-badges">
      ${article.vidName ? `<span class="badge badge-vid">${escapeHtml(article.vidName)}</span>` : ''}
      ${article.rabotaName ? `<span class="badge badge-rabota">${escapeHtml(article.rabotaName)}</span>` : ''}
    </div>
    <h2>${escapeHtml(article.title)}</h2>
    <div class="article-meta">
      <span>${escapeHtml(article.authorName || 'Неизвестен')}</span>
      <span>${formatDate(article.publishDate)}</span>
    </div>
    <div class="article-text">${escapeHtml(article.content || '')}</div>
    ${article.file ? `<div class="modal-actions-row"><a class="btn btn-secondary" href="${escapeAttr(article.file)}" target="_blank" rel="noopener">Открыть файл</a></div>` : ''}
  `);
}

function openModal(html) {
  $('modal-body').innerHTML = html;
  $('article-modal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal() {
  $('article-modal').classList.add('hidden');
  $('modal-body').innerHTML = '';
  document.body.classList.remove('modal-open');
}

function rabotaOptions(selectedId) {
  return state.raboty.map((work) => `
    <option value="${work.id}" ${Number(work.id) === Number(selectedId) ? 'selected' : ''}>${escapeHtml(work.name)} (${escapeHtml(work.vidName || 'без вида')})</option>
  `).join('');
}

function vidOptions(selectedId) {
  return state.vidy.map((vid) => `
    <option value="${vid.id}" ${Number(vid.id) === Number(selectedId) ? 'selected' : ''}>${escapeHtml(vid.name)}</option>
  `).join('');
}

function populateRabotySelect() {
  const select = $('article-rabota');
  if (!select) return;
  select.innerHTML = '<option value="">Выберите работу</option>' + rabotaOptions(null);
}

async function handleAddArticle(event) {
  event.preventDefault();

  const title = $('article-title').value.trim();
  const rabotaId = $('article-rabota').value;
  const keywords = $('article-keywords').value.trim();
  const content = $('article-content').value.trim();
  const file = $('article-pdf').files[0];

  $('article-success').classList.add('hidden');
  $('article-error').classList.add('hidden');

  if (!title || !rabotaId || !content) {
    showError($('article-error'), 'Заполните обязательные поля: название, работа, текст статьи');
    return;
  }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('rabotaId', rabotaId);
  formData.append('keywords', keywords);
  formData.append('content', content);
  if (file) formData.append('pdfFile', file);

  try {
    await apiJson(`${API_BASE}/articles`, { method: 'POST', body: formData });
    $('article-success').textContent = 'Статья опубликована';
    $('article-success').classList.remove('hidden');

    ['article-title', 'article-keywords', 'article-content'].forEach((id) => { $(id).value = ''; });
    $('article-rabota').value = '';
    $('article-pdf').value = '';
    $('char-count').textContent = '0';
    $('file-upload-text').textContent = 'Выберите PDF-файл или перетащите сюда';
    document.querySelector('.file-upload-label').classList.remove('has-file');
    $('clear-pdf').classList.add('hidden');

    await loadArticles();
  } catch (error) {
    if (error instanceof AuthError) return;
    showError($('article-error'), error.message);
  }
}

function openEditArticle(id) {
  const article = state.articles.find((item) => item.id === id);
  if (!article) return;

  openModal(`
    <h2>Редактировать статью</h2>
    <form id="edit-article-form" class="modal-form">
      <div class="form-group">
        <label for="edit-article-title">Название <span class="required">*</span></label>
        <input type="text" id="edit-article-title" value="${escapeAttr(article.title)}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="edit-article-rabota">Работа <span class="required">*</span></label>
          <select id="edit-article-rabota" required>${rabotaOptions(article.rabotaId)}</select>
        </div>
        <div class="form-group">
          <label for="edit-article-keywords">Ключевые слова</label>
          <input type="text" id="edit-article-keywords" value="${escapeAttr(article.keywords || '')}">
        </div>
      </div>
      <div class="form-group">
        <label for="edit-article-content">Текст статьи <span class="required">*</span></label>
        <textarea id="edit-article-content" rows="10" required>${escapeHtml(article.content || '')}</textarea>
      </div>
      <div class="form-group">
        <label for="edit-article-file">Заменить файл</label>
        <input type="file" id="edit-article-file" accept=".pdf,.doc,.docx,.xls,.xlsx">
        ${article.file ? `<span class="field-hint">Текущий файл: <a href="${escapeAttr(article.file)}" target="_blank" rel="noopener">открыть</a></span>` : ''}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `);

  $('edit-article-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const formData = new FormData();
    formData.append('title', $('edit-article-title').value.trim());
    formData.append('rabotaId', $('edit-article-rabota').value);
    formData.append('keywords', $('edit-article-keywords').value.trim());
    formData.append('content', $('edit-article-content').value.trim());
    const file = $('edit-article-file').files[0];
    if (file) formData.append('pdfFile', file);

    try {
      await apiJson(`${API_BASE}/articles/${article.id}`, { method: 'PUT', body: formData });
      closeModal();
      await loadArticles();
      toast('Статья сохранена');
    } catch (error) {
      if (error instanceof AuthError) return;
      toast(error.message, 'error');
    }
  });
}

async function confirmDeleteArticle(id) {
  if (!confirm('Удалить статью? Действие необратимо.')) return;

  try {
    await apiJson(`${API_BASE}/articles/${id}`, { method: 'DELETE' });
    await loadArticles();
    toast('Статья удалена');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

// --- Справочники: виды работ и работы ---

function renderVidyRabot() {
  const container = $('vidy-rabot-list');
  const empty = $('vidy-rabot-empty');
  if (!container) return;

  if (!state.vidy.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.innerHTML = state.vidy.map((vid) => `
    <tr>
      <td class="user-id">#${vid.id}</td>
      <td>${escapeHtml(vid.name)}</td>
      <td><button class="action-btn delete" onclick="deleteVid(${vid.id})" title="Удалить">Удалить</button></td>
    </tr>
  `).join('');
}

async function handleAddVidRabot(event) {
  event.preventDefault();
  const errorEl = $('vid-form-error');
  const successEl = $('vid-form-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  try {
    await apiJson(`${API_BASE}/vidy-rabot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('new-vid-name').value.trim() })
    });

    $('new-vid-name').value = '';
    successEl.textContent = 'Вид работ добавлен';
    successEl.classList.remove('hidden');
    await loadVidyRabot();
    renderVidyRabot();
  } catch (error) {
    if (error instanceof AuthError) return;
    showError(errorEl, error.message);
  }
}

async function deleteVid(id) {
  if (!confirm('Удалить вид работ?')) return;
  try {
    await apiJson(`${API_BASE}/vidy-rabot/${id}`, { method: 'DELETE' });
    await loadVidyRabot();
    renderVidyRabot();
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

function populateVidSelectForRabota() {
  const select = $('new-rabota-vid');
  if (!select) return;
  select.innerHTML = '<option value="">Выберите вид работ</option>' + vidOptions(null);
}

function populateFilterRabotyVid() {
  const select = $('filter-raboty-vid');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="all">Все виды работ</option>' + state.vidy.map((vid) => `<option value="${vid.id}">${escapeHtml(vid.name)}</option>`).join('');
  select.value = current || 'all';
}

function renderRaboty() {
  const container = $('raboty-list');
  const empty = $('raboty-empty');
  if (!container) return;

  const search = ($('search-raboty')?.value || '').toLowerCase();
  const filterVid = $('filter-raboty-vid')?.value || 'all';

  const filtered = state.raboty.filter((work) => {
    const matchesSearch = !search || (work.name || '').toLowerCase().includes(search);
    const matchesVid = filterVid === 'all' || String(work.vidId) === String(filterVid);
    return matchesSearch && matchesVid;
  });

  if (!filtered.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.innerHTML = filtered.map((work) => `
    <div class="rabota-card" data-id="${work.id}">
      <div class="rabota-header" onclick="toggleRabota(${work.id})">
        <div>
          <span class="badge badge-vid">${escapeHtml(work.vidName || 'Без вида')}</span>
          <h3>${escapeHtml(work.name)}</h3>
        </div>
        <span class="article-expand-icon">▼</span>
      </div>
      <div class="rabota-content">
        ${work.description ? `<p>${escapeHtml(work.description)}</p>` : ''}
        ${work.instruction ? `<div class="article-text">${escapeHtml(work.instruction)}</div>` : ''}
        <div class="article-actions">
          <button class="btn btn-secondary btn-sm" onclick="openEditRabota(${work.id})">✏️ Редактировать</button>
          <button class="btn btn-danger btn-sm" onclick="deleteRabota(${work.id})">Удалить</button>
        </div>
      </div>
    </div>
  `).join('');
}

function toggleRabota(id) {
  const card = document.querySelector(`.rabota-card[data-id="${id}"]`);
  if (card) card.classList.toggle('expanded');
}

async function handleAddRabota(event) {
  event.preventDefault();
  const errorEl = $('rabota-form-error');
  const successEl = $('rabota-form-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const payload = {
    name: $('new-rabota-name').value.trim(),
    vidId: $('new-rabota-vid').value,
    description: $('new-rabota-description').value.trim(),
    instruction: $('new-rabota-instruction').value.trim()
  };

  if (!payload.name || !payload.vidId) {
    showError(errorEl, 'Заполните название и вид работ');
    return;
  }

  try {
    await apiJson(`${API_BASE}/raboty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    ['new-rabota-name', 'new-rabota-description', 'new-rabota-instruction'].forEach((id) => { $(id).value = ''; });
    $('new-rabota-vid').value = '';
    successEl.textContent = 'Работа добавлена';
    successEl.classList.remove('hidden');

    await loadRaboty();
    renderRaboty();
    populateRabotySelect();
  } catch (error) {
    if (error instanceof AuthError) return;
    showError(errorEl, error.message);
  }
}

function openEditRabota(id) {
  const work = state.raboty.find((item) => item.id === id);
  if (!work) return;

  openModal(`
    <h2>Редактировать работу</h2>
    <form id="edit-rabota-form" class="modal-form">
      <div class="form-row">
        <div class="form-group">
          <label for="edit-rabota-name">Название <span class="required">*</span></label>
          <input type="text" id="edit-rabota-name" value="${escapeAttr(work.name)}" required>
        </div>
        <div class="form-group">
          <label for="edit-rabota-vid">Вид работ <span class="required">*</span></label>
          <select id="edit-rabota-vid" required>${vidOptions(work.vidId)}</select>
        </div>
      </div>
      <div class="form-group">
        <label for="edit-rabota-description">Описание</label>
        <textarea id="edit-rabota-description" rows="3">${escapeHtml(work.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label for="edit-rabota-instruction">Инструкция</label>
        <textarea id="edit-rabota-instruction" rows="8">${escapeHtml(work.instruction || '')}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `);

  $('edit-rabota-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      await apiJson(`${API_BASE}/raboty/${work.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('edit-rabota-name').value.trim(),
          vidId: $('edit-rabota-vid').value,
          description: $('edit-rabota-description').value.trim(),
          instruction: $('edit-rabota-instruction').value.trim()
        })
      });

      closeModal();
      await loadRaboty();
      renderRaboty();
      toast('Работа сохранена');
    } catch (error) {
      if (error instanceof AuthError) return;
      toast(error.message, 'error');
    }
  });
}

async function deleteRabota(id) {
  if (!confirm('Удалить работу? Если к ней привязаны статьи, удаление будет отклонено.')) return;
  try {
    await apiJson(`${API_BASE}/raboty/${id}`, { method: 'DELETE' });
    await loadRaboty();
    renderRaboty();
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

// --- Сотрудники ---

async function loadUsers() {
  const container = $('users-list');

  try {
    const data = await apiJson(`${API_BASE}/sotrudniki`);
    state.users = data ? data.data : [];
    renderUsers();
  } catch (error) {
    if (error instanceof AuthError) return;

    // Не оставляем пустую таблицу: администратор должен видеть причину
    // и иметь возможность повторить загрузку без перезагрузки страницы.
    state.users = [];
    if (container) {
      container.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="empty-state">
              <h3>Не удалось загрузить список сотрудников</h3>
              <p>${escapeHtml(error.message)}</p>
              <button type="button" class="action-btn" onclick="loadUsers()">Повторить</button>
            </div>
          </td>
        </tr>`;
    }
    toast(error.message, 'error');
  }
}

function renderUsers() {
  const container = $('users-list');
  if (!container) return;

  container.innerHTML = (state.users || []).map((user) => `
    <tr class="${state.user && user.id === state.user.id ? 'current-user' : ''}">
      <td class="user-id">#${user.id}</td>
      <td>
        <div class="user-cell">
          <div class="user-avatar">${escapeHtml((user.fullName || '?').charAt(0))}</div>
          <div>
            <div class="user-cell-name">${escapeHtml(user.fullName)}</div>
            ${state.user && user.id === state.user.id ? '<div class="user-cell-you">(Вы)</div>' : ''}
            ${user.blocked ? '<div class="user-cell-you">заблокирован</div>' : ''}
          </div>
        </div>
      </td>
      <td class="user-tabnumber">${escapeHtml(user.tabNumber)}</td>
      <td>
        <select class="role-select" onchange="changeRole(${user.id}, this.value)">
          ${ROLES.map((role) => `<option value="${escapeAttr(role)}" ${user.role === role ? 'selected' : ''}>${escapeHtml(role)}</option>`).join('')}
        </select>
      </td>
      <td class="user-access">${(user.objectIds || []).length ? `${user.objectIds.length} объектов` : 'нет доступа'}</td>
      <td>
        <div class="actions-cell">
          <button class="action-btn edit" onclick="openAccessModal(${user.id})" title="Доступ к объектам">Объекты</button>
          <button class="action-btn edit" onclick="resetUserPassword(${user.id})" title="Сбросить пароль">Пароль</button>
          ${state.user && user.id !== state.user.id ? `
            <button class="action-btn" onclick="toggleBlock(${user.id}, ${user.blocked ? 0 : 1})">${user.blocked ? 'Разблокировать' : 'Блокировать'}</button>
            <button class="action-btn delete" onclick="deleteUser(${user.id})">Удалить</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

async function handleAddUser(event) {
  event.preventDefault();
  const errorEl = $('user-form-error');
  const successEl = $('user-form-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const payload = {
    fullName: $('new-fullname').value.trim(),
    tabNumber: $('new-tabnumber').value.trim(),
    password: $('new-password').value,
    role: $('new-role').value
  };

  try {
    await apiJson(`${API_BASE}/sotrudniki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    ['new-fullname', 'new-tabnumber', 'new-password'].forEach((id) => { $(id).value = ''; });
    $('new-role').value = 'Монтажник';
    successEl.textContent = 'Сотрудник добавлен';
    successEl.classList.remove('hidden');
    await loadUsers();
  } catch (error) {
    if (error instanceof AuthError) return;
    showError(errorEl, error.message);
  }
}

async function changeRole(id, role) {
  try {
    await apiJson(`${API_BASE}/sotrudniki/${id}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    await loadUsers();
    toast('Должность изменена');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
    await loadUsers();
  }
}

async function toggleBlock(id, blocked) {
  if (!confirm(blocked ? 'Заблокировать сотрудника?' : 'Разблокировать сотрудника?')) return;
  try {
    await apiJson(`${API_BASE}/sotrudniki/${id}/block`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked: Boolean(blocked) })
    });
    await loadUsers();
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function deleteUser(id) {
  if (!confirm('Удалить сотрудника? Если он автор статей, удаление будет отклонено.')) return;
  try {
    await apiJson(`${API_BASE}/sotrudniki/${id}`, { method: 'DELETE' });
    await loadUsers();
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function resetUserPassword(id) {
  const value = prompt('Новый пароль (не короче 10 символов, буквы и цифры):');
  if (!value) return;

  try {
    await apiJson(`${API_BASE}/sotrudniki/${id}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: value })
    });
    toast('Пароль сброшен');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function openAccessModal(id) {
  const user = (state.users || []).find((item) => item.id === id);
  if (!user) return;

  const objectsData = await apiJsonSafe(`${API_BASE}/objects`);
  const objects = objectsData ? objectsData.data : [];
  const selected = new Set(user.objectIds || []);

  openModal(`
    <h2>Доступ к объектам: ${escapeHtml(user.fullName)}</h2>
    <p class="field-hint">Инженер ПТО видит документы только назначенных объектов. Администратор видит все объекты.</p>
    <div class="form-group">
      ${objects.length ? objects.map((object) => `
        <label class="pto-checkbox">
          <input type="checkbox" class="access-object" value="${object.id}" ${selected.has(object.id) ? 'checked' : ''}>
          <span>${escapeHtml(object.name)}</span>
        </label>
      `).join('') : '<p class="card-hint">Объекты ещё не созданы</p>'}
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
      <button type="button" class="btn btn-primary" id="save-access">Сохранить</button>
    </div>
  `);

  $('save-access').addEventListener('click', async () => {
    const objectIds = Array.from(document.querySelectorAll('.access-object:checked')).map((input) => Number(input.value));
    try {
      await apiJson(`${API_BASE}/sotrudniki/${user.id}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectIds })
      });
      closeModal();
      await loadUsers();
      toast('Доступ обновлён');
    } catch (error) {
      if (error instanceof AuthError) return;
      toast(error.message, 'error');
    }
  });
}

// --- Документы ПТО ---

async function loadPtoMeta() {
  const data = await apiJsonSafe(`${API_BASE}/pto/meta`);
  if (!data) return;

  state.ptoMeta = data;

  const typeSelect = $('pto-filter-type');
  if (typeSelect) {
    typeSelect.innerHTML = '<option value="all">Все типы документов</option>' +
      data.types.map((type) => `<option value="${escapeAttr(type)}">${escapeHtml(type)}</option>`).join('');
    typeSelect.value = state.ptoFilters.type;
  }

  const statusSelect = $('pto-filter-status');
  if (statusSelect) {
    statusSelect.innerHTML = '<option value="all">Все статусы</option>' +
      data.statuses.map((status) => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`).join('');
    statusSelect.value = state.ptoFilters.status;
  }
}

async function loadPtoObjects() {
  const data = await apiJsonSafe(`${API_BASE}/objects`);
  state.objects = data ? data.data : [];

  const objectSelect = $('pto-filter-object');
  if (objectSelect) {
    objectSelect.innerHTML = '<option value="all">Все объекты</option>' +
      state.objects.map((object) => `<option value="${object.id}">${escapeHtml(object.name)}</option>`).join('');
    objectSelect.value = state.ptoFilters.objectId;
  }

  renderObjectSelects();
  await loadPtoDocuments();
}

function renderObjectSelects() {
  const targets = [
    { id: 'dashboard-object', allLabel: 'Все объекты' },
    { id: 'report-object', allLabel: 'Все объекты' },
    { id: 'remarks-filter-object', allLabel: 'Все объекты' }
  ];

  for (const target of targets) {
    const select = $(target.id);
    if (!select) continue;
    const current = select.value || 'all';
    select.innerHTML = `<option value="all">${target.allLabel}</option>` +
      state.objects.map((object) => `<option value="${object.id}">${escapeHtml(object.name)}</option>`).join('');
    select.value = current;
  }
}

async function loadPtoDocuments() {
  const params = new URLSearchParams();
  const filters = state.ptoFilters;

  if (filters.type !== 'all') params.set('type', filters.type);
  if (filters.objectId !== 'all') params.set('objectId', filters.objectId);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  if (filters.overdue) params.set('overdue', '1');

  const requestId = ++state.ptoLoadId;
  const data = await apiJsonSafe(`${API_BASE}/pto?${params.toString()}`, {});
  if (requestId !== state.ptoLoadId) return;

  state.ptoDocs = data ? data.data : [];
  renderPtoStats();
  renderPtoTable();
}

function isPtoOverdue(doc) {
  if (!doc.dueDate) return false;
  if (['Утверждён', 'В архиве'].includes(doc.status)) return false;
  return String(doc.dueDate).slice(0, 10) < todayIso();
}

function renderPtoStats() {
  const container = $('pto-stats');
  if (!container) return;

  const docs = state.ptoDocs;
  const total = docs.length;
  const inWork = docs.filter((doc) => ['На проверке', 'На согласовании'].includes(doc.status)).length;
  const approved = docs.filter((doc) => doc.status === 'Утверждён').length;
  const overdue = docs.filter(isPtoOverdue).length;

  container.innerHTML = `
    <div class="stat-card"><div class="number">${total}</div><div class="label">Найдено документов</div></div>
    <div class="stat-card"><div class="number blue">${inWork}</div><div class="label">В работе</div></div>
    <div class="stat-card"><div class="number green">${approved}</div><div class="label">Утверждено</div></div>
    <div class="stat-card"><div class="number ${overdue ? 'red' : 'yellow'}">${overdue}</div><div class="label">Просрочено</div></div>
  `;
}

function renderPtoTable() {
  const container = $('pto-list');
  const empty = $('pto-empty');
  if (!container) return;

  if (!state.ptoDocs.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  container.innerHTML = state.ptoDocs.map((doc) => {
    const overdue = isPtoOverdue(doc);
    const revision = Number(doc.version) > 1 ? ` · ред. ${doc.version}` : '';
    const shortType = {
      'Исполнительная документация': 'ИД',
      'ППР': 'ППР',
      'Акт скрытых работ': 'АОСР',
      'Журнал работ': 'ЖР',
      'Входной контроль': 'ВК'
    }[doc.type] || doc.type;

    return `
      <tr class="pto-row ${overdue ? 'pto-row-overdue' : ''}">
        <td><span class="pto-type-chip" title="${escapeAttr(doc.type)}">${escapeHtml(shortType)}</span></td>
        <td>
          <button type="button" class="pto-doc-title" onclick="openPtoDoc(${doc.id})">${escapeHtml(doc.title)}</button>
          <div class="pto-doc-sub">${escapeHtml(doc.cipher || 'без шифра')}${revision}</div>
        </td>
        <td>${escapeHtml(doc.objectName || '—')}</td>
        <td>${escapeHtml(doc.projectSection || '—')}</td>
        <td><span class="status-badge ${ptoStatusClass(doc.status)}">${escapeHtml(doc.status)}</span></td>
        <td class="${overdue ? 'pto-overdue' : ''}">${formatDate(doc.dueDate)}</td>
        <td>${escapeHtml(doc.responsible || '—')}</td>
        <td class="pto-actions">
          <button type="button" class="action-btn edit" onclick="openPtoDoc(${doc.id})">Открыть</button>
        </td>
      </tr>
    `;
  }).join('');
}

function ptoStatusClass(status) {
  return {
    'Черновик': 'draft',
    'На проверке': 'check',
    'На согласовании': 'review',
    'Утверждён': 'approved',
    'Отклонён': 'rejected',
    'В архиве': 'archived'
  }[status] || 'draft';
}

async function openPtoDoc(id) {
  const data = await apiJsonSafe(`${API_BASE}/pto/${id}`);
  if (!data) return;

  const doc = data.data;
  const overdue = isPtoOverdue(doc);
  const canManage = state.permissions.pto;

  const revisionsHtml = (doc.revisions || []).length
    ? `<div class="revision-list">${doc.revisions.map((revision) => `
        <div class="revision-item">
          <div class="revision-main">
            <strong>ред. ${revision.version}${Number(revision.version) === Number(doc.version) ? ' · текущая' : ''}</strong>
            ${revision.originalName ? `<div class="file-name" title="${escapeAttr(revision.originalName)}">${escapeHtml(revision.originalName)}</div>` : ''}
            <div class="pto-history-meta">${formatDateTime(revision.createdAt)} · ${escapeHtml(revision.author || '—')}${revision.comment ? ` · ${escapeHtml(revision.comment)}` : ''}</div>
          </div>
          ${revision.file ? `<div class="revision-actions">
            <button type="button" class="action-btn edit" onclick="openPreview('revision', ${revision.id})">Просмотреть</button>
            <a class="action-btn" href="${escapeAttr(revision.file)}?disposition=attachment">Скачать</a>
          </div>` : '<span class="pto-history-meta">без файла</span>'}
        </div>`).join('')}</div>`
    : '<p class="card-hint">Редакции не загружались</p>';

  const historyHtml = (doc.history || []).length
    ? `<ul class="pto-history-list">${doc.history.map((entry) => `
        <li>
          <div class="pto-history-action">
            <strong>${escapeHtml(entry.action)}</strong>
            <span class="pto-history-date">${formatDateTime(entry.date)}</span>
          </div>
          ${[entry.statusFrom, entry.statusTo].filter(Boolean).length ? `<div class="pto-history-meta">${escapeHtml([entry.statusFrom, entry.statusTo].filter(Boolean).join(' → '))}${entry.version ? ` · ред. ${entry.version}` : ''}${entry.author ? ` · ${escapeHtml(entry.author)}` : ''}</div>` : ''}
          ${entry.comment ? `<div class="pto-history-comment">${escapeHtml(entry.comment)}</div>` : ''}
        </li>`).join('')}</ul>`
    : '<p class="card-hint">Записей пока нет</p>';

  const statusOptions = state.ptoMeta.statuses
    .filter((status) => status !== doc.status)
    .map((status) => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`).join('');

  openModal(`
    <div class="pto-detail">
      <div class="pto-detail-top">
        <span class="pto-type-chip">${escapeHtml(doc.type)}</span>
        <span class="status-badge ${ptoStatusClass(doc.status)}">${escapeHtml(doc.status)}</span>
        ${overdue ? '<span class="status-badge rejected">Просрочен</span>' : ''}
        ${doc.requiresOcr ? '<span class="status-badge check">Требует OCR</span>' : ''}
      </div>

      <h2>${escapeHtml(doc.title)}</h2>

      <div class="pto-detail-grid">
        <div><span>Объект</span><strong>${escapeHtml(doc.objectName || '—')}</strong></div>
        <div><span>Шифр</span><strong>${escapeHtml(doc.cipher || '—')}</strong></div>
        <div><span>Раздел проекта</span><strong>${escapeHtml(doc.projectSection || '—')}</strong></div>
        <div><span>Срок</span><strong class="${overdue ? 'pto-overdue' : ''}">${formatDate(doc.dueDate)}</strong></div>
        <div><span>Ответственный</span><strong>${escapeHtml(doc.responsible || '—')}</strong></div>
        <div><span>Версия</span><strong>ред. ${doc.version} · ${formatDate(doc.actualizedAt)}</strong></div>
        <div><span>Автор</span><strong>${escapeHtml(doc.authorName || '—')}</strong></div>
        <div><span>Обновлён</span><strong>${formatDateTime(doc.updatedAt)}</strong></div>
      </div>

      ${doc.content ? `<div class="pto-detail-text">${escapeHtml(doc.content)}</div>` : ''}

      ${doc.file ? `<div class="document-file-block">
        ${doc.originalName ? `<div class="file-name" title="${escapeAttr(doc.originalName)}">${escapeHtml(doc.originalName)}</div>` : ''}
        <div class="pdf-actions">
          <button type="button" class="pdf-download-btn" onclick="openPreview('document', ${doc.id})">👁 Просмотреть</button>
          <a href="${escapeAttr(doc.file)}?disposition=attachment" class="pdf-download-btn" download>Скачать оригинал</a>
        </div>
      </div>` : ''}

      ${canManage ? `
        <div class="pto-status-panel">
          <h3>Смена статуса</h3>
          <div class="pto-status-row">
            <select id="pto-status-select" class="filter-select">${statusOptions}</select>
            <input type="text" id="pto-status-comment" class="search-input" placeholder="Комментарий (необязательно)">
            <button type="button" class="btn btn-primary" onclick="changePtoStatus(${doc.id})">Применить</button>
          </div>
        </div>
        <div class="article-actions">
          <button class="btn btn-secondary btn-sm" onclick="openPtoForm(${doc.id})">✏️ Редактировать</button>
          <button class="btn btn-danger btn-sm" onclick="deletePtoDoc(${doc.id})">Удалить</button>
        </div>` : ''}

      <div class="pto-detail-section">
        <h3>История документа</h3>
        ${historyHtml}
      </div>

      <div class="pto-detail-section">
        <h3>Редакции и файлы</h3>
        ${revisionsHtml}
      </div>
    </div>
  `);
}

async function changePtoStatus(id) {
  const status = $('pto-status-select').value;
  const comment = $('pto-status-comment').value.trim();

  try {
    await apiJson(`${API_BASE}/pto/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, comment })
    });
    await loadPtoDocuments();
    await openPtoDoc(id);
    toast('Статус изменён');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function openPtoForm(id) {
  if (!state.permissions.pto) return;

  let doc = null;
  if (id) {
    const data = await apiJsonSafe(`${API_BASE}/pto/${id}`);
    if (!data) return;
    doc = data.data;
  }

  const typeOptions = state.ptoMeta.types.map((type) => `<option value="${escapeAttr(type)}" ${doc && doc.type === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('');
  const objectOptions = state.objects.map((object) => `<option value="${object.id}" ${doc && Number(doc.objectId) === Number(object.id) ? 'selected' : ''}>${escapeHtml(object.name)}</option>`).join('');
  const statusOptions = state.ptoMeta.statuses.map((status) => `<option value="${escapeAttr(status)}" ${doc ? (doc.status === status ? 'selected' : '') : (status === 'Черновик' ? 'selected' : '')}>${escapeHtml(status)}</option>`).join('');

  openModal(`
    <h2>${doc ? 'Редактировать документ ПТО' : 'Новый документ ПТО'}</h2>
    <form id="pto-doc-form" class="modal-form">
      <div id="pto-form-error" class="error-message hidden"></div>

      <div class="form-row">
        <div class="form-group">
          <label for="pto-form-type">Тип документа <span class="required">*</span></label>
          <select id="pto-form-type" required>${typeOptions}</select>
        </div>
        <div class="form-group">
          <label for="pto-form-object">Объект</label>
          <select id="pto-form-object" ${state.permissions.admin ? '' : 'required'}><option value="">${state.permissions.admin ? 'Без объекта' : 'Выберите объект'}</option>${objectOptions}</select>
        </div>
      </div>

      <div class="form-group">
        <label for="pto-form-title">Наименование <span class="required">*</span></label>
        <input type="text" id="pto-form-title" value="${escapeAttr(doc ? doc.title : '')}" required>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="pto-form-cipher">Шифр</label>
          <input type="text" id="pto-form-cipher" value="${escapeAttr(doc ? (doc.cipher || '') : '')}" placeholder="2026-ИД-01">
        </div>
        <div class="form-group">
          <label for="pto-form-section">Раздел проекта</label>
          <input type="text" id="pto-form-section" value="${escapeAttr(doc ? (doc.projectSection || '') : '')}" placeholder="ОВ, КЖ, ЭОМ">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="pto-form-status">Статус</label>
          <select id="pto-form-status">${statusOptions}</select>
        </div>
        <div class="form-group">
          <label for="pto-form-due">Срок</label>
          <input type="date" id="pto-form-due" value="${escapeAttr(doc ? (doc.dueDate || '') : '')}">
        </div>
      </div>

      <div class="form-group">
        <label for="pto-form-responsible">Ответственный</label>
        <input type="text" id="pto-form-responsible" value="${escapeAttr(doc ? (doc.responsible || '') : '')}" placeholder="ФИО инженера ПТО">
      </div>

      <div class="form-group">
        <label for="pto-form-content">Описание</label>
        <textarea id="pto-form-content" rows="4">${escapeHtml(doc ? (doc.content || '') : '')}</textarea>
      </div>

      <div class="form-group">
        <label for="pto-form-file">Файл (PDF, DOCX, XLSX)</label>
        <input type="file" id="pto-form-file" class="pto-file-input" accept=".pdf,.doc,.docx,.xls,.xlsx">
        <span class="field-hint">${doc && doc.originalName ? `Текущий файл: ${escapeHtml(doc.originalName)}. Новый файл создаст новую редакцию.` : 'Максимальный размер 20 МБ'}</span>
      </div>

      ${doc ? `<label class="pto-checkbox">
        <input type="checkbox" id="pto-form-revision">
        <span>Отметить как новую редакцию (ред. ${Number(doc.version) + 1})</span>
      </label>` : ''}

      <div class="form-group">
        <label for="pto-form-comment">Комментарий к изменению</label>
        <input type="text" id="pto-form-comment" placeholder="Например: замечания устранены">
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">${doc ? 'Сохранить' : 'Создать'}</button>
      </div>
    </form>
  `);

  $('pto-doc-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = $('pto-form-error');
    errorEl.classList.add('hidden');

    const formData = new FormData();
    formData.append('type', $('pto-form-type').value);
    formData.append('title', $('pto-form-title').value.trim());
    formData.append('objectId', $('pto-form-object').value);
    formData.append('cipher', $('pto-form-cipher').value.trim());
    formData.append('projectSection', $('pto-form-section').value.trim());
    formData.append('status', $('pto-form-status').value);
    formData.append('dueDate', $('pto-form-due').value);
    formData.append('responsible', $('pto-form-responsible').value.trim());
    formData.append('content', $('pto-form-content').value.trim());
    formData.append('comment', $('pto-form-comment').value.trim());

    const file = $('pto-form-file').files[0];
    if (file) formData.append('docFile', file);
    if (doc && $('pto-form-revision') && $('pto-form-revision').checked) formData.append('newRevision', 'true');

    try {
      const result = await apiJson(doc ? `${API_BASE}/pto/${doc.id}` : `${API_BASE}/pto`, {
        method: doc ? 'PUT' : 'POST',
        body: formData
      });

      closeModal();
      await loadPtoDocuments();
      const savedId = doc ? doc.id : result.data.id;
      await openPtoDoc(savedId);
      if (state.currentPage === 'dashboard') await loadDashboard();
      toast('Документ сохранён');
    } catch (error) {
      if (error instanceof AuthError) return;
      showError(errorEl, error.message);
    }
  });
}

async function deletePtoDoc(id) {
  if (!confirm('Удалить документ? История и редакции будут удалены безвозвратно.')) return;

  try {
    await apiJson(`${API_BASE}/pto/${id}`, { method: 'DELETE' });
    closeModal();
    await loadPtoDocuments();
    toast('Документ удалён');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

function exportPto() {
  const params = new URLSearchParams();
  const filters = state.ptoFilters;
  if (filters.type !== 'all') params.set('type', filters.type);
  if (filters.objectId !== 'all') params.set('objectId', filters.objectId);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  if (filters.overdue) params.set('overdue', '1');

  const query = params.toString();
  window.location.href = `${API_BASE}/pto/export.csv${query ? '?' + query : ''}`;
}

function renderObjects() {
  const container = $('objects-list');
  if (!container) return;

  if (!state.objects.length) {
    container.innerHTML = '<p class="card-hint">Объекты пока не добавлены</p>';
    return;
  }

  container.innerHTML = state.objects.map((object) => `
    <div class="object-row">
      <div class="object-main">
        <strong>${escapeHtml(object.name)}</strong>
        <span>${escapeHtml([object.address, object.customer].filter(Boolean).join(' · ') || 'адрес и заказчик не указаны')}</span>
      </div>
      <span class="object-count">${object.documentsCount} док.</span>
      ${state.permissions.pto ? `<button type="button" class="action-btn delete" onclick="deleteObject(${object.id})">Удалить</button>` : ''}
    </div>
  `).join('');
}

async function handleAddObject(event) {
  event.preventDefault();
  const errorEl = $('object-form-error');
  const successEl = $('object-form-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  try {
    await apiJson(`${API_BASE}/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('new-object-name').value.trim(),
        address: $('new-object-address').value.trim(),
        customer: $('new-object-customer').value.trim()
      })
    });

    ['new-object-name', 'new-object-address', 'new-object-customer'].forEach((id) => { $(id).value = ''; });
    successEl.textContent = 'Объект добавлен';
    successEl.classList.remove('hidden');
    await loadPtoObjects();
  } catch (error) {
    if (error instanceof AuthError) return;
    showError(errorEl, error.message);
  }
}

async function deleteObject(id) {
  if (!confirm('Удалить объект? Удаление возможно только для объекта без документов и замечаний.')) return;
  try {
    await apiJson(`${API_BASE}/objects/${id}`, { method: 'DELETE' });
    await loadPtoObjects();
    toast('Объект удалён');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

// --- Панель ПТО ---

let dashboardRequest = 0;

async function loadDashboard() {
  const request = ++dashboardRequest;
  const object = $('dashboard-object').value;
  const suffix = object && object !== 'all' ? '&objectId=' + encodeURIComponent(object) : '';
  const [summary, docs, remarks, notices] = await Promise.all([
    apiJsonSafe(API_BASE + '/reports/summary?' + suffix.slice(1)),
    apiJsonSafe(API_BASE + '/pto?limit=5' + suffix),
    apiJsonSafe(API_BASE + '/remarks?limit=100' + suffix),
    apiJsonSafe(API_BASE + '/notifications?limit=3')
  ]);
  if (request !== dashboardRequest) return;
  const stats = summary?.data;
  const measures = [
    ['Документов', stats?.total, 'doc'], ['В работе', stats?.inWork, 'clock'],
    ['Просрочено', stats?.overdue, 'calendar'], ['Открытых замечаний', stats?.remarksOpen, 'remarks']
  ];
  $('dashboard-stats').innerHTML = measures.map(([label, n, icon]) =>
    `<div class="stat-card"><div class="metric-label">${label}${uiIcon(icon)}</div><strong class="number">${n ?? '—'}</strong></div>`
  ).join('');
  const empty = (response, label) => '<p class="compact-empty">' + (response ? label : 'Не удалось загрузить данные') + '</p>';
  $('dashboard-docs').innerHTML = (docs?.data || []).map((doc) => `
    <div class="work-row"><span class="row-icon">${uiIcon('doc')}</span><div class="row-main">
    <button class="text-btn" onclick="openPtoDoc(${doc.id})">${escapeHtml(doc.title)}</button>
    <small>${escapeHtml(doc.objectName || 'Без объекта')}</small></div>
    <span class="status-badge ${ptoStatusClass(doc.status)}">${escapeHtml(doc.status)}</span>
    <time>${formatDate(doc.dueDate)}</time></div>`).join('') || empty(docs, 'Документов пока нет');
  const open = (remarks?.data || []).filter((r) => !['Закрыто', 'Отклонено', 'Устранено'].includes(r.status)).slice(0, 4);
  $('dashboard-remarks').innerHTML = open.map((r) => `<div class="work-row"><span class="row-icon">${uiIcon('remarks')}</span>
    <div class="row-main"><button class="text-btn" onclick="openRemarkDetail(${r.id})">${escapeHtml(r.description)}</button>
    <small>${escapeHtml(r.number || '№' + r.id)}</small></div><time>${formatDate(r.dueDate)}</time></div>`).join('') || empty(remarks, 'Открытых замечаний нет');
  $('dashboard-notices').innerHTML = (notices?.data || []).slice(0, 3).map((n) => `<div class="work-row"><span class="row-icon">${uiIcon('bell')}</span>
    <div class="row-main">${escapeHtml(n.text)}<small>${formatDateTime(n.createdAt)}</small></div></div>`).join('') || empty(notices, 'Уведомлений нет');
}

function uiIcon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function fillInstructionKinds() {
  const select = $('instruction-kind');
  const value = select.value;
  select.replaceChildren(new Option('Все виды работ', 'all'), ...state.vidy.map((v) => new Option(v.name, v.id)));
  select.value = [...select.options].some((o) => o.value === value) ? value : 'all';
}

function renderInstructions() {
  const query = $('instruction-search').value.trim().toLocaleLowerCase('ru');
  const kind = $('instruction-kind').value;
  const groups = new Map();
  for (const work of state.raboty) {
    if (!work.instruction?.trim() || (kind !== 'all' && String(work.vidId) !== kind)) continue;
    if (![work.name, work.instruction, work.vidName].join(' ').toLocaleLowerCase('ru').includes(query)) continue;
    const label = work.vidName || 'Без вида работ';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(work);
  }
  $('instruction-list').innerHTML = [...groups].map(([label, works]) => `<section class="card"><h2>${escapeHtml(label)}</h2>
    ${works.map((work) => `<details class="instruction"><summary>${escapeHtml(work.name)}</summary>
      <div class="article-text">${escapeHtml(work.instruction)}</div>
      ${state.articles.filter((a) => a.rabotaId === work.id).map((a) =>
        `<button class="text-btn related" onclick="openArticleModal(${a.id})">${uiIcon('book')}${escapeHtml(a.title)}</button>`).join('')}
    </details>`).join('')}</section>`).join('') || '<p class="empty-state">Инструкции не найдены</p>';
}

let searchRequest = 0;
function hideSearch() {
  ++searchRequest;
  $('global-search-results').hidden = true;
  $('top-search').classList.remove('expanded');
}

async function runGlobalSearch() {
  const query = $('global-search').value.trim();
  const container = $('global-search-results');

  const request = ++searchRequest;
  container.hidden = false;
  if (query.length < 2) {
    container.innerHTML = '<div class="compact-empty">Введите минимум 2 символа</div>';
    return;
  }

  const data = await apiJsonSafe(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
  if (request !== searchRequest) return;
  if (!data) { container.textContent = 'Не удалось выполнить поиск'; return; }

  container.replaceChildren();
  if (!data.data.length) {
    const empty = document.createElement('div');
    empty.className = 'compact-empty';
    empty.textContent = `Ничего не найдено (движок: ${data.engine})`;
    container.append(empty);
    return;
  }

  for (const item of data.data) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.textContent = item.title;
    const isDocument = item.kind === 'document';
    button.addEventListener('click', () => { hideSearch(); if (item.kind === 'task') return taskUI.fromLink(item.id); return isDocument ? openPtoDoc(item.id) : openArticleModal(item.id); });

    const detail = document.createElement('span');
    detail.className = 'search-kind';
    detail.textContent = item.kind === 'task' ? 'Задача' : isDocument ? 'Документ ПТО' : 'Статья';
    if (item.fragment) {
      detail.append(' · ');
      let cursor = 0;
      for (const [start, end] of item.highlights || []) {
        detail.append(item.fragment.slice(cursor, start));
        const mark = document.createElement('mark');
        mark.textContent = item.fragment.slice(start, end);
        detail.append(mark);
        cursor = end;
      }
      detail.append(item.fragment.slice(cursor));
    }
    button.append(detail);
    container.append(button);
  }
}

// --- Комплектность ИД ---

async function loadCompleteness() {
  const data = await apiJsonSafe(`${API_BASE}/completeness`);
  const container = $('completeness-list');
  const empty = $('completeness-empty');
  const sets = data ? data.data : [];

  if (!sets.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.innerHTML = sets.map((set) => `
    <div class="set-card">
      <div class="set-card-header">
        <div>
          <h3>${escapeHtml(set.name)}</h3>
          <div class="set-meta">${escapeHtml(set.objectName || 'Объект не указан')}${set.responsible ? ' · ' + escapeHtml(set.responsible) : ''}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn-light btn-sm" onclick="openSetDetail(${set.id})">Открыть</button>
          ${state.permissions.pto ? `<button class="btn btn-danger btn-sm" onclick="deleteSet(${set.id})">Удалить</button>` : ''}
        </div>
      </div>
      <div class="progress"><span style="width:${set.stats.percent}%"></span></div>
      <div class="progress-label">
        Позиций: ${set.stats.total} · готово: ${set.stats.complete} · в работе: ${set.stats.inWork} · отсутствует: ${set.stats.missing}
      </div>
    </div>
  `).join('');
}

function openSetForm() {
  if (!state.permissions.pto) return;

  openModal(`
    <h2>Новый комплект ИД</h2>
    <form id="set-form" class="modal-form">
      <div id="set-form-error" class="error-message hidden"></div>
      <div class="form-group">
        <label for="set-name">Название комплекта <span class="required">*</span></label>
        <input type="text" id="set-name" placeholder="Например: ИД по электроснабжению" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="set-object">Объект</label>
          <select id="set-object" ${state.permissions.admin ? '' : 'required'}><option value="">${state.permissions.admin ? 'Без объекта' : 'Выберите объект'}</option>${state.objects.map((object) => `<option value="${object.id}">${escapeHtml(object.name)}</option>`).join('')}</select>
        </div>
        <div class="form-group">
          <label for="set-responsible">Ответственный</label>
          <input type="text" id="set-responsible" placeholder="ФИО">
        </div>
      </div>
      <div class="form-group">
        <label for="set-note">Примечание</label>
        <textarea id="set-note" rows="2"></textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Создать</button>
      </div>
    </form>
  `);

  $('set-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await apiJson(`${API_BASE}/completeness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('set-name').value.trim(),
          objectId: $('set-object').value || null,
          responsible: $('set-responsible').value.trim(),
          note: $('set-note').value.trim()
        })
      });
      closeModal();
      await loadCompleteness();
      toast('Комплект создан');
    } catch (error) {
      if (error instanceof AuthError) return;
      showError($('set-form-error'), error.message);
    }
  });
}

async function openSetDetail(id) {
  const data = await apiJsonSafe(`${API_BASE}/completeness/${id}`);
  if (!data) return;

  const set = data.data;
  const canManage = state.permissions.pto;

  const documentsData = set.objectId ? await apiJsonSafe(`${API_BASE}/pto?limit=500&objectId=${set.objectId}`) : null;
  const documents = documentsData ? documentsData.data : [];

  const requirementRows = set.requirements.map((requirement) => `
    <tr>
      <td>${escapeHtml(requirement.name)}<div class="pto-doc-sub">${escapeHtml(requirement.type || 'любой тип')}${requirement.required ? ' · обязательное' : ''}</div></td>
      <td>
        ${requirement.documents.length
          ? requirement.documents.map((doc) => `<span class="doc-chip">${escapeHtml(doc.title)} <span class="chip-status">(${escapeHtml(doc.status)})</span>${canManage ? `<button onclick="unlinkDocument(${requirement.id}, ${doc.id}, ${set.id})" title="Отвязать">✕</button>` : ''}</span>`).join('')
          : '<span class="pto-overdue">нет документа</span>'}
      </td>
      <td>${requirement.state || ''}</td>
      <td>
        ${canManage ? `
          <select class="filter-select" style="min-width:160px" onchange="linkDocument(${requirement.id}, this.value, ${set.id})">
            <option value="">Привязать документ…</option>
            ${documents.map((doc) => `<option value="${doc.id}">${escapeHtml(doc.title)}</option>`).join('')}
          </select>` : ''}
      </td>
    </tr>
  `).join('');

  openModal(`
    <h2>${escapeHtml(set.name)}</h2>
    <div class="pto-detail-grid">
      <div><span>Объект</span><strong>${escapeHtml(set.objectName || '—')}</strong></div>
      <div><span>Ответственный</span><strong>${escapeHtml(set.responsible || '—')}</strong></div>
      <div><span>Готовность</span><strong>${set.stats.percent}%</strong></div>
      <div><span>Отсутствует</span><strong class="${set.stats.missing ? 'pto-overdue' : ''}">${set.stats.missing}</strong></div>
    </div>
    ${set.note ? `<div class="pto-detail-text">${escapeHtml(set.note)}</div>` : ''}

    <div class="table-container">
      <table class="requirements-table">
        <thead><tr><th>Требование</th><th>Документы</th><th>Состояние</th><th></th></tr></thead>
        <tbody>${requirementRows || '<tr><td colspan="4">Требования ещё не добавлены</td></tr>'}</tbody>
      </table>
    </div>

    ${canManage ? `
      <div class="pto-detail-section">
        <h3>Добавить требование</h3>
        <form id="requirement-form" class="modal-form">
          <div class="form-row">
            <div class="form-group">
              <label for="requirement-name">Название позиции <span class="required">*</span></label>
              <input type="text" id="requirement-name" placeholder="Например: Акты освидетельствования скрытых работ" required>
            </div>
            <div class="form-group">
              <label for="requirement-type">Тип документа</label>
              <select id="requirement-type"><option value="">Любой</option>${state.ptoMeta.types.map((type) => `<option value="${escapeAttr(type)}">${escapeHtml(type)}</option>`).join('')}</select>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Добавить</button>
          </div>
        </form>
      </div>` : ''}

    <div class="modal-actions-row">
      <a class="btn btn-light" href="${API_BASE}/completeness/${set.id}/missing.csv">Отчёт о недостающих (CSV)</a>
    </div>
  `);

  if (canManage && $('requirement-form')) {
    $('requirement-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await apiJson(`${API_BASE}/completeness/${set.id}/requirements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: $('requirement-name').value.trim(), type: $('requirement-type').value || null })
        });
        await openSetDetail(set.id);
        await loadCompleteness();
      } catch (error) {
        if (error instanceof AuthError) return;
        toast(error.message, 'error');
      }
    });
  }
}

async function linkDocument(requirementId, documentId, setId) {
  if (!documentId) return;
  try {
    await apiJson(`${API_BASE}/completeness/requirements/${requirementId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: Number(documentId) })
    });
    await loadCompleteness();
    if (setId) await openSetDetail(setId);
    toast('Документ привязан');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function unlinkDocument(requirementId, documentId, setId) {
  try {
    await apiJson(`${API_BASE}/completeness/requirements/${requirementId}/documents/${documentId}`, { method: 'DELETE' });
    await loadCompleteness();
    if (setId) await openSetDetail(setId);
    toast('Документ отвязан');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function deleteSet(id) {
  if (!confirm('Удалить комплект? Документы и замечания не удаляются.')) return;
  try {
    await apiJson(`${API_BASE}/completeness/${id}`, { method: 'DELETE' });
    await loadCompleteness();
    toast('Комплект удалён');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

// --- Замечания ---

async function loadRemarkStatuses() {
  const data = await apiJsonSafe(`${API_BASE}/remark-statuses`);
  state.remarkStatuses = data ? data.data : [];

  const select = $('remarks-filter-status');
  if (select) {
    select.innerHTML = '<option value="all">Все статусы</option>' +
      state.remarkStatuses.map((status) => `<option value="${escapeAttr(status.name)}">${escapeHtml(status.name)}</option>`).join('');
  }
}

async function loadRemarks() {
  if (!state.remarkStatuses.length) await loadRemarkStatuses();

  const params = new URLSearchParams();
  const filters = state.remarkFilters;
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.objectId !== 'all') params.set('objectId', filters.objectId);
  if (filters.q) params.set('q', filters.q);
  if (filters.overdue) params.set('overdue', '1');

  const data = await apiJsonSafe(`${API_BASE}/remarks?${params.toString()}`);
  state.remarks = data ? data.data : [];
  renderRemarks();
}

function renderRemarks() {
  const container = $('remarks-list');
  const empty = $('remarks-empty');
  if (!container) return;

  const closed = ['Закрыто', 'Отклонено', 'Устранено'];
  const overdue = state.remarks.filter((remark) => remark.dueDate && remark.dueDate < todayIso() && !closed.includes(remark.status)).length;

  $('remarks-stats').innerHTML = `
    <div class="stat-card"><div class="number">${state.remarks.length}</div><div class="label">Найдено</div></div>
    <div class="stat-card"><div class="number blue">${state.remarks.filter((remark) => !closed.includes(remark.status)).length}</div><div class="label">В работе</div></div>
    <div class="stat-card"><div class="number ${overdue ? 'red' : 'yellow'}">${overdue}</div><div class="label">Просрочено</div></div>
  `;

  if (!state.remarks.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  container.innerHTML = state.remarks.map((remark) => {
    const isOverdue = remark.dueDate && remark.dueDate < todayIso() && !closed.includes(remark.status);
    const statusClass = closed.includes(remark.status) ? 'closed' : (isOverdue ? 'overdue' : '');

    return `
      <tr>
        <td>${escapeHtml(remark.number || '—')}<div class="pto-doc-sub">${escapeHtml(remark.authorName || '')}</div></td>
        <td>${formatDate(remark.date)}</td>
        <td>${escapeHtml(remark.objectName || '—')}${remark.documentTitle ? `<div class="pto-doc-sub">${escapeHtml(remark.documentTitle)}</div>` : ''}</td>
        <td class="remark-desc">${escapeHtml(remark.description)}</td>
        <td>${escapeHtml(remark.responsible || '—')}</td>
        <td class="${isOverdue ? 'pto-overdue' : ''}">${formatDate(remark.dueDate)}</td>
        <td><span class="remark-status ${statusClass}">${escapeHtml(remark.status)}</span></td>
        <td><button class="action-btn edit" onclick="openRemarkDetail(${remark.id})">Открыть</button></td>
      </tr>
    `;
  }).join('');
}

async function openRemarkForm() {
  if (!state.permissions.pto) return;
  if (!state.remarkStatuses.length) await loadRemarkStatuses();

  const documentsData = await apiJsonSafe(`${API_BASE}/pto?limit=500`);
  const documents = documentsData ? documentsData.data : [];

  openModal(`
    <h2>Новое замечание</h2>
    <form id="remark-form" class="modal-form">
      <div id="remark-form-error" class="error-message hidden"></div>
      <div class="form-row">
        <div class="form-group">
          <label for="remark-object">Объект</label>
          <select id="remark-object" ${state.permissions.admin ? '' : 'required'}><option value="">${state.permissions.admin ? 'Без объекта' : 'Выберите объект'}</option>${state.objects.map((object) => `<option value="${object.id}">${escapeHtml(object.name)}</option>`).join('')}</select>
        </div>
        <div class="form-group">
          <label for="remark-document">Документ</label>
          <select id="remark-document"><option value="">Без документа</option></select>
        </div>
      </div>
      <div class="form-group">
        <label for="remark-description">Описание замечания <span class="required">*</span></label>
        <textarea id="remark-description" rows="4" required></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="remark-responsible">Ответственный</label>
          <input type="text" id="remark-responsible" placeholder="ФИО">
        </div>
        <div class="form-group">
          <label for="remark-due">Срок устранения</label>
          <input type="date" id="remark-due">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="remark-status">Статус</label>
          <select id="remark-status">${state.remarkStatuses.map((status) => `<option value="${escapeAttr(status.name)}">${escapeHtml(status.name)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Создать</button>
      </div>
    </form>
  `);

  $('remark-object').addEventListener('change', () => {
    const objectId = Number($('remark-object').value);
    const matching = documents.filter((doc) => doc.objectId === objectId);
    $('remark-document').replaceChildren(new Option('Без документа', ''), ...matching.map((doc) => new Option(doc.title, doc.id)));
  });

  $('remark-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await apiJson(`${API_BASE}/remarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objectId: $('remark-object').value || null,
          documentId: $('remark-document').value || null,
          description: $('remark-description').value.trim(),
          responsible: $('remark-responsible').value.trim(),
          dueDate: $('remark-due').value || null,
          status: $('remark-status').value
        })
      });
      closeModal();
      await loadRemarks();
      toast('Замечание создано');
    } catch (error) {
      if (error instanceof AuthError) return;
      showError($('remark-form-error'), error.message);
    }
  });
}

async function openRemarkDetail(id) {
  const data = await apiJsonSafe(`${API_BASE}/remarks/${id}`);
  if (!data) return;

  const remark = data.data;
  const canManage = state.permissions.pto;
  const closed = ['Закрыто', 'Отклонено', 'Устранено'].includes(remark.status);
  const isOverdue = remark.dueDate && remark.dueDate < todayIso() && !closed;

  const comments = (remark.comments || []).map((comment) => `
    <div class="remark-comment">
      <div class="remark-comment-meta">${formatDateTime(comment.createdAt)} · ${escapeHtml(comment.author || '—')}</div>
      ${escapeHtml(comment.text)}
    </div>`).join('');

  const attachments = (remark.attachments || []).map((file) => `
    <div class="compact-item attachment-item">
      <span class="file-name" title="${escapeAttr(file.originalName || 'Файл')}">${escapeHtml(file.originalName || 'Файл')}</span>
      <span class="attachment-actions">
        <button type="button" class="action-btn edit" onclick="openPreview('remark', ${file.id})">Просмотреть</button>
        <a class="action-btn" href="${escapeAttr(file.file)}?disposition=attachment">Скачать</a>
      </span>
    </div>`).join('');

  const history = (remark.history || []).map((entry) => `
    <li>
      <div class="pto-history-action"><strong>${escapeHtml(entry.action)}</strong><span class="pto-history-date">${formatDateTime(entry.date)}</span></div>
      ${[entry.statusFrom, entry.statusTo].filter(Boolean).length ? `<div class="pto-history-meta">${escapeHtml([entry.statusFrom, entry.statusTo].filter(Boolean).join(' → '))} · ${escapeHtml(entry.author || '')}</div>` : ''}
    </li>`).join('');

  openModal(`
    <div class="pto-detail">
      <div class="pto-detail-top">
        <span class="remark-status ${closed ? 'closed' : (isOverdue ? 'overdue' : '')}">${escapeHtml(remark.status)}</span>
        ${isOverdue ? '<span class="status-badge rejected">Просрочено</span>' : ''}
      </div>
      <h2>${escapeHtml(remark.number || 'Замечание')}</h2>
      <div class="pto-detail-grid">
        <div><span>Объект</span><strong>${escapeHtml(remark.objectName || '—')}</strong></div>
        <div><span>Документ</span><strong>${escapeHtml(remark.documentTitle || '—')}</strong></div>
        <div><span>Дата</span><strong>${formatDate(remark.date)}</strong></div>
        <div><span>Срок</span><strong class="${isOverdue ? 'pto-overdue' : ''}">${formatDate(remark.dueDate)}</strong></div>
        <div><span>Ответственный</span><strong>${escapeHtml(remark.responsible || '—')}</strong></div>
        <div><span>Закрыто</span><strong>${formatDate(remark.closedAt)}</strong></div>
      </div>

      <div class="pto-detail-text">${escapeHtml(remark.description)}</div>

      ${canManage ? `
        <div class="pto-status-panel">
          <h3>Смена статуса</h3>
          <div class="pto-status-row">
            <select id="remark-status-select" class="filter-select">
              ${state.remarkStatuses.filter((status) => status.name !== remark.status).map((status) => `<option value="${escapeAttr(status.name)}">${escapeHtml(status.name)}</option>`).join('')}
            </select>
            <input type="text" id="remark-status-comment" class="search-input" placeholder="Комментарий">
            <button type="button" class="btn btn-primary" onclick="changeRemarkStatus(${remark.id})">Применить</button>
          </div>
        </div>` : ''}

      <div class="pto-detail-section">
        <h3>Комментарии</h3>
        ${comments || '<p class="card-hint">Комментариев пока нет</p>'}
        <div class="pto-status-row" style="margin-top:10px">
          <input type="text" id="remark-comment-input" class="search-input" placeholder="Добавить комментарий">
          <button type="button" class="btn btn-secondary" onclick="addRemarkComment(${remark.id})">Добавить</button>
        </div>
      </div>

      <div class="pto-detail-section">
        <h3>Вложения</h3>
        ${attachments || '<p class="card-hint">Вложений нет</p>'}
        ${canManage ? `<div class="pto-status-row" style="margin-top:10px">
          <input type="file" id="remark-file-input" class="pto-file-input">
          <button type="button" class="btn btn-secondary" onclick="uploadRemarkAttachment(${remark.id})">Приложить</button>
        </div>` : ''}
      </div>

      <div class="pto-detail-section">
        <h3>История</h3>
        <ul class="pto-history-list">${history || '<li>Записей пока нет</li>'}</ul>
      </div>
    </div>
  `);
}

async function changeRemarkStatus(id) {
  const status = $('remark-status-select').value;
  const comment = $('remark-status-comment').value.trim();
  try {
    await apiJson(`${API_BASE}/remarks/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, comment })
    });
    await loadRemarks();
    await openRemarkDetail(id);
    toast('Статус замечания изменён');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function addRemarkComment(id) {
  const text = $('remark-comment-input').value.trim();
  if (!text) return;
  try {
    await apiJson(`${API_BASE}/remarks/${id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    await openRemarkDetail(id);
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

async function uploadRemarkAttachment(id) {
  const input = $('remark-file-input');
  if (!input || !input.files[0]) {
    toast('Выберите файл', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('file', input.files[0]);

  try {
    await apiJson(`${API_BASE}/remarks/${id}/attachments`, { method: 'POST', body: formData });
    await openRemarkDetail(id);
    toast('Файл приложен');
  } catch (error) {
    if (error instanceof AuthError) return;
    toast(error.message, 'error');
  }
}

// --- Отчёты ---

async function loadReport() {
  const params = new URLSearchParams();
  const objectId = $('report-object').value;
  const from = $('report-from').value;
  const to = $('report-to').value;

  if (objectId && objectId !== 'all') params.set('objectId', objectId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const data = await apiJsonSafe(`${API_BASE}/reports/summary?${params.toString()}`);
  if (!data) return;

  const report = data.data;
  state.report = report;

  $('report-stats').innerHTML = `
    <div class="stat-card"><div class="number">${report.total}</div><div class="label">Документов</div></div>
    <div class="stat-card"><div class="number blue">${report.inWork}</div><div class="label">В работе</div></div>
    <div class="stat-card"><div class="number green">${report.approved}</div><div class="label">Утверждено</div></div>
    <div class="stat-card"><div class="number ${report.overdue ? 'red' : 'yellow'}">${report.overdue}</div><div class="label">Просрочено</div></div>
    <div class="stat-card"><div class="number">${report.dueSoon}</div><div class="label">Срок ≤ 3 дней</div></div>
    <div class="stat-card"><div class="number ${report.remarksOpen ? 'red' : ''}">${report.remarksOpen}</div><div class="label">Замечаний открыто</div></div>
    <div class="stat-card"><div class="number">${report.setsComplete}/${report.setsTotal}</div><div class="label">Комплектов готово</div></div>
    <div class="stat-card"><div class="number">${report.onTimePercent === null ? '—' : report.onTimePercent + '%'}</div><div class="label">Сдано в срок</div></div>
  `;

  $('report-status-list').innerHTML = report.byStatus.length
    ? report.byStatus.map((row) => `
        <tr>
          <td>${escapeHtml(row.status)}</td>
          <td>${row.count}</td>
          <td>${report.total ? Math.round((row.count / report.total) * 100) + '%' : '—'}</td>
        </tr>`).join('')
    : '<tr><td colspan="3">Нет данных за выбранный период</td></tr>';
}

function exportReport(kind) {
  const params = new URLSearchParams();
  const objectId = $('report-object').value;
  if (objectId && objectId !== 'all') params.set('objectId', objectId);

  const query = params.toString();
  window.location.href = `${API_BASE}/reports/${kind}.csv${query ? '?' + query : ''}`;
}

// --- Уведомления ---

async function refreshNotificationBadge() {
  const data = await apiJsonSafe(`${API_BASE}/notifications/unread-count`);
  const badge = $('notifications-badge');
  if (!badge) return;

  const unread = data ? data.unread : 0;
  badge.textContent = String(unread);
  badge.classList.toggle('hidden', unread === 0);
}

async function openNotifications() {
  const data = await apiJsonSafe(`${API_BASE}/notifications`);
  if (!data) return;

  const items = data.data.map((item) => `
    <div class="compact-item notification-row">
      <div>
        <div>${/^task:\d+$/.test(item.link || '') ? `<button class="text-btn" data-notice-task="${Number(item.link.slice(5))}">${escapeHtml(item.text)}</button>` : escapeHtml(item.text)}</div>
        <div class="pto-doc-sub">${formatDateTime(item.createdAt)}</div>
      </div>
      ${item.read ? '' : `<button onclick="markNotificationRead(${item.id})">Прочитано</button>`}
    </div>
  `).join('');

  openModal(`
    <h2>Уведомления</h2>
    ${items || '<p class="card-hint">Уведомлений нет</p>'}
    <div class="modal-actions-row">
      <button class="btn btn-secondary" onclick="markAllNotificationsRead()">Отметить все прочитанными</button>
    </div>
  `);
}

document.addEventListener('click', event => {
  const link = event.target.closest('[data-notice-task]');
  if (link) { closeModal(); taskUI.fromLink(Number(link.dataset.noticeTask)); }
});

async function markNotificationRead(id) {
  await apiJsonSafe(`${API_BASE}/notifications/${id}/read`, { method: 'POST' });
  await refreshNotificationBadge();
  if (state.currentPage === 'dashboard') await loadDashboard();
  await openNotifications();
}

async function markAllNotificationsRead() {
  await apiJsonSafe(`${API_BASE}/notifications/read-all`, { method: 'POST' });
  await refreshNotificationBadge();
  if (state.currentPage === 'dashboard') await loadDashboard();
  closeModal();
}

// --- Профиль и смена пароля ---

function openPasswordForm() {
  openModal(`
    <h2>Профиль</h2><p>${escapeHtml(state.user.fullName)} · ${escapeHtml(state.user.role)}</p>
    <h3 class="profile-subtitle">Смена пароля</h3>
    <form id="password-form" class="modal-form">
      <div id="password-form-error" class="error-message hidden"></div>
      <div class="form-group">
        <label for="current-password">Текущий пароль <span class="required">*</span></label>
        <input type="password" id="current-password" required autocomplete="current-password">
      </div>
      <div class="form-group">
        <label for="new-password-field">Новый пароль <span class="required">*</span></label>
        <input type="password" id="new-password-field" required autocomplete="new-password">
        <span class="field-hint">Не короче 10 символов, содержит буквы и цифры, не совпадает с табельным номером.</span>
      </div>
      <div class="form-group">
        <label for="new-password-repeat">Повтор нового пароля <span class="required">*</span></label>
        <input type="password" id="new-password-repeat" required autocomplete="new-password">
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Отмена</button>
        <button type="submit" class="btn btn-primary">Сменить пароль</button>
      </div>
    </form>
  `);

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = $('password-form-error');
    errorEl.classList.add('hidden');

    const currentPassword = $('current-password').value;
    const newPassword = $('new-password-field').value;
    const repeat = $('new-password-repeat').value;

    if (newPassword !== repeat) {
      showError(errorEl, 'Новые пароли не совпадают');
      return;
    }

    try {
      const data = await apiJson(`${API_BASE}/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });

      if (data && data.csrfToken) state.csrfToken = data.csrfToken;
      closeModal();
      toast('Пароль изменён');
    } catch (error) {
      if (error instanceof AuthError) return;
      showError(errorEl, error.message);
    }
  });
}

// --- Импорт CSV ---

function openImportModal() {
  if (!state.permissions.pto) return;

  openModal(`
    <h2>Импорт документов из CSV</h2>
    <p class="card-hint">Колонки: Тип; Наименование; Объект; Шифр; Раздел; Статус; Срок; Ответственный; Описание. Тип можно указать кодом: ИД, ППР, АОСР, ЖР, ВК.</p>
    <div class="form-group">
      <input type="file" id="import-file" class="pto-file-input" accept=".csv">
    </div>
    <div id="import-summary" class="import-summary"></div>
    <div id="import-preview" class="import-preview"></div>
    <div class="modal-actions-row">
      <button class="btn btn-secondary" type="button" onclick="closeModal()">Отмена</button>
      <button class="btn btn-primary" type="button" id="import-confirm" disabled>Импортировать</button>
    </div>
  `);

  let rows = [];

  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const data = await apiJson(`${API_BASE}/import/preview`, { method: 'POST', body: formData });
      rows = data.data.rows;

      $('import-summary').innerHTML = `
        <span>Всего строк: <strong>${data.data.summary.total}</strong></span>
        <span>Готово к импорту: <strong>${data.data.summary.valid}</strong></span>
        <span>Дубликаты: <strong>${data.data.summary.duplicates}</strong></span>
        <span>Ошибки: <strong>${data.data.summary.invalid}</strong></span>
      `;

      $('import-preview').innerHTML = `
        <table>
          <thead><tr><th>#</th><th>Тип</th><th>Наименование</th><th>Объект</th><th>Срок</th><th>Проблемы</th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr class="${row.errors.length ? 'import-row-error' : ''}">
                <td>${row.index}</td>
                <td>${escapeHtml(row.data.type)}</td>
                <td>${escapeHtml(row.data.title)}</td>
                <td>${escapeHtml(row.data.object)}</td>
                <td>${escapeHtml(row.data.dueDate)}</td>
                <td>${escapeHtml([...(row.errors || []), row.duplicate ? 'возможный дубликат' : ''].filter(Boolean).join('; '))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      `;

      $('import-confirm').disabled = data.data.summary.invalid > 0 || rows.length === 0;
    } catch (error) {
      if (error instanceof AuthError) return;
      toast(error.message, 'error');
    }
  });

  $('import-confirm').addEventListener('click', async () => {
    try {
      const data = await apiJson(`${API_BASE}/import/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rows.map((row) => row.data) })
      });

      closeModal();
      await loadPtoDocuments();
      toast(`Импортировано: ${data.created}, пропущено дубликатов: ${data.skippedDuplicates}`);
    } catch (error) {
      if (error instanceof AuthError) return;
      toast(error.message + (error.details ? ' Проверьте строки: ' + (error.details[0]?.errors || []).join(', ') : ''), 'error');
    }
  });
}

// --- Просмотр документов (PDF, DOCX, XLSX, TXT/CSV, изображения) ---

const viewer = {
  modal: null,
  body: null,
  title: null,
  subtitle: null,
  download: null
};

function initViewerRefs() {
  viewer.modal = $('viewer-modal');
  viewer.body = $('viewer-body');
  viewer.title = $('viewer-title');
  viewer.subtitle = $('viewer-subtitle');
  viewer.download = $('viewer-download');
}

function closeViewer() {
  if (!viewer.modal) return;
  viewer.modal.classList.add('hidden');
  viewer.body.innerHTML = '';
  document.body.classList.remove('modal-open');
}

function viewerSubtitle(meta) {
  const parts = [];
  if (meta.version) parts.push(`редакция ${meta.version}`);
  if (meta.isCurrent === false) parts.push('не актуальная редакция');
  if (meta.size) parts.push(`${(Number(meta.size) / 1024).toFixed(1)} КБ`);
  if (meta.name) parts.push(meta.name);
  return parts.map((part) => `<span>${escapeHtml(part)}</span>`).join(' · ');
}

function viewerWarnings(warnings) {
  if (!warnings || !warnings.length) return '';
  return `<div class="viewer-warning">${warnings.map((warning) => escapeHtml(warning)).join('<br>')}</div>`;
}

async function openPreview(entity, id) {
  const metaResponse = await apiJsonSafe(`${API_BASE}/preview/${entity}/${id}`);
  if (!metaResponse) return;
  showViewer(metaResponse.data, entity, id);
}

async function showViewer(meta, entity, id) {
  if (!viewer.modal) initViewerRefs();

  viewer.title.textContent = meta.title || meta.name || 'Просмотр документа';
  viewer.subtitle.innerHTML = viewerSubtitle(meta);
  viewer.download.href = meta.downloadUrl || '#';
  viewer.body.innerHTML = '<div class="viewer-loading">Загрузка документа…</div>';
  viewer.modal.classList.remove('hidden');
  document.body.classList.add('modal-open');

  const noteHtml = (meta.notes || []).length
    ? `<div class="viewer-note">${meta.notes.map((note) => escapeHtml(note)).join('<br>')}</div>`
    : '';

  try {
    switch (meta.mode) {
      case 'iframe': {
        if (meta.kind === 'image') {
          viewer.body.innerHTML = `<div class="viewer-image-wrap"><img class="viewer-image" src="${escapeAttr(meta.inlineUrl)}" alt="${escapeAttr(meta.name)}"></div>`;
        } else {
          viewer.body.innerHTML = `<iframe class="viewer-frame" src="${escapeAttr(meta.inlineUrl)}" title="${escapeAttr(meta.name)}"></iframe>`;
        }
        break;
      }

      case 'converted': {
        viewer.body.innerHTML = `<iframe class="viewer-frame" src="${escapeAttr(meta.pdfUrl)}" title="${escapeAttr(meta.name)}"></iframe>`;
        break;
      }

      case 'html': {
        const content = await apiJsonSafe(`${API_BASE}/preview/${entity}/${id}/content`);
        if (!content) return;
        viewer.body.innerHTML = `${viewerWarnings(content.data.warnings)}<div class="docx-view">${content.data.html}</div>`;
        break;
      }

      case 'table': {
        const content = await apiJsonSafe(`${API_BASE}/preview/${entity}/${id}/content`);
        if (!content) return;

        if (content.data.kind === 'xlsx') {
          const sheets = content.data.sheets || [];
          const tabs = sheets.map((sheet, index) => `<button type="button" class="sheet-tab ${index === 0 ? 'active' : ''}" data-index="${index}">${escapeHtml(sheet.name)}</button>`).join('');
          const first = sheets[0];
          viewer.body.innerHTML = `
            ${viewerWarnings(content.data.warnings)}
            <div class="sheet-tabs">${tabs || '<span class="card-hint">В книге нет листов</span>'}</div>
            <div class="sheet-area" id="sheet-area">${first ? renderSheetTable(first) : ''}</div>
          `;

          viewer.body.querySelectorAll('.sheet-tab').forEach((button) => {
            button.addEventListener('click', () => {
              viewer.body.querySelectorAll('.sheet-tab').forEach((item) => item.classList.toggle('active', item === button));
              $('sheet-area').innerHTML = renderSheetTable(sheets[Number(button.dataset.index)]);
            });
          });
        } else {
          viewer.body.innerHTML = `
            ${viewerWarnings([])}
            <div class="sheet-area">${renderRowsTable(content.data.rows)}</div>
          `;
        }
        break;
      }

      case 'text': {
        const content = await apiJsonSafe(`${API_BASE}/preview/${entity}/${id}/content`);
        if (!content) return;
        viewer.body.innerHTML = `<pre class="viewer-text">${escapeHtml(content.data.text)}</pre>`;
        break;
      }

      default: {
        viewer.body.innerHTML = `<div class="viewer-empty">
          ${noteHtml || '<p>Предварительный просмотр этого формата недоступен. Скачайте файл для открытия в соответствующей программе.</p>'}
          <a class="btn btn-primary" href="${escapeAttr(meta.downloadUrl || '#')}">Скачать файл</a>
        </div>`;
      }
    }
  } catch (error) {
    if (error instanceof AuthError) return;
    viewer.body.innerHTML = `<div class="viewer-empty">Не удалось открыть документ: ${escapeHtml(error.message)}</div>`;
  }
}

function renderSheetTable(sheet) {
  if (!sheet || !sheet.rows || !sheet.rows.length) {
    return '<p class="card-hint">Лист пуст или не содержит данных</p>';
  }

  const rows = sheet.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
  return `<table class="sheet-table"><tbody>${rows}</tbody></table>`;
}

function renderRowsTable(rows) {
  if (!rows || !rows.length) return '<p class="card-hint">Нет данных для отображения</p>';
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
  return `<table class="sheet-table"><tbody>${body}</tbody></table>`;
}


// --- Инициализация ---

let galleryRequest = 0;
const galleryUrl = API_BASE + '/company/photos';

async function loadProjectPhotos() {
  const request = ++galleryRequest;
  const message = $('project-gallery-status');
  try {
    const { photos } = await apiJson(galleryUrl);
    if (request !== galleryRequest) return;
    const buttons = photos.map((name, index) => {
      const img = document.createElement('img');
      img.src = galleryUrl + '/' + encodeURIComponent(name);
      img.alt = 'Строительство РЦОД — фото ' + (index + 1);
      img.loading = 'lazy';
      const button = document.createElement('button');
      button.type = 'button';
      button.append(img);
      return button;
    });
    $('project-gallery').replaceChildren(...buttons);
    message.textContent = photos.length ? '' : 'Фотографии проекта пока не размещены';
    message.hidden = photos.length > 0;
  } catch (error) {
    if (request !== galleryRequest || error instanceof AuthError) return;
    message.textContent = 'Не удалось загрузить фотографии. ' + error.message;
    message.hidden = false;
  }
}

async function uploadProjectPhoto(event) {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  const button = $('project-photo-add');
  button.disabled = true;
  button.textContent = 'Загрузка…';
  try {
    const form = new FormData();
    form.append('photo', file);
    await apiJson(galleryUrl, { method: 'POST', body: form });
    await loadProjectPhotos();
    toast('Фото загружено');
  } catch (error) {
    if (!(error instanceof AuthError)) toast(error.message, 'error');
  } finally {
    input.value = '';
    button.disabled = false;
    button.textContent = 'Загрузить фото';
  }
}

function setupEventListeners() {
  $('login-form').addEventListener('submit', handleLogin);
  $('logout-btn').addEventListener('click', handleLogout);


  $('toggle-password').addEventListener('click', () => {
    const input = $('password');
    const button = $('toggle-password');
    if (input.type === 'password') {
      input.type = 'text';
      button.textContent = '✕';
    } else {
      input.type = 'password';
      button.textContent = '👁️';
    }
  });

  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => {
      $('drawer').close();
      navigateTo(button.dataset.page);
    });
  });

  const drawer = $('drawer');
  $('nav-toggle').addEventListener('click', () => {
    hideSearch();
    drawer.showModal();
    $('nav-toggle').setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-open');
    $('drawer-close').focus();
  });
  drawer.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const buttons = [...drawer.querySelectorAll('button')].filter((button) => button.getClientRects().length);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  drawer.addEventListener('close', () => {
    document.body.classList.remove('menu-open');
    $('nav-toggle').setAttribute('aria-expanded', 'false');
  });
  $('drawer-close').addEventListener('click', () => drawer.close());
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer && event.clientX > drawer.getBoundingClientRect().right) drawer.close();
  });
  document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => navigateTo(button.dataset.go)));
  document.querySelector('[data-action="document"]').addEventListener('click', () => openPtoForm());
  document.querySelector('[data-action="notifications"]').addEventListener('click', openNotifications);
  $('instruction-search').addEventListener('input', renderInstructions);
  $('instruction-kind').addEventListener('change', renderInstructions);
  $('project-photo-add').addEventListener('click', () => $('project-photo-file').click());
  $('project-photo-file').addEventListener('change', uploadProjectPhoto);
  $('project-gallery').addEventListener('click', (event) => {
    const photo = event.target.closest('button')?.querySelector('img');
    if (!photo) return;
    openModal('<figure id="project-photo"></figure>');
    $('project-photo').append(photo.cloneNode());
    if (photo.alt) {
      const caption = document.createElement('figcaption');
      caption.textContent = photo.alt;
      $('project-photo').append(caption);
    }
  });
  $('notifications-btn').addEventListener('click', openNotifications);
  $('profile-btn').addEventListener('click', openPasswordForm);
  $('modal-close').addEventListener('click', closeModal);
  $('article-modal').addEventListener('click', (event) => {
    if (event.target === $('article-modal')) closeModal();
  });

  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer-modal').addEventListener('click', (event) => {
    if (event.target === $('viewer-modal')) closeViewer();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('task-panel').open) return;
      if (drawer.open) return;
      if (!$('global-search-results').hidden || $('top-search').classList.contains('expanded')) {
        hideSearch();
        $('global-search-btn').focus();
        return;
      }
      if (!document.getElementById('viewer-modal').classList.contains('hidden')) {
        closeViewer();
        return;
      }
      closeModal();
    }
  });

  $('search-input').addEventListener('input', (event) => {
    state.searchQuery = event.target.value;
    renderArticles();
  });

  $('filter-vid').addEventListener('change', (event) => {
    state.filterVid = event.target.value;
    renderArticles();
  });

  $('article-form').addEventListener('submit', handleAddArticle);
  $('article-content').addEventListener('input', (event) => {
    $('char-count').textContent = String(event.target.value.length);
  });
  $('article-pdf').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    $('file-upload-text').textContent = `📄 ${file.name}`;
    document.querySelector('.file-upload-label').classList.add('has-file');
    $('clear-pdf').classList.remove('hidden');
  });
  $('clear-pdf').addEventListener('click', (event) => {
    event.preventDefault();
    $('article-pdf').value = '';
    $('file-upload-text').textContent = 'Выберите PDF-файл или перетащите сюда';
    document.querySelector('.file-upload-label').classList.remove('has-file');
    $('clear-pdf').classList.add('hidden');
  });

  $('show-add-user').addEventListener('click', () => $('add-user-form-container').classList.toggle('hidden'));
  $('add-user-form').addEventListener('submit', handleAddUser);
  $('show-add-vid').addEventListener('click', () => $('add-vid-form-container').classList.toggle('hidden'));
  $('add-vid-form').addEventListener('submit', handleAddVidRabot);
  $('show-add-rabota').addEventListener('click', () => {
    $('add-rabota-form-container').classList.toggle('hidden');
    populateVidSelectForRabota();
  });
  $('add-rabota-form').addEventListener('submit', handleAddRabota);
  $('filter-raboty-vid').addEventListener('change', renderRaboty);
  $('search-raboty').addEventListener('input', renderRaboty);

  // ПТО
  $('show-add-doc').addEventListener('click', () => openPtoForm());
  $('show-import').addEventListener('click', openImportModal);
  $('export-pto').addEventListener('click', exportPto);
  $('pto-filter-type').addEventListener('change', (event) => {
    state.ptoFilters.type = event.target.value;
    loadPtoDocuments();
  });
  $('pto-filter-object').addEventListener('change', (event) => {
    state.ptoFilters.objectId = event.target.value;
    loadPtoDocuments();
  });
  $('pto-filter-status').addEventListener('change', (event) => {
    state.ptoFilters.status = event.target.value;
    loadPtoDocuments();
  });
  $('pto-filter-overdue').addEventListener('change', (event) => {
    state.ptoFilters.overdue = event.target.checked;
    loadPtoDocuments();
  });

  let searchTimer = null;
  $('pto-search').addEventListener('input', (event) => {
    state.ptoFilters.q = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadPtoDocuments, 250);
  });

  $('show-add-object').addEventListener('click', () => $('add-object-form').classList.toggle('hidden'));
  $('add-object-form').addEventListener('submit', handleAddObject);

  // Панель
  $('dashboard-refresh').addEventListener('click', loadDashboard);
  $('dashboard-object').addEventListener('change', loadDashboard);
  $('top-search').addEventListener('submit', (event) => {
    event.preventDefault();
    if (window.matchMedia('(max-width: 700px)').matches && !$('top-search').classList.contains('expanded')) {
      $('top-search').classList.add('expanded');
      $('global-search').focus();
      return;
    }
    runGlobalSearch();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#top-search, #global-search-results')) hideSearch();
  });

  // Комплектность
  $('show-add-set').addEventListener('click', openSetForm);

  // Замечания
  $('show-add-remark').addEventListener('click', openRemarkForm);
  $('remarks-filter-status').addEventListener('change', (event) => {
    state.remarkFilters.status = event.target.value;
    loadRemarks();
  });
  $('remarks-filter-object').addEventListener('change', (event) => {
    state.remarkFilters.objectId = event.target.value;
    loadRemarks();
  });
  $('remarks-filter-overdue').addEventListener('change', (event) => {
    state.remarkFilters.overdue = event.target.checked;
    loadRemarks();
  });

  let remarkTimer = null;
  $('remarks-search').addEventListener('input', (event) => {
    state.remarkFilters.q = event.target.value.trim();
    clearTimeout(remarkTimer);
    remarkTimer = setTimeout(loadRemarks, 250);
  });

  // Отчёты
  $('report-apply').addEventListener('click', loadReport);
  $('report-documents-csv').addEventListener('click', () => exportReport('documents'));
  $('report-remarks-csv').addEventListener('click', () => exportReport('remarks'));

}

document.addEventListener('DOMContentLoaded', async () => {
  $('current-year').textContent = String(new Date().getFullYear());
  setupEventListeners();

  const notice = sessionStorage.getItem('login_notice');
  if (notice) {
    showError($('login-error'), notice);
    sessionStorage.removeItem('login_notice');
  }
  const saved = sessionStorage.getItem('current_user');
  if (!saved) return;

  try {
    state.user = JSON.parse(saved);
  } catch {
    sessionStorage.removeItem('current_user');
    return;
  }

  const session = await apiJsonSafe(`${API_BASE}/auth/session`);
  if (!session) {
    forceLogin(null);
    return;
  }

  state.user = session.user;
  state.csrfToken = session.csrfToken;
  state.permissions = session.permissions;
  await showApp();
});
