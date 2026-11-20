// Модуль использует сеанс, CSRF, навигацию и экранирование общей оболочки.
const taskUI = (() => {
  const panel = $('task-panel');
  const labels = { active:'Активные', overdue:'Просроченные', review:'На проверке', done:'Выполненные' };
  let meta, current, scope = 'all', metric = '', page = 1, listRequest = 0, cardRequest = 0, debounce;
  const base = API_BASE + '/tasks';
  const option = (value,label) => `<option value="${escapeAttr(value)}">${escapeHtml(label)}</option>`;
  const body = (method, data) => ({ method, headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(data) });
  const dateTime = value => value ? new Date(value.replace(' ','T')+'Z').toLocaleString('ru-RU') : '—';
  const report = error => { if (!(error instanceof AuthError)) toast(error.message,'error'); };

  async function accessChanged() {
    const session = await apiJson(API_BASE + '/auth/session');
    if (state.user && session.user.role !== state.user.role) {
      window.location.reload();
      return;
    }
    state.user = session.user;
    state.permissions = session.permissions;
    applyRoleVisibility();
    if (!state.permissions.pto) {
      if (panel.open) panel.close();
      $('task-rows').replaceChildren();
      $('task-metrics').replaceChildren();
      hideSearch();
      if (state.currentPage === 'tasks') await navigateTo('dashboard');
    }
  }

  function selectOptions(id, first, options) {
    const select = $(id), old = select.value;
    select.innerHTML = option('',first) + options;
    if ([...select.options].some(o => o.value === old)) select.value = old;
  }
  async function load() {
    if (!state.permissions.pto) return;
    try {
      const [fresh,objects] = await Promise.all([apiJson(base+'/meta'),apiJson(API_BASE+'/objects')]);
      meta = { ...fresh,objects:objects.data };
      selectOptions('task-object','Все объекты',meta.objects.map(o=>option(o.id,o.name)).join(''));
      selectOptions('task-status','Все статусы',meta.statuses.map(s=>option(s,s)).join(''));
      selectOptions('task-priority','Все приоритеты',meta.priorities.map(s=>option(s,s)).join(''));
      await refresh();
    } catch (error) {
      if (error.status === 403) await accessChanged(); else report(error);
    }
  }
  async function refresh() {
    if (state.currentPage !== 'tasks' || !state.permissions.pto) return;
    const token = ++listRequest;
    const params = new URLSearchParams({ scope,sort:$('task-sort').value,page,limit:25 });
    for (const [key,id] of [['q','task-q'],['objectId','task-object'],['status','task-status'],['priority','task-priority']]) {
      if ($(id).value) params.set(key,$(id).value);
    }
    try {
      const [counts,rows] = await Promise.all([apiJson(base+'/summary?'+params),apiJson(base+'?'+params+(metric?'&metric='+metric:''))]);
      if (token !== listRequest || state.currentPage !== 'tasks') return;
      $('task-metrics').innerHTML = Object.entries(labels).map(([key,label]) =>
        `<button class="stat-card" data-metric="${key}" aria-pressed="${metric === key}"><span class="metric-label">${label}</span><strong class="number">${counts.data[key]}</strong></button>`).join('');
      $('task-scopes').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.scope === (metric === 'overdue' && scope === 'all' ? 'overdue' : scope)));
      $('task-total').textContent = 'Найдено: ' + rows.total;
      $('task-rows').innerHTML = rows.data.map(t => `<tr>
        <td><button class="text-btn" data-task="${t.id}">${escapeHtml(t.title)}</button><small>${escapeHtml(t.objectName)}</small></td>
        <td>${escapeHtml(t.assignee)}</td><td class="${t.overdue?'pto-overdue':''}">${formatDate(t.dueDate)}${t.overdue?' · просрочена':''}</td>
        <td>${escapeHtml(t.priority)}</td><td><span class="status-badge">${escapeHtml(t.status)}</span></td></tr>`).join('');
      $('task-empty').hidden = rows.total > 0;
      const pages = Math.max(1,Math.ceil(rows.total/25));
      if (page > pages) { page = pages; return refresh(); }
      $('task-pager').hidden = pages === 1;
      $('task-page-number').textContent = page + ' / ' + pages;
      $('task-prev').disabled = page <= 1;
      $('task-next').disabled = page >= pages;
    } catch (error) {
      if (token !== listRequest) return;
      $('task-rows').replaceChildren();
      $('task-metrics').replaceChildren();
      if (error.status === 403) await accessChanged(); else report(error);
    }
  }

  function openPanel(heading) {
    $('task-panel-heading').textContent = heading;
    $('task-error').hidden = true;
    if (!panel.open) panel.showModal();
    document.body.classList.add('task-open');
  }
  function panelError(error) {
    if (error instanceof AuthError) return;
    $('task-error').hidden = false;
    $('task-error').textContent = error.message;
    if (error.status === 409 && current) {
      const reload = document.createElement('button');
      reload.type = 'button'; reload.className = 'text-btn'; reload.textContent = 'Обновить карточку';
      reload.onclick = () => openTask(current.id);
      $('task-error').append(' ',reload);
    }
    if (error.status === 403) accessChanged().catch(report);
    if (error.status === 404) { $('task-body').replaceChildren(); refresh(); }
  }
  async function openTask(id) {
    const token = ++cardRequest;
    current = null;
    openPanel('Карточка задачи');
    $('task-body').textContent = 'Загрузка…';
    try {
      const [result,comments,log] = await Promise.all(['','/comments','/history'].map(suffix => apiJson(base+'/'+id+suffix)));
      if (token !== cardRequest || !panel.open) return;
      current = result.data;
      const t = current, rights = t.permissions;
      const props = [['Объект',t.objectName],['Постановщик',t.creator],['Исполнитель',t.assignee],['Срок',formatDate(t.dueDate)],
        ['Приоритет',t.priority],['Создана',dateTime(t.createdAt)],['Обновлена',dateTime(t.updatedAt)]];
      $('task-body').innerHTML = `<span class="status-badge">${escapeHtml(t.status)}</span><h3 class="task-title">${escapeHtml(t.title)}</h3>
        <p class="task-copy">${escapeHtml(t.description)}</p><dl class="task-props">${props.map(([key,value])=>`<div><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
        ${t.linkedTitle ? `<button type="button" class="text-btn" id="task-link">${t.documentId?'Документ':'Замечание'} · ${escapeHtml(t.linkedTitle)}</button>` : ''}
        <div class="task-controls">${rights.actions.map(a=>`<button class="btn btn-light" data-transition="${a.key}">${escapeHtml(a.label)}</button>`).join('')}
        ${rights.edit?'<button class="btn btn-light" id="task-edit">Редактировать</button>':''}</div>
        <section><h3>Комментарии</h3>${comments.data.map(c=>`<article class="task-entry"><strong>${escapeHtml(c.author)}</strong> <time>${dateTime(c.createdAt)}</time><p>${escapeHtml(c.text)}</p></article>`).join('') || '<p class="card-hint">Пока нет комментариев</p>'}
        ${rights.comment?'<form id="task-comment"><label>Комментарий<textarea name="text" rows="2" required maxlength="5000"></textarea></label><button class="btn btn-light">Добавить комментарий</button></form>':''}</section>
        <details class="task-history"><summary>История изменений (${log.data.length})</summary>${log.data.map(e=>`<article class="task-entry"><strong>${escapeHtml(e.event)}</strong> · ${escapeHtml(e.actor)} <time>${dateTime(e.createdAt)}</time>
          <p>${[e.beforeValue,e.afterValue].filter(v=>v != null).map(escapeHtml).join(' → ')}</p>${e.reason?`<p>${escapeHtml(e.reason)}</p>`:''}</article>`).join('')}</details>`;
      $('task-edit')?.addEventListener('click',()=>edit(t));
      $('task-link')?.addEventListener('click',()=>{ panel.close(); t.documentId ? openPtoDoc(t.documentId) : openRemarkDetail(t.remarkId); });
      $('task-comment')?.addEventListener('submit',e=>{
        e.preventDefault();
        save(e.currentTarget,base+'/'+t.id+'/comments','POST',{text:e.currentTarget.elements.text.value},t.id);
      });
    } catch (error) { if (token === cardRequest) panelError(error); }
  }
  async function save(form,url,method,data,id) {
    const token = cardRequest;
    const button = form.querySelector('button[type=submit],button:not([type])') || form;
    if (button.disabled) return;
    button.disabled = true;
    try {
      const res = await apiJson(url,body(method,data));
      if (token === cardRequest && panel.open) await openTask(id || res.data.id);
      await refresh();
      await refreshNotificationBadge();
    } catch (error) { if (token === cardRequest) panelError(error); }
    finally { button.disabled = false; }
  }
  async function edit(t = null) {
    const token = ++cardRequest;
    current = t;
    openPanel(t?'Редактирование задачи':'Новая задача');
    const input = (label,html) => '<label>'+label+html+'</label>';
    $('task-body').innerHTML = `<form id="task-form">
      ${input('Название','<input name="title" required maxlength="240">')}
      ${input('Описание','<textarea name="description" rows="3" maxlength="10000"></textarea>')}
      ${input('Объект','<select name="objectId" required></select>')}
      ${input('Исполнитель','<select name="assigneeId" required></select>')}
      <div class="form-row">${input('Срок','<input name="dueDate" type="date">')}${input('Приоритет','<select name="priority"></select>')}</div>
      ${input('Связанная запись','<select name="link"></select>')}
      <button type="submit" class="btn btn-primary" disabled>Сохранить</button></form>`;
    const form = $('task-form'), fields = form.elements;
    fields.title.value = t?.title || ''; fields.description.value = t?.description || '';
    fields.dueDate.value = t?.dueDate || '';
    fields.priority.innerHTML = meta.priorities.map(s=>option(s,s)).join('');
    fields.priority.value = t?.priority || 'Обычный';
    fields.objectId.innerHTML = option('','Выберите объект') + meta.objects.map(o=>option(o.id,o.name)).join('');
    fields.objectId.value = t?.objectId || $('task-object').value || '';
    fields.objectId.disabled = !!t;
    let serial = 0;
    async function choices() {
      const n = ++serial, object = fields.objectId.value;
      form.querySelector('button').disabled = true;
      fields.assigneeId.replaceChildren(); fields.link.replaceChildren();
      if (!object) return;
      try {
        const [people,targets] = await Promise.all(['/assignees','/targets'].map(p=>apiJson(base+p+'?objectId='+object)));
        if (n !== serial || token !== cardRequest) return;
        fields.assigneeId.innerHTML = option('',people.data.length?'Выберите инженера ПТО':'Нет доступных инженеров') + people.data.map(p=>option(p.id,p.name)).join('');
        fields.link.innerHTML = option('','Без связи') + targets.docs.map(d=>option('d'+d.id,'Документ · '+d.title)).join('')
          + targets.remarks.map(r=>option('r'+r.id,'Замечание · '+r.title)).join('');
        fields.link.value = t?.documentId?'d'+t.documentId:t?.remarkId?'r'+t.remarkId:'';
        fields.assigneeId.value = t?.assigneeId || '';
        form.querySelector('button').disabled = !people.data.length;
      } catch (error) { if (n === serial && token === cardRequest) panelError(error); }
    }
    fields.objectId.addEventListener('change',choices);
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const link = values.link; delete values.link;
      values.documentId = link.startsWith('d')?Number(link.slice(1)):null;
      values.remarkId = link.startsWith('r')?Number(link.slice(1)):null;
      if (t) values.version = t.version;
      save(form,t?base+'/'+t.id:base,t?'PATCH':'POST',values,t?.id);
    });
    await choices();
  }

  $('task-body').addEventListener('click',e=>{
    const button = e.target.closest('[data-transition]');
    if (!button || !current) return;
    const t = current, action = button.dataset.transition;
    if (action !== 'return') {
      if (action === 'cancel' && !window.confirm('Отменить задачу?')) return;
      save(button,base+'/'+t.id+'/transitions','POST',{version:t.version,action},t.id);
      return;
    }
    if ($('task-return')) { $('task-return').elements.reason.focus(); return; }
    button.closest('.task-controls').insertAdjacentHTML('afterend','<form id="task-return"><label>Причина возврата<textarea name="reason" required maxlength="2000"></textarea></label><button class="btn btn-primary">Подтвердить возврат</button></form>');
    $('task-return').elements.reason.focus();
    $('task-return').onsubmit = event=>{
      event.preventDefault();
      save(event.currentTarget,base+'/'+t.id+'/transitions','POST',{version:t.version,action,reason:event.currentTarget.elements.reason.value},t.id);
    };
  });
  async function fromLink(id) { await navigateTo('tasks'); if (state.permissions.pto && meta) await openTask(id); }
  $('task-rows').onclick = e=>{ const b = e.target.closest('[data-task]'); if (b) openTask(b.dataset.task); };
  $('task-new').onclick = ()=>{ if (meta && state.permissions.pto) edit(); };
  $('task-close').onclick = ()=>panel.close();
  panel.onclose = ()=>{ ++cardRequest; current=null; $('task-body').replaceChildren(); document.body.classList.remove('task-open'); };
  $('task-q').oninput = ()=>{ clearTimeout(debounce); debounce=setTimeout(()=>{ page=1; refresh(); },180); };
  ['task-sort','task-object','task-status','task-priority'].forEach(id=>$(id).onchange=()=>{ page=1; refresh(); });
  $('task-metrics').onclick = e=>{ const b=e.target.closest('[data-metric]'); if (b) { metric=metric===b.dataset.metric?'':b.dataset.metric; page=1; refresh(); } };
  $('task-scopes').onclick = e=>{ const b=e.target.closest('[data-scope]'); if (b) { const s=b.dataset.scope; scope=s==='overdue'?'all':s; metric=s==='overdue'?'overdue':''; page=1; refresh(); } };
  $('task-prev').onclick = ()=>{ page--; refresh(); };
  $('task-next').onclick = ()=>{ page++; refresh(); };
  $('nav-toggle').addEventListener('click',()=>{ if (state.permissions.pto) accessChanged().catch(report); });
  document.addEventListener('visibilitychange',()=>{
    if (!document.hidden && state.user && state.permissions.pto) accessChanged().catch(report);
    if (!document.hidden && state.user && state.currentPage === 'tasks') {
      load();
      if (current && panel.open && !$('task-form')) openTask(current.id);
    }
  });
  return { load,fromLink };
})();
