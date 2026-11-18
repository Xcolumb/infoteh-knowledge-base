const API_BASE = '/api';

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function isAuthError(error) {
  return error instanceof AuthError;
}

function forceLogin(message) {
  closeMobileMenu();
  closeModal();

  currentUser = null;
  sessionStorage.removeItem('current_user');
  appPage.classList.add('hidden');
  loginPage.classList.remove('hidden');
  document.getElementById('password').value = '';

  if (message) {
    showError(loginError, message);
  } else {
    loginError.classList.add('hidden');
  }

  window.scrollTo(0, 0);
}

function openMobileMenu() {
  mobileMenu.classList.add('open');
  mobileMenuOverlay.classList.add('open');
  mobileMenu.setAttribute('aria-hidden', 'false');
  navToggle.setAttribute('aria-expanded', 'true');
  document.body.classList.add('menu-open');
}

function closeMobileMenu() {
  mobileMenu.classList.remove('open');
  mobileMenuOverlay.classList.remove('open');
  mobileMenu.setAttribute('aria-hidden', 'true');
  navToggle.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
}

function openModal(html) {
  modalBody.innerHTML = html;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModal() {
  modal.classList.add('hidden');
  modalBody.innerHTML = '';
  document.body.classList.remove('modal-open');
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options
  });

  if (response.status === 401) {
    forceLogin('Сессия истекла, войдите заново');
    throw new AuthError(401, 'Требуется авторизация');
  }

  if (response.status === 403) {
    forceLogin('У вас нет прав для этого действия');
    throw new AuthError(403, 'Недостаточно прав');
  }

  return response;
}


let currentUser = null;
let articles = [];
let users = [];
let vidyRabot = [];
let raboty = [];
let searchQuery = '';
let filterVid = 'all';


const loginPage = document.getElementById('login-page');
const appPage = document.getElementById('app-page');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const catalogPage = document.getElementById('catalog-page');
const addArticlePage = document.getElementById('add-article-page');
const vidyRabotPage = document.getElementById('vidy-rabot-page');
const rabotyPage = document.getElementById('raboty-page');
const usersPage = document.getElementById('users-page');
const ptoPage = document.getElementById('pto-page');

const navToggle = document.getElementById('nav-toggle');
const mobileMenu = document.getElementById('mobile-menu');
const mobileMenuOverlay = document.getElementById('mobile-menu-overlay');
const mobileMenuClose = document.getElementById('mobile-menu-close');
const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
const mobileUserName = document.getElementById('mobile-user-name');
const mobileUserRole = document.getElementById('mobile-user-role');

let searchRaboty = '';
let filterRabotyVid = 'all';

let ptoDocuments = [];
let ptoObjects = [];
let ptoFilterType = 'all';
let ptoFilterObject = 'all';
let ptoFilterStatus = 'all';
let ptoSearch = '';
let ptoOnlyOverdue = false;
let ptoLoadRequestId = 0;

const PTO_TYPES = [
  'Исполнительная документация',
  'ППР',
  'Акт скрытых работ',
  'Журнал работ',
  'Входной контроль'
];

const PTO_TYPE_SHORT = {
  'Исполнительная документация': 'ИД',
  'ППР': 'ППР',
  'Акт скрытых работ': 'АОСР',
  'Журнал работ': 'ЖР',
  'Входной контроль': 'ВК'
};

const PTO_STATUSES = [
  'Черновик',
  'На проверке',
  'На согласовании',
  'Утверждён',
  'Отклонён',
  'В архиве'
];

const modal = document.getElementById('article-modal');
const modalBody = document.getElementById('modal-body');
const modalClose = document.getElementById('modal-close');


document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('current-year').textContent = new Date().getFullYear();

  const savedUser = sessionStorage.getItem('current_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    showApp();
  }
  
  setupEventListeners();
});


function setupEventListeners() {
  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);
  
  document.getElementById('toggle-password').addEventListener('click', () => {
    const passInput = document.getElementById('password');
    const btn = document.getElementById('toggle-password');
    if (passInput.type === 'password') {
      passInput.type = 'text';
      btn.textContent = '✕';
    } else {
      passInput.type = 'password';
      btn.textContent = '👁️';
    }
  });
  
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.page);
      closeMobileMenu();
    });
  });

  navToggle.addEventListener('click', openMobileMenu);
  mobileMenuClose.addEventListener('click', closeMobileMenu);
  mobileMenuOverlay.addEventListener('click', closeMobileMenu);
  mobileLogoutBtn.addEventListener('click', handleLogout);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMobileMenu();
      closeModal();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileMenu();
    }
  });
  
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderArticles();
  });
  
  document.getElementById('filter-vid').addEventListener('change', (e) => {
    filterVid = e.target.value;
    renderArticles();
  });
  
  document.getElementById('article-form').addEventListener('submit', handleAddArticle);
  document.getElementById('article-content').addEventListener('input', (e) => {
    document.getElementById('char-count').textContent = e.target.value.length;
  });
  
  document.getElementById('show-add-user').addEventListener('click', () => {
    document.getElementById('add-user-form-container').classList.toggle('hidden');
  });

  document.getElementById('show-add-vid').addEventListener('click', () => {
    document.getElementById('add-vid-form-container').classList.toggle('hidden');
  });
  document.getElementById('add-vid-form').addEventListener('submit', handleAddVidRabot);

  document.getElementById('show-add-rabota').addEventListener('click', () => {
    document.getElementById('add-rabota-form-container').classList.toggle('hidden');
    populateVidSelectForRabota();
  });
  document.getElementById('add-rabota-form').addEventListener('submit', handleAddRabota);
  
  document.getElementById('filter-raboty-vid').addEventListener('change', (e) => {
    filterRabotyVid = e.target.value;
    renderRaboty();
  });
  document.getElementById('search-raboty').addEventListener('input', (e) => {
    searchRaboty = e.target.value.toLowerCase();
    renderRaboty();
  });
document.getElementById('add-user-form').addEventListener('submit', handleAddUser);

  // === МОДУЛЬ ПТО ===
  document.getElementById('show-add-doc').addEventListener('click', () => openPtoForm());
  document.getElementById('export-pto').addEventListener('click', exportPtoRegistry);

  document.getElementById('pto-filter-type').addEventListener('change', (e) => {
    ptoFilterType = e.target.value;
    loadPtoDocuments();
  });

  document.getElementById('pto-filter-object').addEventListener('change', (e) => {
    ptoFilterObject = e.target.value;
    loadPtoDocuments();
  });

  document.getElementById('pto-filter-status').addEventListener('change', (e) => {
    ptoFilterStatus = e.target.value;
    loadPtoDocuments();
  });

  document.getElementById('pto-filter-overdue').addEventListener('change', (e) => {
    ptoOnlyOverdue = e.target.checked;
    loadPtoDocuments();
  });

  let ptoSearchTimer = null;
  document.getElementById('pto-search').addEventListener('input', (e) => {
    ptoSearch = e.target.value.trim();
    clearTimeout(ptoSearchTimer);
    ptoSearchTimer = setTimeout(loadPtoDocuments, 250);
  });

  document.getElementById('show-add-object').addEventListener('click', () => {
    document.getElementById('add-object-form').classList.toggle('hidden');
  });

  document.getElementById('add-object-form').addEventListener('submit', handleAddObject);
  
  // Модальное окно
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  
  // === ЗАГРУЗКА PDF-ФАЙЛА ===
  const pdfInput = document.getElementById('article-pdf');
  const fileUploadLabel = document.querySelector('.file-upload-label');
  const fileUploadText = document.getElementById('file-upload-text');
  const clearPdfBtn = document.getElementById('clear-pdf');
  
  pdfInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      fileUploadText.textContent = `📄 ${file.name}`;
      fileUploadLabel.classList.add('has-file');
      clearPdfBtn.classList.remove('hidden');
    }
  });
  
  clearPdfBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pdfInput.value = '';
    fileUploadText.textContent = 'Выберите PDF-файл или перетащите сюда';
    fileUploadLabel.classList.remove('has-file');
    clearPdfBtn.classList.add('hidden');
  });
}

async function handleLogin(e) {
  e.preventDefault();
  
  const tabNumber = document.getElementById('tab-number').value.trim();
  const password = document.getElementById('password').value;
  
  loginError.classList.add('hidden');
  
  if (!tabNumber || !password) {
    showError(loginError, 'Введите табельный номер и пароль');
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
    
    if (data.success) {
      currentUser = data.user;
      sessionStorage.setItem('current_user', JSON.stringify(currentUser));
      showApp();
    } else {
      showError(loginError, data.error || 'Ошибка авторизации');
    }
  } catch (error) {
    console.error('Ошибка авторизации:', error);
    showError(loginError, 'Ошибка подключения к серверу. Попробуйте позже.');
  }
}

async function handleLogout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin'
    });
  } catch (error) {
    console.error('Ошибка выхода:', error);
  }

  forceLogin(null);
}


async function showApp() {
  loginPage.classList.add('hidden');
  appPage.classList.remove('hidden');
  
  document.getElementById('user-name').textContent = currentUser.fullName;
  const roleEl = document.getElementById('user-role');
  roleEl.textContent = currentUser.role;
  roleEl.className = 'user-role ' + getRoleClass(currentUser.role);
  
  const isAdmin = currentUser.role === 'Администратор';
  const isSenior = currentUser.role === 'Старший монтажник';
  const canManageWork = isAdmin || isSenior;

  document.querySelectorAll('.nav-btn').forEach(btn => {
    const page = btn.dataset.page;

    if (page === 'add-article' || page === 'vidy-rabot' || page === 'raboty') {
      btn.classList.toggle('hidden', !canManageWork);
    }

    if (page === 'users') {
      btn.classList.toggle('hidden', !isAdmin);
    }
  });
  
  document.getElementById('article-author').textContent = currentUser.fullName;
  mobileUserName.textContent = currentUser.fullName;
  mobileUserRole.textContent = currentUser.role;
  mobileUserRole.className = 'mobile-user-role ' + getRoleClass(currentUser.role);
  
  await loadVidyRabot();
  await loadRaboty();
  await loadArticles();
  await loadPtoObjects();
  await loadPtoDocuments();
  applyPtoPermissions();

  if (!currentUser) return;
  navigateTo('catalog');
}

function navigateTo(page) {
  if (!currentUser) return;

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  
  catalogPage.classList.add('hidden');
  addArticlePage.classList.add('hidden');
  vidyRabotPage.classList.add('hidden');
  rabotyPage.classList.add('hidden');
  usersPage.classList.add('hidden');
  ptoPage.classList.add('hidden');

  const canManageWork = currentUser.role === 'Администратор' || currentUser.role === 'Старший монтажник';

  switch (page) {
    case 'catalog':
      catalogPage.classList.remove('hidden');
      break;
    case 'pto':
      ptoPage.classList.remove('hidden');
      loadPtoObjects();
      renderPtoStats();
      renderPtoTable();
      renderObjects();
      break;
    case 'add-article':
      if (canManageWork) {
        addArticlePage.classList.remove('hidden');
        populateRabotySelect();
      }
      break;
    case 'vidy-rabot':
      if (canManageWork) {
        vidyRabotPage.classList.remove('hidden');
        renderVidyRabot();
      }
      break;
    case 'raboty':
      if (canManageWork) {
        rabotyPage.classList.remove('hidden');
        populateFilterRabotyVid();
        renderRaboty();
      }
      break;
    case 'users':
    case 'users':
      if (currentUser.role === 'Администратор') {
        usersPage.classList.remove('hidden');
        loadUsers();
      }
      break;
  }
}

async function loadVidyRabot() {
  try {
    const response = await apiFetch(`${API_BASE}/vidy-rabot`);
    const data = await response.json();
    vidyRabot = data.data || [];

    const filterSelect = document.getElementById('filter-vid');
    filterSelect.innerHTML = '<option value="all">Все виды работ</option>';
    vidyRabot.forEach(vid => {
      filterSelect.innerHTML += `<option value="${vid.id}">${escapeHtml(vid.name)}</option>`;
    });
  } catch (error) {
    if (isAuthError(error)) return;
    console.error('Ошибка загрузки видов работ:', error);
    vidyRabot = [];
  }
}

async function loadRaboty() {
  try {
    const response = await apiFetch(`${API_BASE}/raboty`);
    const data = await response.json();
    raboty = data.data || [];
  } catch (error) {
    if (isAuthError(error)) return;
    console.error('Ошибка загрузки работ:', error);
    raboty = [];
  }
}

async function loadArticles() {
  try {
    const response = await apiFetch(`${API_BASE}/articles`);
    const data = await response.json();
    articles = data.data || [];
    renderArticles();
  } catch (error) {
    if (isAuthError(error)) return;
    console.error('Ошибка загрузки статей:', error);
    articles = [];
    renderArticles();
  }
}

async function loadUsers() {
  try {
    const response = await apiFetch(`${API_BASE}/sotrudniki`);
    const data = await response.json();
    users = data.data || [];
    renderUsers();
  } catch (error) {
    if (isAuthError(error)) return;
    console.error('Ошибка загрузки сотрудников:', error);
    users = [];
    renderUsers();
  }
}

function renderArticles() {
  const container = document.getElementById('articles-list');
  const statsContainer = document.getElementById('catalog-stats');

  let filtered = articles.filter(article => {
    const matchesSearch = 
      article.title.toLowerCase().includes(searchQuery) ||
      (article.content && article.content.toLowerCase().includes(searchQuery)) ||
      (article.keywords && article.keywords.toLowerCase().includes(searchQuery)) ||
      (article.vidName && article.vidName.toLowerCase().includes(searchQuery)) ||
      (article.rabotaName && article.rabotaName.toLowerCase().includes(searchQuery));
    
    const matchesVid = filterVid === 'all' || 
      (article.rabotaId && raboty.find(r => r.id === article.rabotaId && r.vidId == filterVid));
    
    return matchesSearch && matchesVid;
  });

  statsContainer.innerHTML = `
    <div class="stat-card">
      <div class="number">${articles.length}</div>
      <div class="label">Всего статей</div>
    </div>
    <div class="stat-card">
      <div class="number blue">${vidyRabot.length}</div>
      <div class="label">Видов работ</div>
    </div>
    <div class="stat-card">
      <div class="number green">${raboty.length}</div>
      <div class="label">Работ</div>
    </div>
    <div class="stat-card">
      <div class="number yellow">${filtered.length}</div>
      <div class="label">Найдено</div>
    </div>
  `;
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="no-articles">
        <h3>Статьи не найдены</h3>
        <p>Попробуйте изменить параметры поиска или фильтры</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = filtered.map(article => `
    <div class="article-card" data-id="${article.id}">
      <div class="article-header" onclick="toggleArticle(${article.id})">
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
        <span class="article-expand-icon">▼</span>
      </div>
      <div class="article-content">
        <div class="article-text">${escapeHtml(article.content || '')}</div>
        ${article.keywords ? `
          <div class="article-keywords">
            ${article.keywords.split(',').map(kw => `<span>${escapeHtml(kw.trim())}</span>`).join('')}
          </div>
        ` : ''}
        ${article.file ? `
          <div class="pdf-viewer-section">
            <div class="pdf-viewer-header">
              <h4>Документ (PDF)</h4>
            </div>
            <div class="pdf-actions">
              <a href="${escapeAttr(article.file)}" target="_blank" rel="noopener" class="pdf-download-btn">
                📄 Открыть инструкцию
              </a>
              <a href="${escapeAttr(article.file)}" download class="pdf-download-btn">
                Скачать PDF
              </a>
            </div>
          </div>
        ` : ''}
        ${canManageContent() ? `
          <div class="article-actions">
            <button class="btn btn-secondary btn-sm" onclick="openEditArticle(${article.id})">✏️ Редактировать</button>
            ${currentUser.role === 'Администратор' ? `<button class="btn btn-danger btn-sm" onclick="confirmDeleteArticle(${article.id})">Удалить</button>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function toggleArticle(id) {
  const card = document.querySelector(`.article-card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('expanded');
  }
}

function rabotaOptions(selectedId) {
  return raboty.map(r => `
    <option value="${r.id}" ${Number(r.id) === Number(selectedId) ? 'selected' : ''}>
      ${escapeHtml(r.name)} (${escapeHtml(r.vidName || 'Без вида')})
    </option>
  `).join('');
}

function vidOptions(selectedId) {
  return vidyRabot.map(v => `
    <option value="${v.id}" ${Number(v.id) === Number(selectedId) ? 'selected' : ''}>
      ${escapeHtml(v.name)}
    </option>
  `).join('');
}

async function refreshContent() {
  await loadVidyRabot();
  await loadRaboty();
  await loadArticles();
  renderVidyRabot();
  renderRaboty();
}

function openEditArticle(id) {
  const article = articles.find(item => item.id === id);
  if (!article) return;

  const currentFile = article.file
    ? `<div class="edit-current-file">Текущий файл:
         <a href="${escapeAttr(article.file)}" target="_blank" rel="noopener">${escapeHtml(article.file.split('/').pop())}</a>
       </div>`
    : '<div class="edit-current-file">Файл не прикреплён</div>';

  openModal(`
    <h2>Редактировать инструкцию</h2>
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
        <label for="edit-article-content">Текст инструкции <span class="required">*</span></label>
        <textarea id="edit-article-content" rows="10" required>${escapeHtml(article.content || '')}</textarea>
      </div>

      <div class="form-group">
        <label for="edit-article-file">Заменить PDF (необязательно)</label>
        <input type="file" id="edit-article-file" accept=".pdf">
        ${currentFile}
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="edit-article-cancel">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `);

  document.getElementById('edit-article-cancel').addEventListener('click', closeModal);
  document.getElementById('edit-article-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const title = document.getElementById('edit-article-title').value.trim();
    const rabotaId = document.getElementById('edit-article-rabota').value;
    const keywords = document.getElementById('edit-article-keywords').value.trim();
    const content = document.getElementById('edit-article-content').value.trim();
    const file = document.getElementById('edit-article-file').files[0];

    if (!title || !rabotaId || !content) {
      alert('Заполните название, работу и текст инструкции');
      return;
    }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('rabotaId', rabotaId);
    formData.append('keywords', keywords);
    formData.append('content', content);
    if (file) formData.append('pdfFile', file);

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохранение...';

    try {
      const response = await apiFetch(`${API_BASE}/articles/${article.id}`, {
        method: 'PUT',
        body: formData
      });
      const data = await response.json();

      if (!data.success) {
        alert('Ошибка: ' + (data.error || 'Не удалось сохранить статью'));
        return;
      }

      closeModal();
      await loadArticles();
    } catch (error) {
      if (isAuthError(error)) return;
      alert('Ошибка подключения к серверу');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Сохранить';
    }
  });
}

function openEditRabota(id) {
  const rabota = raboty.find(item => item.id === id);
  if (!rabota) return;

  openModal(`
    <h2>Редактировать работу</h2>
    <form id="edit-rabota-form" class="modal-form">
      <div class="form-row">
        <div class="form-group">
          <label for="edit-rabota-name">Название <span class="required">*</span></label>
          <input type="text" id="edit-rabota-name" value="${escapeAttr(rabota.name)}" required>
        </div>
        <div class="form-group">
          <label for="edit-rabota-vid">Вид работ <span class="required">*</span></label>
          <select id="edit-rabota-vid" required>${vidOptions(rabota.vidId)}</select>
        </div>
      </div>

      <div class="form-group">
        <label for="edit-rabota-description">Описание</label>
        <textarea id="edit-rabota-description" rows="4">${escapeHtml(rabota.description || '')}</textarea>
      </div>

      <div class="form-group">
        <label for="edit-rabota-instruction">Инструкция</label>
        <textarea id="edit-rabota-instruction" rows="8">${escapeHtml(rabota.instruction || '')}</textarea>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="edit-rabota-cancel">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `);

  document.getElementById('edit-rabota-cancel').addEventListener('click', closeModal);
  document.getElementById('edit-rabota-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const name = document.getElementById('edit-rabota-name').value.trim();
    const vidId = document.getElementById('edit-rabota-vid').value;
    const description = document.getElementById('edit-rabota-description').value.trim();
    const instruction = document.getElementById('edit-rabota-instruction').value.trim();

    if (!name || !vidId) {
      alert('Заполните название и выберите вид работ');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохранение...';

    try {
      const response = await apiFetch(`${API_BASE}/raboty/${rabota.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          vidId: parseInt(vidId, 10),
          description: description || null,
          instruction: instruction || null
        })
      });
      const data = await response.json();

      if (!data.success) {
        alert('Ошибка: ' + (data.error || 'Не удалось сохранить работу'));
        return;
      }

      closeModal();
      await refreshContent();
    } catch (error) {
      if (isAuthError(error)) return;
      alert('Ошибка подключения к серверу');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Сохранить';
    }
  });
}

function openEditVid(id) {
  const vid = vidyRabot.find(item => item.id === id);
  if (!vid) return;

  openModal(`
    <h2>Редактировать вид работ</h2>
    <form id="edit-vid-form" class="modal-form">
      <div class="form-group">
        <label for="edit-vid-name">Название <span class="required">*</span></label>
        <input type="text" id="edit-vid-name" value="${escapeAttr(vid.name)}" required>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="edit-vid-cancel">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `);

  document.getElementById('edit-vid-cancel').addEventListener('click', closeModal);
  document.getElementById('edit-vid-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const name = document.getElementById('edit-vid-name').value.trim();

    if (!name) {
      alert('Введите название вида работ');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохранение...';

    try {
      const response = await apiFetch(`${API_BASE}/vidy-rabot/${vid.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await response.json();

      if (!data.success) {
        alert('Ошибка: ' + (data.error || 'Не удалось сохранить вид работ'));
        return;
      }

      closeModal();
      await refreshContent();
      populateFilterRabotyVid();
    } catch (error) {
      if (isAuthError(error)) return;
      alert('Ошибка подключения к серверу');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Сохранить';
    }
  });
}

function openArticleModal(id) {
  const article = articles.find(a => a.id === id);
  if (!article) return;
  
  modalBody.innerHTML = `
    <div class="article-badges">
      ${article.vidName ? `<span class="badge badge-vid">${escapeHtml(article.vidName)}</span>` : ''}
      ${article.rabotaName ? `<span class="badge badge-rabota">${escapeHtml(article.rabotaName)}</span>` : ''}
    </div>
    <h2>${escapeHtml(article.title)}</h2>
    <div class="article-meta">
      <span>${escapeHtml(article.authorName || 'Неизвестен')}</span>
      <span>${article.publishDate || 'Без даты'}</span>
    </div>
    <div class="article-text">${escapeHtml(article.content || '')}</div>
    ${article.keywords ? `
      <div class="article-keywords">
        ${article.keywords.split(',').map(kw => `<span>${escapeHtml(kw.trim())}</span>`).join('')}
      </div>
    ` : ''}
  `;
  
  modal.classList.remove('hidden');
}

async function confirmDeleteArticle(id) {
  if (!confirm('Вы уверены, что хотите удалить эту статью?')) return;
  
  try {
    const response = await apiFetch(`${API_BASE}/articles/${id}`, { method: 'DELETE' });
    const data = await response.json();
    
    if (data.success) {
      await loadArticles();
    } else {
      alert('Ошибка удаления: ' + (data.error || 'Неизвестная ошибка'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

function populateRabotySelect() {
  const select = document.getElementById('article-rabota');
  select.innerHTML = '<option value="">Выберите работу</option>';
  raboty.forEach(r => {
    select.innerHTML += `<option value="${r.id}">${escapeHtml(r.name)} (${escapeHtml(r.vidName || 'Без вида')})</option>`;
  });
}

async function handleAddArticle(e) {
  e.preventDefault();
  
  const title = document.getElementById('article-title').value.trim();
  const rabotaId = document.getElementById('article-rabota').value;
  const keywords = document.getElementById('article-keywords').value.trim();
  const content = document.getElementById('article-content').value.trim();
  const pdfFile = document.getElementById('article-pdf').files[0];
  
  const successEl = document.getElementById('article-success');
  const errorEl = document.getElementById('article-error');
  
  successEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  
  if (!title || !rabotaId || !content) {
    showError(errorEl, 'Заполните обязательные поля: название, работа, текст статьи');
    return;
  }
  
  try {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('rabotaId', rabotaId);
    formData.append('keywords', keywords || '');
    formData.append('content', content);
    
    if (pdfFile) {
      formData.append('pdfFile', pdfFile);
    }
    
    const response = await apiFetch(`${API_BASE}/articles`, {
      method: 'POST',
      body: formData
    });
    
    const data = await response.json();
    
    if (data.success) {
      successEl.textContent = 'Инструкция успешно опубликована!';
      successEl.classList.remove('hidden');
      
      document.getElementById('article-title').value = '';
      document.getElementById('article-rabota').value = '';
      document.getElementById('article-keywords').value = '';
      document.getElementById('article-content').value = '';
      document.getElementById('article-pdf').value = '';
      document.getElementById('char-count').textContent = '0';
      
      document.getElementById('file-upload-text').textContent = 'Выберите PDF-файл или перетащите сюда';
      document.querySelector('.file-upload-label').classList.remove('has-file');
      document.getElementById('clear-pdf').classList.add('hidden');
      
      await loadArticles();
    } else {
      showError(errorEl, data.error || 'Ошибка добавления инструкции');
    }
  } catch (error) {
    if (isAuthError(error)) return;
    showError(errorEl, 'Ошибка подключения к серверу');
  }
}


function renderUsers() {
  const container = document.getElementById('users-list');
  
  container.innerHTML = users.map(user => `
    <tr class="${user.id === currentUser.id ? 'current-user' : ''}">
      <td class="user-id">#${user.id}</td>
      <td>
        <div class="user-cell">
          <div class="user-avatar">${user.fullName.charAt(0)}</div>
          <div>
            <div class="user-cell-name">${escapeHtml(user.fullName)}</div>
            ${user.id === currentUser.id ? '<div class="user-cell-you">(Вы)</div>' : ''}
          </div>
        </div>
      </td>
      <td class="user-tabnumber">${escapeHtml(user.tabNumber)}</td>
      <td>
        <span id="role-display-${user.id}">
          <span class="role-badge ${getRoleClass(user.role)}">
            ${getRoleIcon(user.role)} ${user.role}
          </span>
        </span>
        <span id="role-edit-${user.id}" class="hidden">
          <select class="role-select" id="role-select-${user.id}">
            <option value="Монтажник" ${user.role === 'Монтажник' ? 'selected' : ''}>Монтажник</option>
            <option value="Старший монтажник" ${user.role === 'Старший монтажник' ? 'selected' : ''}>Старший монтажник</option>
            <option value="Инженер ПТО" ${user.role === 'Инженер ПТО' ? 'selected' : ''}>Инженер ПТО</option>
            <option value="Администратор" ${user.role === 'Администратор' ? 'selected' : ''}>Администратор</option>
          </select>
          <div class="confirm-btns">
            <button class="btn btn-primary btn-sm" onclick="saveRole(${user.id})">✓</button>
            <button class="btn btn-secondary btn-sm" onclick="cancelEditRole(${user.id})">✗</button>
          </div>
        </span>
      </td>
      <td>
        <div class="actions-cell">
          ${user.id !== currentUser.id ? `
            <button class="action-btn edit" onclick="editRole(${user.id})" title="Изменить должность">Изменить</button>
            <button class="action-btn delete" onclick="confirmDeleteUser(${user.id})" title="Удалить">Удалить</button>
          ` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function editRole(id) {
  document.getElementById(`role-display-${id}`).classList.add('hidden');
  document.getElementById(`role-edit-${id}`).classList.remove('hidden');
}

function cancelEditRole(id) {
  document.getElementById(`role-display-${id}`).classList.remove('hidden');
  document.getElementById(`role-edit-${id}`).classList.add('hidden');
}

async function saveRole(id) {
  const newRole = document.getElementById(`role-select-${id}`).value;
  
  try {
    const response = await apiFetch(`${API_BASE}/sotrudniki/${id}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole })
    });
    
    const data = await response.json();
    
    if (data.success) {
      await loadUsers();
    } else {
      alert('Ошибка: ' + (data.error || 'Не удалось изменить должность'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

async function confirmDeleteUser(id) {
  if (!confirm('Вы уверены, что хотите удалить этого сотрудника?')) return;
  
  try {
    const response = await apiFetch(`${API_BASE}/sotrudniki/${id}`, { method: 'DELETE' });
    const data = await response.json();
    
    if (data.success) {
      await loadUsers();
    } else {
      alert('Ошибка: ' + (data.error || 'Не удалось удалить сотрудника'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

async function handleAddUser(e) {
  e.preventDefault();
  
  const fullName = document.getElementById('new-fullname').value.trim();
  const tabNumber = document.getElementById('new-tabnumber').value.trim();
  const password = document.getElementById('new-password').value.trim();
  const role = document.getElementById('new-role').value;
  
  const errorEl = document.getElementById('user-form-error');
  const successEl = document.getElementById('user-form-success');
  
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');
  
  if (!fullName || !tabNumber || !password) {
    showError(errorEl, 'Заполните все поля');
    return;
  }
  
  try {
    const response = await apiFetch(`${API_BASE}/sotrudniki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabNumber, password, fullName, role })
    });
    
    const data = await response.json();
    
    if (data.success) {
      successEl.textContent = 'Сотрудник успешно добавлен!';
      successEl.classList.remove('hidden');
      
      document.getElementById('new-fullname').value = '';
      document.getElementById('new-tabnumber').value = '';
      document.getElementById('new-password').value = '';
      document.getElementById('new-role').value = 'Монтажник';
      
      await loadUsers();
    } else {
      showError(errorEl, data.error || 'Ошибка добавления сотрудника');
    }
  } catch (error) {
    if (isAuthError(error)) return;
    showError(errorEl, 'Ошибка подключения к серверу');
  }
}


function renderVidyRabot() {
  const container = document.getElementById('vidy-rabot-list');
  const emptyState = document.getElementById('vidy-rabot-empty');
  
  if (vidyRabot.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }
  
  emptyState.classList.add('hidden');

  const countByVid = {};
  raboty.forEach(r => {
    countByVid[r.vidId] = (countByVid[r.vidId] || 0) + 1;
  });
  
  container.innerHTML = vidyRabot.map(vid => `
    <tr>
      <td class="user-id">#${vid.id}</td>
      <td>
        <span class="badge badge-vid" style="font-size: 14px;">${escapeHtml(vid.name)}</span>
      </td>
      <td>
        <div class="actions-cell">
          <button class="action-btn edit" onclick="openEditVid(${vid.id})" title="Редактировать">✏️</button>
          <button class="action-btn delete" onclick="confirmDeleteVid(${vid.id})" title="Удалить">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function handleAddVidRabot(e) {
  e.preventDefault();
  
  const name = document.getElementById('new-vid-name').value.trim();
  const errorEl = document.getElementById('vid-form-error');
  const successEl = document.getElementById('vid-form-success');
  
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');
  
  if (!name) {
    showError(errorEl, 'Введите название вида работ');
    return;
  }
  
  try {
    const response = await apiFetch(`${API_BASE}/vidy-rabot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    
    const data = await response.json();
    
    if (data.success) {
      successEl.textContent = 'Вид работ успешно добавлен!';
      successEl.classList.remove('hidden');
      document.getElementById('new-vid-name').value = '';
      
      await loadVidyRabot();
      renderVidyRabot();
    } else {
      showError(errorEl, data.error || 'Ошибка добавления');
    }
  } catch (error) {
    if (isAuthError(error)) return;
    showError(errorEl, 'Ошибка подключения к серверу');
  }
}

async function confirmDeleteVid(id) {
  const hasRaboty = raboty.some(r => r.vidId === id);
  if (hasRaboty) {
    alert('Невозможно удалить вид работ: есть связанные работы.\nСначала удалите все работы этого вида.');
    return;
  }
  
  if (!confirm('Удалить этот вид работ?')) return;
  
  try {
    const response = await apiFetch(`${API_BASE}/vidy-rabot/${id}`, { method: 'DELETE' });
    const data = await response.json();
    
    if (data.success) {
      await loadVidyRabot();
      renderVidyRabot();
    } else {
      alert('Ошибка: ' + (data.error || 'Не удалось удалить'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

function populateFilterRabotyVid() {
  const select = document.getElementById('filter-raboty-vid');
  select.innerHTML = '<option value="all">Все виды работ</option>';
  vidyRabot.forEach(vid => {
    select.innerHTML += `<option value="${vid.id}">${escapeHtml(vid.name)}</option>`;
  });
}

function populateVidSelectForRabota() {
  const select = document.getElementById('new-rabota-vid');
  select.innerHTML = '<option value="">Выберите вид работ</option>';
  vidyRabot.forEach(vid => {
    select.innerHTML += `<option value="${vid.id}">${escapeHtml(vid.name)}</option>`;
  });
}

function renderRaboty() {
  const container = document.getElementById('raboty-list');
  const emptyState = document.getElementById('raboty-empty');

  let filtered = raboty.filter(r => {
    const matchesVid = filterRabotyVid === 'all' || r.vidId == filterRabotyVid;
    const matchesSearch = r.name.toLowerCase().includes(searchRaboty) ||
                          (r.description && r.description.toLowerCase().includes(searchRaboty)) ||
                          (r.instruction && r.instruction.toLowerCase().includes(searchRaboty));
    return matchesVid && matchesSearch;
  });
  
  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }
  
  emptyState.classList.add('hidden');
  
  container.innerHTML = filtered.map(r => `
    <div class="rabota-card" data-id="${r.id}">
      <div class="rabota-header" onclick="toggleRabota(${r.id})">
        <div class="rabota-header-content">
          <h3 class="rabota-title">${escapeHtml(r.name)}</h3>
          <span class="rabota-vid">${escapeHtml(r.vidName || 'Без вида')}</span>
        </div>
        <span class="rabota-expand-icon">▼</span>
      </div>
      <div class="rabota-content">
        ${r.description ? `
          <div class="rabota-section">
            <h4>Описание</h4>
            <p>${escapeHtml(r.description)}</p>
          </div>
        ` : ''}
        ${r.instruction ? `
          <div class="rabota-section">
            <h4>Инструкция</h4>
            <p>${escapeHtml(r.instruction)}</p>
          </div>
        ` : ''}
        ${!r.description && !r.instruction ? '<p style="color:#64748b;padding-top:16px;">Описание и инструкция не заполнены</p>' : ''}
        <div class="rabota-actions">
          <button class="btn btn-secondary btn-sm" onclick="openEditRabota(${r.id})">✏️ Редактировать</button>
          <button class="btn btn-danger btn-sm" onclick="confirmDeleteRabota(${r.id})">Удалить</button>
        </div>
      </div>
    </div>
  `).join('');
}

function toggleRabota(id) {
  const card = document.querySelector(`.rabota-card[data-id="${id}"]`);
  if (card) card.classList.toggle('expanded');
}

async function handleAddRabota(e) {
  e.preventDefault();
  
  const name = document.getElementById('new-rabota-name').value.trim();
  const vidId = document.getElementById('new-rabota-vid').value;
  const description = document.getElementById('new-rabota-description').value.trim();
  const instruction = document.getElementById('new-rabota-instruction').value.trim();
  
  const errorEl = document.getElementById('rabota-form-error');
  const successEl = document.getElementById('rabota-form-success');
  
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');
  
  if (!name || !vidId) {
    showError(errorEl, 'Заполните название и выберите вид работ');
    return;
  }
  
  try {
    const response = await apiFetch(`${API_BASE}/raboty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        vidId: parseInt(vidId),
        description: description || null,
        instruction: instruction || null
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      successEl.textContent = 'Работа успешно добавлена!';
      successEl.classList.remove('hidden');
      
      document.getElementById('new-rabota-name').value = '';
      document.getElementById('new-rabota-vid').value = '';
      document.getElementById('new-rabota-description').value = '';
      document.getElementById('new-rabota-instruction').value = '';
      
      await loadRaboty();
      renderRaboty();

      populateRabotySelect();
    } else {
      showError(errorEl, data.error || 'Ошибка добавления');
    }
  } catch (error) {
    if (isAuthError(error)) return;
    showError(errorEl, 'Ошибка подключения к серверу');
  }
}

async function confirmDeleteRabota(id) {
  const hasArticles = articles.some(a => a.rabotaId === id);
  if (hasArticles) {
    alert('Невозможно удалить работу: есть связанные статьи.\nСначала удалите все статьи по этой работе.');
    return;
  }
  
  if (!confirm('Удалить эту работу?')) return;
  
  try {
    const response = await apiFetch(`${API_BASE}/raboty/${id}`, { method: 'DELETE' });
    const data = await response.json();
    
    if (data.success) {
      await loadRaboty();
      renderRaboty();
      populateRabotySelect();
    } else {
      alert('Ошибка: ' + (data.error || 'Не удалось удалить'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

// === МОДУЛЬ ПТО ==========================================================

function canManagePto() {
  return Boolean(currentUser) &&
    (currentUser.role === 'Администратор' || currentUser.role === 'Инженер ПТО');
}

function applyPtoPermissions() {
  const allowed = canManagePto();

  document.getElementById('show-add-doc').classList.toggle('hidden', !allowed);
  document.getElementById('show-add-object').classList.toggle('hidden', !allowed);

  if (!allowed) {
    document.getElementById('add-object-form').classList.add('hidden');
  }
}

function ptoStatusClass(status) {
  switch (status) {
    case 'Черновик': return 'draft';
    case 'На проверке': return 'check';
    case 'На согласовании': return 'review';
    case 'Утверждён': return 'approved';
    case 'Отклонён': return 'rejected';
    case 'В архиве': return 'archived';
    default: return 'draft';
  }
}

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

function isPtoOverdue(doc) {
  if (!doc.dueDate) return false;
  if (doc.status === 'Утверждён' || doc.status === 'В архиве') return false;

  return String(doc.dueDate).slice(0, 10) < todayIso();
}

function formatDateTime(value) {
  if (!value) return '—';

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : formatDate(value);
}

async function loadPtoObjects() {
  try {
    const response = await apiFetch(`${API_BASE}/objects`);
    const data = await response.json();
    ptoObjects = data.data || [];
  } catch (error) {
    if (isAuthError(error)) return;
    console.error('Ошибка загрузки объектов:', error);
    ptoObjects = [];
  }

  renderPtoFilterOptions();
  renderObjects();
}

async function loadPtoDocuments() {
  const params = new URLSearchParams();

  if (ptoFilterType !== 'all') params.set('type', ptoFilterType);
  if (ptoFilterObject !== 'all') params.set('objectId', ptoFilterObject);
  if (ptoFilterStatus !== 'all') params.set('status', ptoFilterStatus);
  if (ptoSearch) params.set('q', ptoSearch);
  if (ptoOnlyOverdue) params.set('overdue', '1');

  // Номер запроса отсекает устаревшие ответы, если фильтры меняли быстро.
  const requestId = ++ptoLoadRequestId;

  try {
    const response = await apiFetch(`${API_BASE}/pto?${params.toString()}`);
    const data = await response.json();

    if (requestId !== ptoLoadRequestId) return;

    ptoDocuments = data.data || [];
  } catch (error) {
    if (isAuthError(error)) return;
    if (requestId !== ptoLoadRequestId) return;
    console.error('Ошибка загрузки документов ПТО:', error);
    ptoDocuments = [];
  }

  renderPtoStats();
  renderPtoTable();
}

function renderPtoFilterOptions() {
  const typeSelect = document.getElementById('pto-filter-type');
  typeSelect.innerHTML = '<option value="all">Все типы документов</option>' +
    PTO_TYPES.map(type => `<option value="${escapeAttr(type)}">${escapeHtml(type)}</option>`).join('');
  typeSelect.value = ptoFilterType;

  const objectSelect = document.getElementById('pto-filter-object');
  objectSelect.innerHTML = '<option value="all">Все объекты</option>' +
    ptoObjects.map(object => `<option value="${object.id}">${escapeHtml(object.name)}</option>`).join('');
  objectSelect.value = ptoFilterObject;

  const statusSelect = document.getElementById('pto-filter-status');
  statusSelect.innerHTML = '<option value="all">Все статусы</option>' +
    PTO_STATUSES.map(status => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`).join('');
  statusSelect.value = ptoFilterStatus;
}

function renderPtoStats() {
  const container = document.getElementById('pto-stats');
  if (!container) return;

  const total = ptoDocuments.length;
  const inWork = ptoDocuments.filter(doc =>
    doc.status === 'На проверке' || doc.status === 'На согласовании').length;
  const approved = ptoDocuments.filter(doc => doc.status === 'Утверждён').length;
  const overdue = ptoDocuments.filter(isPtoOverdue).length;

  container.innerHTML = `
    <div class="stat-card">
      <div class="number">${total}</div>
      <div class="label">Найдено документов</div>
    </div>
    <div class="stat-card">
      <div class="number blue">${inWork}</div>
      <div class="label">В работе</div>
    </div>
    <div class="stat-card">
      <div class="number green">${approved}</div>
      <div class="label">Утверждено</div>
    </div>
    <div class="stat-card">
      <div class="number ${overdue ? 'red' : 'yellow'}">${overdue}</div>
      <div class="label">Просрочено</div>
    </div>
  `;
}

function renderPtoTable() {
  const container = document.getElementById('pto-list');
  const emptyState = document.getElementById('pto-empty');

  if (!container) return;

  if (ptoDocuments.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  container.innerHTML = ptoDocuments.map(doc => {
    const overdue = isPtoOverdue(doc);
    const shortType = PTO_TYPE_SHORT[doc.type] || doc.type;
    const revision = Number(doc.version) > 1 ? ` · ред. ${doc.version}` : '';

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

async function openPtoDoc(id) {
  let doc;

  try {
    const response = await apiFetch(`${API_BASE}/pto/${id}`);
    const data = await response.json();

    if (!data.success) {
      alert('Ошибка: ' + (data.error || 'не удалось открыть документ'));
      return;
    }

    doc = data.data;
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
    return;
  }

  const overdue = isPtoOverdue(doc);
  const canManage = canManagePto();
  const shortType = PTO_TYPE_SHORT[doc.type] || doc.type;

  const historyHtml = (doc.history || []).map(entry => {
    const statusDelta = [entry.statusFrom, entry.statusTo].filter(Boolean).join(' → ');
    const meta = [
      statusDelta,
      entry.version ? `ред. ${entry.version}` : '',
      entry.author || ''
    ].filter(Boolean).join(' · ');

    return `
      <li>
        <div class="pto-history-action">
          <strong>${escapeHtml(entry.action)}</strong>
          <span class="pto-history-date">${formatDateTime(entry.date)}</span>
        </div>
        ${meta ? `<div class="pto-history-meta">${escapeHtml(meta)}</div>` : ''}
        ${entry.comment ? `<div class="pto-history-comment">${escapeHtml(entry.comment)}</div>` : ''}
      </li>
    `;
  }).join('');

  const statusOptions = PTO_STATUSES
    .filter(status => status !== doc.status)
    .map(status => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`)
    .join('');

  openModal(`
    <div class="pto-detail">
      <div class="pto-detail-top">
        <span class="pto-type-chip" title="${escapeAttr(doc.type)}">${escapeHtml(shortType)}</span>
        <span class="status-badge ${ptoStatusClass(doc.status)}">${escapeHtml(doc.status)}</span>
        ${overdue ? '<span class="status-badge rejected">Просрочен</span>' : ''}
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

      ${doc.file ? `
        <div class="pdf-actions">
          <a href="${escapeAttr(doc.file)}" target="_blank" rel="noopener" class="pdf-download-btn">📄 Открыть файл</a>
          <a href="${escapeAttr(doc.file)}" download class="pdf-download-btn">Скачать файл</a>
        </div>
      ` : ''}

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
        </div>
      ` : ''}

      <div class="pto-history">
        <h3>История документа</h3>
        ${historyHtml
          ? `<ul class="pto-history-list">${historyHtml}</ul>`
          : '<p class="card-hint">Записей пока нет</p>'}
      </div>
    </div>
  `);
}

async function changePtoStatus(id) {
  const status = document.getElementById('pto-status-select').value;
  const comment = document.getElementById('pto-status-comment').value.trim();

  try {
    const response = await apiFetch(`${API_BASE}/pto/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, comment })
    });

    const data = await response.json();

    if (data.success) {
      await loadPtoDocuments();
      await openPtoDoc(id);
    } else {
      alert('Ошибка: ' + (data.error || 'не удалось сменить статус'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

async function openPtoForm(docId = null) {
  if (!canManagePto()) return;

  let doc = null;

  if (docId) {
    try {
      const response = await apiFetch(`${API_BASE}/pto/${docId}`);
      const data = await response.json();

      if (!data.success) {
        alert('Ошибка: ' + (data.error || 'не удалось открыть документ'));
        return;
      }

      doc = data.data;
    } catch (error) {
      if (isAuthError(error)) return;
      alert('Ошибка подключения к серверу');
      return;
    }
  }

  const typeOptions = PTO_TYPES.map(type => `
    <option value="${escapeAttr(type)}" ${doc && doc.type === type ? 'selected' : ''}>${escapeHtml(type)}</option>
  `).join('');

  const objectOptions = ptoObjects.map(object => `
    <option value="${object.id}" ${doc && Number(doc.objectId) === Number(object.id) ? 'selected' : ''}>
      ${escapeHtml(object.name)}
    </option>
  `).join('');

  const statusOptions = PTO_STATUSES.map(status => `
    <option value="${escapeAttr(status)}" ${doc ? (doc.status === status ? 'selected' : '') : (status === 'Черновик' ? 'selected' : '')}>
      ${escapeHtml(status)}
    </option>
  `).join('');

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
          <select id="pto-form-object">
            <option value="">Без объекта</option>
            ${objectOptions}
          </select>
        </div>
      </div>

      <div class="form-group">
        <label for="pto-form-title">Наименование <span class="required">*</span></label>
        <input type="text" id="pto-form-title" value="${escapeAttr(doc ? doc.title : '')}" placeholder="Например: Исполнительная документация по вентиляции" required>
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
        <textarea id="pto-form-content" rows="5" placeholder="Что входит в документ, замечания, комментарии">${escapeHtml(doc ? (doc.content || '') : '')}</textarea>
      </div>

      <div class="form-group">
        <label for="pto-form-file">Файл документа (PDF, DOC, DOCX, XLS, XLSX)</label>
        <input type="file" id="pto-form-file" accept=".pdf,.doc,.docx,.xls,.xlsx" class="pto-file-input">
        <p class="file-hint">Максимальный размер: 20 МБ${doc && doc.file ? ' · текущий файл сохранится, если не выбрать новый' : ''}</p>
      </div>

      ${doc ? `
        <label class="pto-checkbox">
          <input type="checkbox" id="pto-form-revision">
          <span>Отметить как новую редакцию (версия ${Number(doc.version) + 1})</span>
        </label>
      ` : ''}

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">${doc ? 'Сохранить изменения' : 'Добавить документ'}</button>
      </div>
    </form>
  `);

  document.getElementById('pto-doc-form').addEventListener('submit', (e) => handlePtoSubmit(e, doc));
}

async function handlePtoSubmit(e, doc) {
  e.preventDefault();

  const errorEl = document.getElementById('pto-form-error');
  errorEl.classList.add('hidden');

  const type = document.getElementById('pto-form-type').value;
  const title = document.getElementById('pto-form-title').value.trim();

  if (!title) {
    showError(errorEl, 'Введите наименование документа');
    return;
  }

  const formData = new FormData();
  formData.append('type', type);
  formData.append('title', title);
  formData.append('objectId', document.getElementById('pto-form-object').value || '');
  formData.append('cipher', document.getElementById('pto-form-cipher').value.trim());
  formData.append('projectSection', document.getElementById('pto-form-section').value.trim());
  formData.append('status', document.getElementById('pto-form-status').value);
  formData.append('dueDate', document.getElementById('pto-form-due').value || '');
  formData.append('responsible', document.getElementById('pto-form-responsible').value.trim());
  formData.append('content', document.getElementById('pto-form-content').value.trim());

  const fileInput = document.getElementById('pto-form-file');
  if (fileInput.files[0]) {
    formData.append('docFile', fileInput.files[0]);
  }

  if (doc) {
    const revisionInput = document.getElementById('pto-form-revision');
    formData.append('newRevision', revisionInput && revisionInput.checked ? 'true' : 'false');
  }

  try {
    const response = await apiFetch(doc ? `${API_BASE}/pto/${doc.id}` : `${API_BASE}/pto`, {
      method: doc ? 'PUT' : 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.success) {
      const savedId = doc ? doc.id : data.data.id;
      closeModal();
      await loadPtoDocuments();
      await openPtoDoc(savedId);
    } else {
      showError(errorEl, data.error || 'Не удалось сохранить документ');
    }
  } catch (error) {
    if (isAuthError(error)) return;
    showError(errorEl, 'Ошибка подключения к серверу');
  }
}

async function deletePtoDoc(id) {
  if (!confirm('Удалить документ ПТО? Записи истории документа тоже будут удалены.')) return;

  try {
    const response = await apiFetch(`${API_BASE}/pto/${id}`, { method: 'DELETE' });
    const data = await response.json();

    if (data.success) {
      closeModal();
      await loadPtoDocuments();
    } else {
      alert('Ошибка: ' + (data.error || 'не удалось удалить документ'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

function exportPtoRegistry() {
  const params = new URLSearchParams();

  if (ptoFilterType !== 'all') params.set('type', ptoFilterType);
  if (ptoFilterObject !== 'all') params.set('objectId', ptoFilterObject);
  if (ptoFilterStatus !== 'all') params.set('status', ptoFilterStatus);
  if (ptoSearch) params.set('q', ptoSearch);
  if (ptoOnlyOverdue) params.set('overdue', '1');

  const query = params.toString();
  window.location.href = `${API_BASE}/pto/export.csv${query ? '?' + query : ''}`;
}

function renderObjects() {
  const container = document.getElementById('objects-list');
  if (!container) return;

  if (ptoObjects.length === 0) {
    container.innerHTML = '<p class="card-hint">Объекты пока не добавлены</p>';
    return;
  }

  container.innerHTML = ptoObjects.map(object => {
    const details = [object.address, object.customer].filter(Boolean).map(value => escapeHtml(value)).join(' · ');

    return `
      <div class="object-row">
        <div class="object-main">
          <strong>${escapeHtml(object.name)}</strong>
          <span>${details || 'адрес и заказчик не указаны'}</span>
        </div>
        <span class="object-count">${object.documentsCount} док.</span>
        ${canManagePto() ? `<button type="button" class="action-btn delete" onclick="deleteObject(${object.id})">Удалить</button>` : ''}
      </div>
    `;
  }).join('');
}

async function handleAddObject(e) {
  e.preventDefault();

  const errorEl = document.getElementById('object-form-error');
  const successEl = document.getElementById('object-form-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const name = document.getElementById('new-object-name').value.trim();
  const address = document.getElementById('new-object-address').value.trim();
  const customer = document.getElementById('new-object-customer').value.trim();

  if (!name) {
    showError(errorEl, 'Введите название объекта');
    return;
  }

  try {
    const response = await apiFetch(`${API_BASE}/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, address, customer })
    });

    const data = await response.json();

    if (data.success) {
      successEl.textContent = 'Объект добавлен';
      successEl.classList.remove('hidden');
      document.getElementById('new-object-name').value = '';
      document.getElementById('new-object-address').value = '';
      document.getElementById('new-object-customer').value = '';
      await loadPtoObjects();
    } else {
      showError(errorEl, data.error || 'Не удалось добавить объект');
    }
  } catch (error) {
    if (isAuthError(error)) return;
    showError(errorEl, 'Ошибка подключения к серверу');
  }
}

async function deleteObject(id) {
  if (!confirm('Удалить объект? Удалить можно только объект без документов.')) return;

  try {
    const response = await apiFetch(`${API_BASE}/objects/${id}`, { method: 'DELETE' });
    const data = await response.json();

    if (data.success) {
      await loadPtoObjects();
      await loadPtoDocuments();
    } else {
      alert('Ошибка: ' + (data.error || 'не удалось удалить объект'));
    }
  } catch (error) {
    if (isAuthError(error)) return;
    alert('Ошибка подключения к серверу');
  }
}

function showError(element, message) {
  element.textContent = message;
  element.classList.remove('hidden');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return escapeHtml(String(text ?? ''))
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '—';

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value);
}

function canManageContent() {
  return Boolean(currentUser) &&
    (currentUser.role === 'Администратор' || currentUser.role === 'Старший монтажник');
}

function getRoleClass(role) {
  switch (role) {
    case 'Администратор': return 'admin';
    case 'Старший монтажник': return 'senior';
    case 'Инженер ПТО': return 'pto';
    case 'Монтажник': return 'worker';
    default: return '';
  }
}

function getRoleIcon(role) {
  switch (role) {
    case 'Администратор': return '';
    case 'Старший монтажник': return '';
    case 'Инженер ПТО': return '';
    case 'Монтажник': return '';
    default: return '';
  }
}
