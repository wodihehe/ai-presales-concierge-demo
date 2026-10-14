// Knowledge Base Workbench Frontend Client Logic

let currentUser = null;
let currentProjectId = null;
let currentProject = null;
let currentDraftVersion = 1;
let currentPhases = [];
let currentStyles = [];
let reviewTarget = null;
let workspaceDirty = false;
let workspaceBusy = false;
let workspaceRequest = 0;
let backgroundTaskRunning = false;
let upstreamModels = [];
let modelListRequest = 0;
let modelListController = null;
let settingsLoadRequest = 0;
let projectsRequest = 0;
let projectFilters = { keyword: '', category: 'all', status: 'all' };

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('viewSettings').addEventListener('input', () => { settingsLoadRequest++; });
  for (const id of ['cfgModelBaseUrl', 'cfgModelApiKey']) {
    document.getElementById(id).addEventListener('input', () => resetUpstreamModels('地址或密钥已修改，请重新获取模型列表。'));
  }
  document.getElementById('cfgModelName').addEventListener('input', () => {
    const select = document.getElementById('upstreamModelSelect');
    select.value = document.getElementById('cfgModelName').value.trim();
  });
  document.getElementById('wsDraftForm').addEventListener('input', () => { workspaceDirty = true; });
  document.getElementById('wsDraftForm').addEventListener('change', () => { workspaceDirty = true; });
  document.getElementById('wsDraftForm').addEventListener('click', event => { if (event.target.closest('button')) workspaceDirty = true; });
  await checkAuthStatus();
});

async function api(url, options = {}) {
  const defaultHeaders = {
    'Accept': 'application/json',
    ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
  };

  const response = await fetch(url, {
    ...options,
    headers: { ...defaultHeaders, ...options.headers }
  });

  const contentType = response.headers.get('content-type');
  let data = null;
  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  }

  if (!response.ok) {
    const errorMsg = data?.message || data?.error || `请求失败 (HTTP ${response.status})`;
    const error = new Error(errorMsg);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// Check auth & bootstrap status
async function checkAuthStatus() {
  try {
    const status = await api('/api/auth/status');
    if (!status.initialized) {
      document.getElementById('modalSetup').style.display = 'flex';
      return;
    }

    // Try get me
    const me = await api('/api/auth/me');
    currentUser = me.user;
    updateUserUI();
    loadProjects();
    loadPendingBadge();
  } catch (err) {
    if (err.status === 401) {
      currentUser = null;
      updateUserUI();
      openLoginModal();
    }
  }
}

function updateUserUI() {
  settingsLoadRequest++;
  projectsRequest++;
  projectFilters = { keyword: '', category: 'all', status: 'all' };
  syncProjectFilterControls();
  document.getElementById('projectsList').replaceChildren();
  const userInfo = document.getElementById('userInfo');
  const authBtn = document.getElementById('authBtn');
  const adminNavs = document.querySelectorAll('.admin-only');

  if (currentUser) {
    userInfo.textContent = `${currentUser.name} (${currentUser.role === 'admin' ? '管理员' : '员工'})`;
    authBtn.textContent = '退出';
    if (currentUser.role === 'admin') {
      adminNavs.forEach(el => el.style.display = 'inline-block');
    } else {
      adminNavs.forEach(el => el.style.display = 'none');
    }
  } else {
    userInfo.textContent = '未登录';
    authBtn.textContent = '登录';
    adminNavs.forEach(el => el.style.display = 'none');
  }
}

function handleAuthClick() {
  if (currentUser) {
    projectsRequest++;
    settingsLoadRequest++;
    resetUpstreamModels();
    api('/api/auth/logout', { method: 'POST' }).then(() => {
      currentUser = null;
      updateUserUI();
      openLoginModal();
    });
  } else {
    openLoginModal();
  }
}

// Tab Switching
function switchTab(tabId) {
  if (workspaceBusy) return;
  if (workspaceDirty && !confirm('草稿有未保存修改，确认放弃并离开？')) return;
  workspaceDirty = false;
  projectsRequest++;
  settingsLoadRequest++;
  resetUpstreamModels();
  currentProjectId = null;
  workspaceRequest++;
  document.querySelectorAll('.view-panel').forEach(el => el.style.display = 'none');
  document.querySelectorAll('#mainNav .nav-btn').forEach(btn => btn.classList.remove('active'));

  if (tabId === 'projects') {
    document.getElementById('viewProjects').style.display = 'block';
    document.querySelector('#mainNav button:nth-child(1)').classList.add('active');
    loadProjects();
  } else if (tabId === 'reviews') {
    document.getElementById('viewReviews').style.display = 'block';
    document.querySelector('#mainNav button:nth-child(2)').classList.add('active');
    loadReviewQueue();
  } else if (tabId === 'search') {
    document.getElementById('viewSearch').style.display = 'block';
    document.querySelector('#mainNav button:nth-child(3)').classList.add('active');
  } else if (tabId === 'settings') {
    document.getElementById('viewSettings').style.display = 'block';
    document.querySelector('#mainNav button:nth-child(4)').classList.add('active');
    loadSettings();
  } else if (tabId === 'users') {
    document.getElementById('viewUsers').style.display = 'block';
    document.querySelector('#mainNav button:nth-child(5)').classList.add('active');
    loadUsers();
  }
}

// 1. Projects Archive List
function syncProjectFilterControls() {
  document.getElementById('projectSearchKeyword').value = projectFilters.keyword;
  document.getElementById('projectFilterCategory').value = projectFilters.category;
  document.getElementById('projectFilterStatus').value = projectFilters.status;
}

function applyProjectFilters() {
  projectFilters = {
    keyword: document.getElementById('projectSearchKeyword').value.trim(),
    category: document.getElementById('projectFilterCategory').value,
    status: document.getElementById('projectFilterStatus').value
  };
  return loadProjects();
}

function changeProjectFilter(field, value) {
  if (!['category', 'status'].includes(field)) return;
  projectFilters = { ...projectFilters, [field]: value };
  return loadProjects();
}

function resetProjectFilters() {
  projectFilters = { keyword: '', category: 'all', status: 'all' };
  return loadProjects();
}

async function loadProjects() {
  // Navigation/retry uses applied filters, never an unsubmitted/autofilled DOM value.
  const request = ++projectsRequest;
  const { keyword, category, status } = projectFilters;
  syncProjectFilterControls();
  const listEl = document.getElementById('projectsList');
  listEl.setAttribute('aria-busy', 'true');
  listEl.innerHTML = '<div class="project-list-message" role="status">正在加载项目列表…</div>';
  const params = new URLSearchParams();
  if (keyword) params.set('keyword', keyword);
  if (category !== 'all') params.set('category', category);
  if (status !== 'all') params.set('status', status);

  try {
    const data = await api(`/api/projects?${params.toString()}`);
    if (request !== projectsRequest) return;
    if (data.projects.length === 0) {
      const filtered = keyword || category !== 'all' || status !== 'all';
      listEl.innerHTML = `<div class="project-list-message" role="status">${filtered
        ? '没有符合当前筛选条件的项目。可调整条件或点击“清除筛选”查看全部项目。'
        : '暂无项目。点击右上角“新建项目归档”开始导入。'}</div>`;
      return;
    }

    listEl.innerHTML = data.projects.map(p => {
      const priceSummary = p.phases?.filter(ph => ph.allow_cs_quote).map(ph => {
        if (ph.amount_min && ph.amount_max) {
          return `${ph.phase_name}: ${ph.amount_min === ph.amount_max ? ph.amount_min : ph.amount_min + '~' + ph.amount_max} ${ph.currency}`;
        }
        return `${ph.phase_name}: 无有效报价`;
      }).join('； ') || '未设置对客参考报价';

      return `
        <div class="card project-card" style="margin-bottom:0.5rem; cursor:pointer;" onclick="openProjectWorkspace('${p.id}')">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; font-size:1rem;">${escapeHtml(p.title)}</span>
                <span class="badge badge-${p.status}">${statusName(p.status)}</span>
                <span class="badge" style="background:#f1f5f9; color:#475569;">${escapeHtml(p.category || '未分类')}</span>
              </div>
              <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.35rem;">
                ${escapeHtml(p.public_summary || p.overview || '暂无概述')}
              </div>
              <div style="font-size:0.8rem; color:#0369a1;">
                <strong>对客价格依据：</strong> ${escapeHtml(priceSummary)}
              </div>
            </div>
            <div style="font-size:0.8rem; color:var(--text-muted); text-align:right;">
              <div>附件：${p.fileCount} 份</div>
              <div style="margin-top:0.25rem;">更新：${p.updated_at?.slice(0, 16).replace('T', ' ')}</div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    if (request !== projectsRequest) return;
    listEl.innerHTML = `<div class="project-list-message" role="alert">加载项目列表失败：${escapeHtml(err.message)}<br><button type="button" class="btn btn-secondary" onclick="loadProjects()">重试</button></div>`;
  } finally {
    if (request === projectsRequest) listEl.setAttribute('aria-busy', 'false');
  }
}

// 2. Project Workspace Detail
async function openProjectWorkspace(projectId) {
  if (workspaceBusy) return;
  if (workspaceDirty && !confirm('草稿有未保存修改，确认放弃并切换项目？')) return;
  workspaceDirty = false;
  projectsRequest++;
  currentProjectId = projectId;
  document.querySelectorAll('.view-panel').forEach(el => el.style.display = 'none');
  document.getElementById('viewWorkspace').style.display = 'block';

  await refreshWorkspace();
}

async function refreshWorkspace() {
  if (!currentProjectId) return;
  const projectId = currentProjectId;
  const request = ++workspaceRequest;
  try {
    const data = await api(`/api/projects/${projectId}`);
    if (currentProjectId !== projectId || request !== workspaceRequest) return;
    currentProject = data.project;
    currentDraftVersion = currentProject.draft_version;
    currentPhases = data.phases || [];
    currentStyles = data.styles || [];
    workspaceDirty = false;

    // Header
    document.getElementById('wsProjectTitle').textContent = currentProject.title;
    const badge = document.getElementById('wsProjectStatusBadge');
    badge.className = `badge badge-${currentProject.status}`;
    badge.textContent = statusName(currentProject.status);
    document.getElementById('wsDraftVersionBadge').textContent = `v${currentDraftVersion}`;

    renderWorkspaceActionButtons(currentProject);

    // Files List
    document.getElementById('wsFileCount').textContent = data.files.length;
    renderFilesList(data.files);

    // Draft Form
    document.getElementById('draftTitle').value = currentProject.title || '';
    document.getElementById('draftCategory').value = currentProject.category || 'AI Agent定制';
    document.getElementById('draftScenario').value = currentProject.scenario || '';
    document.getElementById('draftProblem').value = currentProject.problem || '';
    document.getElementById('draftOverview').value = currentProject.overview || '';
    document.getElementById('draftInputs').value = currentProject.inputs || '';
    document.getElementById('draftOutputs').value = currentProject.outputs || '';
    document.getElementById('draftDeliverables').value = currentProject.deliverables || '';
    document.getElementById('draftIntegrations').value = currentProject.integrations || '';
    document.getElementById('draftDeployment').value = currentProject.deployment || '';
    document.getElementById('draftExclusions').value = currentProject.exclusions || '';
    document.getElementById('draftPublicTitle').value = currentProject.public_title || '';
    document.getElementById('draftPublicSummary').value = currentProject.public_summary || '';
    document.getElementById('draftFeatures').value = (data.features || []).join('\n');

    // Phases
    renderPhases(data.phases);

    // Chat
    renderChatMessages(data.chat);
    renderSourceDetails(data.files, data.styles);
    backgroundTaskRunning = (data.tasks || []).some(t => ['pending','running'].includes(t.status));
    applyWorkspaceControls();
    document.getElementById('wsTaskStatus').textContent = (data.tasks || []).slice(0,3).map(t => `${t.type === 'file_parse' ? '附件解析' : 'AI整理'}：${({pending:'等待中',running:'处理中',success:'完成',failed:'失败',interrupted:'已中断'})[t.status]}${t.error_message ? ' — '+t.error_message : ''}`).join('\n') || '尚无处理任务';
  } catch (err) {
    alert('加载项目详情失败: ' + err.message);
  }
}

function renderWorkspaceActionButtons(p) {
  const container = document.getElementById('wsActionButtons');
  const buttons = [];

  const isCreator = currentUser && p.creator_id === currentUser.id;
  const isAdmin = currentUser && currentUser.role === 'admin';

  if ((p.status === 'draft' || p.status === 'returned' || p.status === 'revoked') && (isCreator || isAdmin)) {
    buttons.push(`<button class="btn btn-primary btn-sm" onclick="submitProjectForReview()">提交审核</button>`);
  }

  if (p.status === 'pending_review') {
    // Both staff and admin can review per D01
    buttons.push(`<button class="btn btn-success btn-sm" onclick="openApproveModal()">审核通过入库</button>`);
    buttons.push(`<button class="btn btn-secondary btn-sm" onclick="openReturnModal()">退回修改</button>`);
  }

  if (p.status === 'approved') {
    // Creator, reviewer, or admin can revoke
    buttons.push(`<button class="btn btn-secondary btn-sm" onclick="openRevokeModal()">撤回发布</button>`);
  }

  if (isAdmin) {
    buttons.push(`<button class="btn btn-danger btn-sm" onclick="confirmPermanentDelete('${p.id}')">永久删除</button>`);
  }

  container.innerHTML = buttons.join('');
}

function renderFilesList(files) {
  const listEl = document.getElementById('wsFilesList');
  if (files.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:1.5rem; font-size:0.85rem;">暂无附件，点击上方按钮上传方案与报价材料。</div>';
    return;
  }

  listEl.innerHTML = files.map(f => {
    return `
      <div class="file-item">
        <div class="file-header">
          <span class="file-name">${escapeHtml(f.original_name)}</span>
          <span class="badge badge-${f.parse_status}">${parseStatusName(f.parse_status)}</span>
        </div>
        <div style="font-size:0.75rem; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center;">
          <span>${(f.size_bytes / 1024).toFixed(1)} KB</span>
          <div style="display:flex; gap:0.25rem;">
            <a href="/api/projects/${currentProjectId}/files/${f.id}/download" class="btn btn-secondary btn-sm" style="text-decoration:none; padding:0.15rem 0.4rem; font-size:0.75rem;">下载</a>
            ${currentProject.status !== 'approved' && (currentProject.creator_id === currentUser?.id || currentUser?.role === 'admin') ? `
              <button class="btn btn-secondary btn-sm" style="padding:0.15rem 0.4rem; font-size:0.75rem; color:var(--danger);" onclick="deleteFile('${f.id}')">删除</button>
              <button class="btn btn-secondary btn-sm" onclick="retryFileParse('${f.id}')">重新解析</button>
            ` : ''}
          </div>
        </div>
        ${f.parse_error_reason ? `<div class="file-reason">${escapeHtml(f.parse_error_reason)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderPhases(phases) {
  const container = document.getElementById('phasesContainer');
  container.innerHTML = (phases || []).map((ph, idx) => {
    return `
      <div class="phase-card" data-phase-id="${escapeHtml(ph.id || '')}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <input type="text" class="phase-name" value="${escapeHtml(ph.phase_name || '')}" placeholder="阶段名 (如: 一期 / 整体)" style="width:160px; font-weight:600;">
          <button type="button" class="btn btn-secondary btn-sm" style="color:var(--danger);" onclick="this.closest('.phase-card').remove()">删除</button>
        </div>
        <div class="grid-cols-2">
          <div class="form-group">
            <label>阶段范围描述</label>
            <input type="text" class="phase-scope" value="${escapeHtml(ph.scope_description || '')}" placeholder="该阶段的功能范围">
          </div>
          <div class="form-group">
            <label>阶段间关系</label>
            <select class="phase-relation">
              <option value="standalone" ${ph.relation === 'standalone' ? 'selected' : ''}>独立增量 (standalone)</option>
              <option value="cumulative" ${ph.relation === 'cumulative' ? 'selected' : ''}>累计总额 (cumulative)</option>
              <option value="alternative" ${ph.relation === 'alternative' ? 'selected' : ''}>互斥可选方案 (alternative)</option>
              <option value="unknown" ${ph.relation === 'unknown' ? 'selected' : ''}>未说明 (unknown)</option>
            </select>
          </div>
        </div>
        <div class="grid-cols-3">
          <div class="form-group">
            <label>最低参考金额</label>
            <input type="number" class="phase-min" value="${ph.amount_min ?? ''}" placeholder="元">
          </div>
          <div class="form-group">
            <label>最高参考金额</label>
            <input type="number" class="phase-max" value="${ph.amount_max ?? ''}" placeholder="元">
          </div>
          <div class="form-group">
            <label>币种</label>
            <input type="text" class="phase-curr" value="${escapeHtml(ph.currency || '')}" placeholder="未知请留空">
          </div>
        </div>
        <div class="grid-cols-2">
          <div class="form-group">
            <label>费用口径</label>
            <input type="text" class="phase-cost-scope" value="${escapeHtml(ph.cost_scope || '')}" placeholder="如：含税，不含服务器API费用">
          </div>
          <div class="form-group">
            <label>原件出处与定位</label>
            <input type="text" class="phase-source" value="${escapeHtml(ph.source_location || '')}" placeholder="如：报价清单第2页">
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.25rem;">
          <input type="checkbox" class="phase-allow-cs" id="cs_${idx}" ${ph.allow_cs_quote ? 'checked' : ''} style="width:auto;">
          <label for="cs_${idx}" style="margin:0; font-size:0.8rem; color:#15803d; font-weight:600;">获准作为当前对客参考价格依据 (allow_cs_quote)</label>
        </div>
      </div>
    `;
  }).join('');
}

function addPhaseCard() {
  const container = document.getElementById('phasesContainer');
  const count = container.children.length;
  const div = document.createElement('div');
  div.className = 'phase-card';
  div.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
      <input type="text" class="phase-name" value="第${count + 1}阶段" placeholder="阶段名" style="width:160px; font-weight:600;">
      <button type="button" class="btn btn-secondary btn-sm" style="color:var(--danger);" onclick="this.closest('.phase-card').remove()">删除</button>
    </div>
    <div class="grid-cols-2">
      <div class="form-group">
        <label>阶段范围描述</label>
        <input type="text" class="phase-scope" placeholder="该阶段的功能范围">
      </div>
      <div class="form-group">
        <label>阶段间关系</label>
        <select class="phase-relation">
          <option value="standalone">独立增量 (standalone)</option>
          <option value="cumulative">累计总额 (cumulative)</option>
          <option value="alternative">互斥可选方案 (alternative)</option>
          <option value="unknown" selected>未说明 (unknown)</option>
        </select>
      </div>
    </div>
    <div class="grid-cols-3">
      <div class="form-group">
        <label>最低参考金额</label>
        <input type="number" class="phase-min" placeholder="元">
      </div>
      <div class="form-group">
        <label>最高参考金额</label>
        <input type="number" class="phase-max" placeholder="元">
      </div>
      <div class="form-group">
        <label>币种</label>
        <input type="text" class="phase-curr" value="" placeholder="未知请留空">
      </div>
    </div>
    <div class="grid-cols-2">
      <div class="form-group">
        <label>费用口径</label>
        <input type="text" class="phase-cost-scope" placeholder="如：含税，不含服务器API费用">
      </div>
      <div class="form-group">
        <label>原件出处与定位</label>
        <input type="text" class="phase-source" placeholder="如：报价清单第2页">
      </div>
    </div>
    <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.25rem;">
      <input type="checkbox" class="phase-allow-cs" style="width:auto;">
      <label style="margin:0; font-size:0.8rem; color:#15803d; font-weight:600;">获准作为当前对客参考价格依据 (allow_cs_quote)</label>
    </div>
  `;
  container.appendChild(div);
}

function renderChatMessages(chatList) {
  const container = document.getElementById('wsChatMessages');
  if (!chatList || chatList.length === 0) {
    container.innerHTML = `
      <div class="chat-bubble assistant">
        已准备就绪。上传附件后点击上方“触发AI深度提取”，或在此直接向我发送补充指令。
      </div>
    `;
    return;
  }

  container.innerHTML = chatList.map(c => {
    return `<div class="chat-bubble ${c.role}">${escapeHtml(c.content).replace(/\n/g, '<br>')}</div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

// Save draft
async function saveCurrentDraft() {
  if (!currentProjectId) return;

  const phaseCards = document.querySelectorAll('#phasesContainer .phase-card');
  const phases = Array.from(phaseCards).map(card => {
    return {
      id: card.dataset.phaseId || null,
      phase_name: card.querySelector('.phase-name').value.trim(),
      scope_description: card.querySelector('.phase-scope').value.trim(),
      relation: card.querySelector('.phase-relation').value,
      amount_min: card.querySelector('.phase-min').value ? parseFloat(card.querySelector('.phase-min').value) : null,
      amount_max: card.querySelector('.phase-max').value ? parseFloat(card.querySelector('.phase-max').value) : null,
      currency: card.querySelector('.phase-curr').value.trim(),
      cost_scope: card.querySelector('.phase-cost-scope').value.trim(),
      source_location: card.querySelector('.phase-source').value.trim(),
      allow_cs_quote: card.querySelector('.phase-allow-cs').checked
    };
  });

  const features = document.getElementById('draftFeatures').value
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  const draftData = {
    clientDraftVersion: currentDraftVersion,
    title: document.getElementById('draftTitle').value.trim(),
    category: document.getElementById('draftCategory').value,
    scenario: document.getElementById('draftScenario').value.trim(),
    problem: document.getElementById('draftProblem').value.trim(),
    overview: document.getElementById('draftOverview').value.trim(),
    inputs: document.getElementById('draftInputs').value.trim(),
    outputs: document.getElementById('draftOutputs').value.trim(),
    deliverables: document.getElementById('draftDeliverables').value.trim(),
    integrations: document.getElementById('draftIntegrations').value.trim(),
    deployment: document.getElementById('draftDeployment').value.trim(),
    exclusions: document.getElementById('draftExclusions').value.trim(),
    public_title: document.getElementById('draftPublicTitle').value.trim(),
    public_summary: document.getElementById('draftPublicSummary').value.trim(),
    features,
    phases,
    style_references: currentStyles.map((s,i) => ({...s, desensitized_example: document.getElementById(`styleExample${i}`).value.trim()}))
  };

  try {
    const res = await api(`/api/projects/${currentProjectId}/draft`, {
      method: 'PUT',
      body: JSON.stringify(draftData)
    });
    workspaceDirty = false;
    alert('草稿保存成功！');
    await refreshWorkspace();
  } catch (err) {
    alert('保存草稿失败: ' + err.message);
  }
}

// Upload file
async function handleFileUpload(event) {
  if (workspaceDirty) { event.target.value = ''; return alert('请先保存草稿，再上传材料。'); }
  const files = event.target.files;
  if (!files || files.length === 0 || !currentProjectId) return;

  const formData = new FormData();
  for (const f of files) {
    formData.append('files', f);
  }

  try {
    const res = await api(`/api/projects/${currentProjectId}/files`, {
      method: 'POST',
      body: formData
    });
    alert(res.message);
    event.target.value = '';
    await refreshWorkspace();
  } catch (err) {
    alert('上传失败: ' + err.message);
  }
}

// Delete file
async function deleteFile(fileId) {
  if (workspaceDirty) return alert('请先保存草稿，再删除附件。');
  if (!confirm('确定删除该附件？')) return;
  try {
    const result = await api(`/api/projects/${currentProjectId}/files/${fileId}`, { method: 'DELETE' });
    if(result.cleanupPending) alert(result.message);
    await refreshWorkspace();
  } catch (err) {
    alert('删除附件失败: ' + err.message);
  }
}

// Trigger AI extraction
async function triggerAiExtract(btn) {
  if (!currentProjectId) return;
  if (workspaceDirty) return alert('请先保存草稿，再进行AI整理。');
  btn.disabled = true;
  btn.textContent = 'AI 提取处理中...';

  try {
    const res = await api(`/api/projects/${currentProjectId}/organize/extract`, { method: 'POST' });
    alert(res.message);
    await refreshWorkspace();
  } catch (err) {
    alert('提取失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '触发AI深度提取';
  }
}

// Send chat
async function sendChatMessage() {
  if (workspaceDirty) return alert('请先保存草稿，再发送整理意见。');
  const input = document.getElementById('chatInputText');
  const text = input.value.trim();
  if (!text || !currentProjectId) return;

  input.value = '';
  const container = document.getElementById('wsChatMessages');
  container.innerHTML += `<div class="chat-bubble user">${escapeHtml(text)}</div>`;
  container.scrollTop = container.scrollHeight;

  try {
    const res = await api(`/api/projects/${currentProjectId}/organize/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: text, clientDraftVersion: currentDraftVersion })
    });
    await refreshWorkspace();
  } catch (err) {
    input.value = text;
    alert('发送失败: ' + err.message);
  }
}

// Review Workflow
async function submitProjectForReview() {
  if (workspaceDirty) return alert('请先保存草稿，再提交审核。');
  if (!confirm('确认将当前草稿提交至待审核队列？')) return;
  try {
    await api(`/api/projects/${currentProjectId}/review/submit`, { method: 'POST' });
    alert('已提交待审核队列！');
    await refreshWorkspace();
    loadPendingBadge();
  } catch (err) {
    alert('提交审核失败: ' + err.message);
  }
}

function openApproveModal() {
  if (workspaceDirty) return alert('页面有未保存修改，请先保存并重新提交审核。');
  reviewTarget = { id: currentProjectId, version: currentDraftVersion };
  document.getElementById('reviewModalTitle').textContent = '审核通过并入库';
  document.getElementById('reviewReasonLabel').textContent = '审核备注 (可选)';
  document.getElementById('reviewReasonText').value = '';
  document.getElementById('reviewConfirmBtn').onclick = submitApprove;
  document.getElementById('reviewConfirmBtn').textContent = '确认审核并入库';
  document.getElementById('reviewEffect').textContent = '通过后，已批准的对客内容、风格示范和参考价格将可被客服检索使用。请先核对来源与披露范围。';
  document.getElementById('modalReviewAction').style.display = 'flex';
}

async function submitApprove() {
  const notes = document.getElementById('reviewReasonText').value.trim();
  try {
    await api(`/api/projects/${reviewTarget.id}/review/approve`, {
      method: 'POST',
      body: JSON.stringify({ clientDraftVersion: reviewTarget.version, notes })
    });
    alert('审核通过！已正式发布入库，供客服检索参考。');
    closeReviewModal();
    await refreshWorkspace();
    loadPendingBadge();
  } catch (err) {
    if (err.status === 409) {
      alert('【草稿已变更】：审核期间草稿已被其他操作修改，请刷新核对最新草稿内容后再做审批！');
      closeReviewModal();
      await refreshWorkspace();
    } else {
      alert('审批失败: ' + err.message);
    }
  }
}

function openReturnModal() {
  document.getElementById('reviewModalTitle').textContent = '退回修改';
  document.getElementById('reviewReasonLabel').textContent = '退回修改原因 (必填)';
  document.getElementById('reviewReasonText').value = '';
  document.getElementById('reviewConfirmBtn').onclick = submitReturn;
  document.getElementById('reviewConfirmBtn').textContent = '确认退回';
  document.getElementById('reviewEffect').textContent = '退回后，提交人可继续修正，再重新提交审核。';
  document.getElementById('modalReviewAction').style.display = 'flex';
}

async function submitReturn() {
  const reason = document.getElementById('reviewReasonText').value.trim();
  if (!reason) {
    alert('请填写退回修改的具体原因');
    return;
  }

  try {
    await api(`/api/projects/${currentProjectId}/review/return`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
    alert('已退回修改！');
    closeReviewModal();
    await refreshWorkspace();
    loadPendingBadge();
  } catch (err) {
    alert('退回失败: ' + err.message);
  }
}

function openRevokeModal() {
  document.getElementById('reviewModalTitle').textContent = '撤回已发布案例';
  document.getElementById('reviewReasonLabel').textContent = '撤回原因 (必填)';
  document.getElementById('reviewReasonText').value = '';
  document.getElementById('reviewConfirmBtn').onclick = submitRevoke;
  document.getElementById('reviewConfirmBtn').textContent = '确认撤回';
  document.getElementById('reviewEffect').textContent = '撤回后，该案例立即退出客服检索；资料保留，可修正后重新审核。';
  document.getElementById('modalReviewAction').style.display = 'flex';
}

async function submitRevoke() {
  const reason = document.getElementById('reviewReasonText').value.trim();
  try {
    await api(`/api/projects/${currentProjectId}/review/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
    alert('已撤回！该案例已实时从正式检索中下架。');
    closeReviewModal();
    await refreshWorkspace();
  } catch (err) {
    alert('撤回失败: ' + err.message);
  }
}

async function confirmPermanentDelete(projectId) {
  if (!confirm('【高危操作】：确定永久删除该案例及其全部物理附件？删除后不可恢复！')) return;
  try {
    const result = await api(`/api/projects/${projectId}`, { method: 'DELETE' });
    alert(result.message || '案例及原件已永久清理；已有备份不受影响。');
    workspaceBusy = false;
    workspaceDirty = false;
    switchTab('projects');
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

function closeReviewModal() {
  document.getElementById('modalReviewAction').style.display = 'none';
}

// 3. Review Queue View
async function loadReviewQueue() {
  try {
    const data = await api('/api/reviews/queue');
    const container = document.getElementById('reviewQueueList');
    if (data.queue.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:2rem;">当前待审核队列为空。</div>';
      return;
    }

    container.innerHTML = data.queue.map(p => {
      return `
        <div class="card" style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600; font-size:1rem; margin-bottom:0.25rem;">
              ${escapeHtml(p.title)} <span class="badge" style="background:#f1f5f9;">${escapeHtml(p.category)}</span>
            </div>
            <div style="font-size:0.85rem; color:var(--text-muted);">
              提交人: ${escapeHtml(p.creator_name || p.creator_id)} · 附件: ${p.fileCount} 份 · 提交时间: ${p.updated_at?.slice(0, 16).replace('T', ' ')}
            </div>
          </div>
          <button class="btn btn-primary" onclick="openProjectWorkspace('${p.id}')">进入审核台</button>
        </div>
      `;
    }).join('');
  } catch (err) {
    alert('加载待审队列失败: ' + err.message);
  }
}

async function loadPendingBadge() {
  try {
    const data = await api('/api/reviews/queue');
    const badge = document.getElementById('pendingBadge');
    if (data.queue.length > 0) {
      badge.textContent = data.queue.length;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  } catch {}
}

// 4. Search & Retrieval Debug Tool
async function executeSearchDebug() {
  const query = document.getElementById('searchQueryInput').value.trim();
  const scenario = document.getElementById('searchScenarioInput').value.trim();
  const features = document.getElementById('searchFeaturesInput').value.split(',').map(s => s.trim()).filter(Boolean);

  try {
    const data = await api('/api/search/debug', {
      method: 'POST',
      body: JSON.stringify({
        query,
        profile: { scenario, features }
      })
    });

    document.getElementById('searchDebugResult').style.display = 'block';

    // Simulate parent CS calculate
    const cases = data.cases || [];
    const matched = cases.filter(c => c.match === true);
    const usable = matched.filter(c => c.approved === true && c.public === true);
    const priced = usable.filter(c => c.price && c.price.currency === 'CNY' && typeof c.price.min === 'number' && typeof c.price.max === 'number');

    let status = 'no_match';
    let quoteStr = '无';
    let sourcesStr = '无';

    if (matched.length === 0) {
      status = 'no_match';
    } else if (priced.length === 0) {
      status = 'no_price';
      sourcesStr = [...new Set(usable.map(c => c.id))].join(', ');
    } else {
      status = 'quoted';
      const min = Math.min(...priced.map(c => c.price.min));
      const max = Math.max(...priced.map(c => c.price.max));
      quoteStr = `${min} ~ ${max} CNY`;
      sourcesStr = [...new Set(priced.map(c => c.id))].join(', ');
    }

    const badge = document.getElementById('csCalculatedStatus');
    badge.textContent = status;
    badge.className = `badge ${status === 'quoted' ? 'badge-approved' : (status === 'no_price' ? 'badge-partial' : 'badge-draft')}`;

    document.getElementById('csCalculatedQuote').textContent = quoteStr;
    document.getElementById('csCalculatedSources').textContent = sourcesStr;
    document.getElementById('csRawCasesJson').textContent = JSON.stringify(cases, null, 2);

    // Context View
    const ctx = data.context || {};
    let ctxHtml = '';
    if (ctx.styleReferences?.length) {
      ctxHtml += '<strong>【方案风格参考依据】：</strong><ul style="padding-left:1.25rem; margin:0.5rem 0;">';
      for (const sr of ctx.styleReferences) {
        ctxHtml += `<li style="margin-bottom:0.35rem;">[${escapeHtml(sr.topic)}] <em>"${escapeHtml(sr.example)}"</em> <span style="color:var(--text-muted); font-size:0.75rem;">(出处: ${escapeHtml(sr.sourceLocation || '原件')})</span></li>`;
      }
      ctxHtml += '</ul>';
    } else {
      ctxHtml += '<div style="color:var(--text-muted); margin-bottom:0.75rem;">无可供引用的风格示范。</div>';
    }

    if (ctx.priceEvidence?.length) {
      ctxHtml += '<strong>【可比价格证据列表】：</strong><ul style="padding-left:1.25rem; margin:0.5rem 0;">';
      for (const pe of ctx.priceEvidence) {
        ctxHtml += `<li>${escapeHtml(pe.phaseName)}: ${pe.amountMin}~${pe.amountMax} ${pe.currency} (${escapeHtml(pe.relation)}) - ${escapeHtml(pe.costScope || '无额外说明')}</li>`;
      }
      ctxHtml += '</ul>';
    }

    document.getElementById('csContextContent').innerHTML = ctxHtml;
  } catch (err) {
    alert('检索调试失败: ' + err.message);
  }
}

// 5. Settings
function modelListFeedback(message, failed = false) {
  const feedback = document.getElementById('modelListFeedback');
  feedback.textContent = message;
  feedback.style.color = failed ? 'var(--danger)' : 'var(--text-muted)';
}

function resetUpstreamModels(message = '') {
  modelListRequest++;
  modelListController?.abort();
  modelListController = null;
  upstreamModels = [];
  document.getElementById('modelPicker').hidden = true;
  document.getElementById('modelFilter').value = '';
  document.getElementById('upstreamModelSelect').replaceChildren();
  const button = document.getElementById('fetchModelsBtn');
  button.disabled = false;
  button.textContent = '获取上游模型';
  button.setAttribute('aria-busy', 'false');
  modelListFeedback(message);
}

async function fetchUpstreamModels() {
  if (modelListController) return;
  settingsLoadRequest++;
  resetUpstreamModels();
  const model_base_url = document.getElementById('cfgModelBaseUrl').value.trim();
  const model_api_key = document.getElementById('cfgModelApiKey').value.trim();
  if (!model_base_url) { modelListFeedback('请先填写API基础地址。', true); return; }
  const request = modelListRequest;
  const controller = new AbortController();
  modelListController = controller;
  const timer = setTimeout(() => controller.abort(), 20000);
  const button = document.getElementById('fetchModelsBtn');
  button.disabled = true;
  button.textContent = '正在获取…';
  button.setAttribute('aria-busy', 'true');
  modelListFeedback('正在获取上游模型列表…');
  try {
    const result = await api('/api/settings/models', {
      method: 'POST', body: JSON.stringify({ model_base_url, model_api_key }), signal: controller.signal
    });
    if (request !== modelListRequest) return;
    upstreamModels = result.models;
    if (!upstreamModels.length) {
      modelListFeedback('上游返回空列表，可检查密钥权限或手动填写模型名称。');
      return;
    }
    document.getElementById('modelPicker').hidden = false;
    renderUpstreamModels();
    modelListFeedback(`已获取 ${upstreamModels.length} 个模型，请从列表选择。${result.skippedCount ? `已忽略 ${result.skippedCount} 条无效记录。` : ''}`);
  } catch (err) {
    if (request !== modelListRequest) return;
    modelListFeedback(controller.signal.aborted ? '获取模型列表超时，请重试或手动填写。' : err.message, true);
  } finally {
    clearTimeout(timer);
    if (request === modelListRequest) {
      modelListController = null;
      button.disabled = false;
      button.textContent = '获取上游模型';
      button.setAttribute('aria-busy', 'false');
    }
  }
}

function renderUpstreamModels() {
  const keyword = document.getElementById('modelFilter').value.trim().toLowerCase();
  const models = upstreamModels.filter(id => id.toLowerCase().includes(keyword));
  const select = document.getElementById('upstreamModelSelect');
  select.replaceChildren(new Option(models.length ? '请选择模型（不会自动保存）' : '没有匹配的模型，可更换关键词', ''));
  for (const id of models) select.add(new Option(id, id));
  const selected = document.getElementById('cfgModelName').value.trim();
  select.value = models.includes(selected) ? selected : '';
  select.disabled = !models.length;
  document.getElementById('modelFilterCount').textContent = `显示 ${models.length} / ${upstreamModels.length} 个模型`;
}

function selectUpstreamModel() {
  const id = document.getElementById('upstreamModelSelect').value;
  if (!id || !upstreamModels.includes(id)) return;
  settingsLoadRequest++;
  document.getElementById('cfgModelName').value = id;
  modelListFeedback('模型名称已填入，点击“保存配置”后生效。');
}

async function loadSettings() {
  resetUpstreamModels();
  const request = ++settingsLoadRequest;
  try {
    const data = await api('/api/settings');
    if (request !== settingsLoadRequest) return;
    resetUpstreamModels();
    const s = data.settings;
    document.getElementById('cfgModelBaseUrl').value = s.model_base_url || '';
    document.getElementById('cfgModelName').value = s.model_name || '';
    document.getElementById('cfgModelApiKey').value = '';
    document.getElementById('cfgApiKeyStatus').textContent = s.model_api_key_configured ? `当前已配置: ${s.model_api_key_masked}` : '未配置密钥';
    document.getElementById('cfgModelVision').checked = s.model_supports_vision;
    document.getElementById('cfgMaxFileSize').value = s.max_file_size_mb;
    document.getElementById('cfgIntegrationKeyMasked').value = s.integration_api_key_masked || '未生成';
  } catch (err) {
    if (request !== settingsLoadRequest) return;
    alert('加载配置失败: ' + err.message);
  }
}

async function saveSettings() {
  const request = ++settingsLoadRequest;
  resetUpstreamModels();
  const model_base_url = document.getElementById('cfgModelBaseUrl').value.trim();
  const model_name = document.getElementById('cfgModelName').value.trim();
  const model_api_key = document.getElementById('cfgModelApiKey').value.trim();
  const model_supports_vision = document.getElementById('cfgModelVision').checked;

  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        model_base_url,
        model_name,
        model_api_key,
        model_supports_vision,
        max_file_size_mb: Number(document.getElementById('cfgMaxFileSize').value)
      })
    });
    alert('配置已成功保存！');
    if (request === settingsLoadRequest) await loadSettings();
  } catch (err) {
    alert('保存配置失败: ' + err.message);
  }
}

async function testModelConnectivity() {
  const feedback = document.getElementById('modelTestFeedback');
  feedback.textContent = '正在发起测试连接...';
  feedback.style.color = 'var(--text-muted)';

  const model_base_url = document.getElementById('cfgModelBaseUrl').value.trim();
  const model_name = document.getElementById('cfgModelName').value.trim();
  const model_api_key = document.getElementById('cfgModelApiKey').value.trim();

  try {
    const res = await api('/api/settings/test-model', {
      method: 'POST',
      body: JSON.stringify({ model_base_url, model_name, model_api_key })
    });
    if (res.success) {
      feedback.textContent = `✓ 连通成功！响应耗时: ${res.latencyMs}ms`;
      feedback.style.color = 'var(--success)';
    } else {
      feedback.textContent = `✕ 连通失败: ${res.error}`;
      feedback.style.color = 'var(--danger)';
    }
  } catch (err) {
    feedback.textContent = `✕ 请求异常: ${err.message}`;
    feedback.style.color = 'var(--danger)';
  }
}

async function generateNewIntegrationKey() {
  if (!confirm('重新生成后，旧密钥将立即失效，需要在客服后台同步更新。确认重新生成？')) return;
  try {
    const res = await api('/api/settings/generate-integration-key', { method: 'POST' });
    prompt('新密钥已生成，请复制并妥善保管（仅展示一次）：', res.apiKey);
    loadSettings();
  } catch (err) {
    alert('生成密钥失败: ' + err.message);
  }
}

// 6. Users Management
async function loadUsers() {
  try {
    const data = await api('/api/users');
    const container = document.getElementById('usersList');
    container.innerHTML = data.users.map(u => {
      return `
        <div class="card user-card" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <div>
            <div style="font-weight:600; font-size:0.95rem;">
              ${escapeHtml(u.name)} (${escapeHtml(u.username)})
              <span class="badge" style="background:#f1f5f9;">${u.role === 'admin' ? '管理员' : '普通员工'}</span>
              ${u.disabled ? '<span class="badge badge-failed">已停用</span>' : '<span class="badge badge-approved">正常</span>'}
            </div>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.25rem;">
              创建时间: ${u.created_at?.slice(0, 16).replace('T', ' ')}
            </div>
          </div>
          <div class="user-actions" style="display:flex; gap:0.5rem;">
            <button class="btn btn-secondary btn-sm" onclick="toggleUserStatus('${u.id}', ${u.disabled ? 0 : 1})">${u.disabled ? '启用' : '停用'}</button>
            <button class="btn btn-secondary btn-sm" onclick="promptResetPassword('${u.id}')">重置密码</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    alert('加载员工列表失败: ' + err.message);
  }
}

async function toggleUserStatus(userId, disabled) {
  try {
    await api(`/api/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ disabled })
    });
    loadUsers();
  } catch (err) {
    alert('更新状态失败: ' + err.message);
  }
}

async function promptResetPassword(userId) {
  const newPassword = prompt('请输入新密码 (至少 6 位):');
  if (!newPassword) return;
  try {
    await api(`/api/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ newPassword })
    });
    alert('密码重置成功！');
  } catch (err) {
    alert('重置密码失败: ' + err.message);
  }
}

// Modal Handlers
function openLoginModal() { document.getElementById('modalLogin').style.display = 'flex'; }
function closeLoginModal() { document.getElementById('modalLogin').style.display = 'none'; }
function openCreateProjectModal() { document.getElementById('modalCreateProject').style.display = 'flex'; }
function closeCreateProjectModal() { document.getElementById('modalCreateProject').style.display = 'none'; }
function openCreateUserModal() { document.getElementById('modalCreateUser').style.display = 'flex'; }
function closeCreateUserModal() { document.getElementById('modalCreateUser').style.display = 'none'; }

async function submitInitAdmin() {
  const setupToken = document.getElementById('setupTokenInput').value.trim();
  const username = document.getElementById('setupUsername').value.trim();
  const name = document.getElementById('setupName').value.trim();
  const password = document.getElementById('setupPassword').value.trim();

  try {
    const res = await api('/api/auth/init-admin', {
      method: 'POST',
      body: JSON.stringify({ setupToken, username, name, password })
    });
    alert('管理员初始化完成并已登录！');
    document.getElementById('modalSetup').style.display = 'none';
    currentUser = res.user;
    updateUserUI();
    loadProjects();
  } catch (err) {
    alert('初始化失败: ' + err.message);
  }
}

async function submitLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    currentUser = res.user;
    updateUserUI();
    closeLoginModal();
    loadProjects();
    loadPendingBadge();
  } catch (err) {
    alert('登录失败: ' + err.message);
  }
}

async function submitCreateProject() {
  const title = document.getElementById('newProjTitle').value.trim();
  const category = document.getElementById('newProjCategory').value;
  if (!title) {
    alert('项目名称不能为空');
    return;
  }

  try {
    const res = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title, category })
    });
    closeCreateProjectModal();
    openProjectWorkspace(res.project.id);
  } catch (err) {
    alert('创建项目失败: ' + err.message);
  }
}

async function submitCreateUser() {
  const username = document.getElementById('newUserUsername').value.trim();
  const name = document.getElementById('newUserName').value.trim();
  const password = document.getElementById('newUserPassword').value.trim();
  const role = document.getElementById('newUserRole').value;

  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, name, password, role })
    });
    alert('账号创建成功！');
    closeCreateUserModal();
    loadUsers();
  } catch (err) {
    alert('创建员工账号失败: ' + err.message);
  }
}

// Helpers
function statusName(status) {
  const map = {
    draft: '草稿中',
    pending_review: '待审核',
    approved: '已发布',
    returned: '已退回',
    revoked: '已撤回'
  };
  return map[status] || status;
}

function parseStatusName(s) {
  const map = {
    parsed: '解析成功',
    partial: '部分截断',
    unsupported: '格式不支持',
    failed: '解析失败',
    image_stored_no_vision: '图片未配置视觉',
    pending: '待处理'
  };
  return map[s] || s;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderSourceDetails(files, styles) {
  const container = document.getElementById('wsSourceDetails');
  container.innerHTML = '<h3 class="section-label">提取文本与报价依据</h3>' + files.map(f => `<details><summary>${escapeHtml(f.original_name)} · 提取文本</summary><pre class="source-text">${escapeHtml(f.extracted_text || f.parse_error_reason || '暂无文本')}</pre></details>`).join('') + currentPhases.map(p => {
    const file = files.find(f => f.id === p.source_file_id);
    return `<details><summary>${escapeHtml(p.phase_name)} · ${p.source_type === 'staff_supplement' ? '人工补充' : escapeHtml(file?.original_name || '来源待核实')}</summary><p>${escapeHtml(p.source_location)}</p><pre class="source-text">${escapeHtml(p.raw_amount_text || '未记录金额原文，请对照材料核实')}</pre></details>`;
  }).join('');
  document.getElementById('wsStylesEditor').innerHTML = '<h3 class="section-label">对客风格示范（审核时一并确认）</h3>' + (styles.length ? styles.map((s,i) => `<div class="form-group"><label for="styleExample${i}">${escapeHtml(s.topic)}</label><textarea id="styleExample${i}" rows="3">${escapeHtml(s.desensitized_example)}</textarea><p class="help-text">来源：${escapeHtml(files.find(f=>f.id===s.source_file_id)?.original_name || '人工补充/待核实')} · ${escapeHtml(s.source_location)}</p></div>`).join('') : '<p class="help-text">暂无有来源的风格示范。不会据此编造公司风格。</p>');
}

async function retryFileParse(fileId) {
  if (workspaceDirty) return alert('请先保存草稿，再重新解析附件。');
  try {
    const result=await api(`/api/projects/${currentProjectId}/files/${fileId}/reparse`,{method:'POST'});
    alert(result.message);await refreshWorkspace();
  } catch(err){alert('重新解析失败：'+err.message);}
}

function applyWorkspaceControls() {
  const editable = currentProject && currentUser && currentProject.status !== 'approved' && (currentUser.role === 'admin' || currentProject.creator_id === currentUser.id);
  document.querySelectorAll('#viewWorkspace button').forEach(el => { el.disabled = workspaceBusy; });
  document.querySelectorAll('#viewWorkspace input, #viewWorkspace textarea, #viewWorkspace select, #viewWorkspace .col-header button, #wsDraftForm button, #wsFilesList button, #viewWorkspace .chat-input-bar button').forEach(el => { el.disabled = workspaceBusy || backgroundTaskRunning || !editable; });
  document.querySelectorAll('#mainNav button, #authBtn, #reviewConfirmBtn').forEach(el => { el.disabled = workspaceBusy; });
}

// Serialize UI mutations and keep form input stable until the result is reloaded.
for (const name of ['saveCurrentDraft','handleFileUpload','deleteFile','triggerAiExtract','sendChatMessage','submitProjectForReview','submitApprove','submitReturn','submitRevoke','confirmPermanentDelete','retryFileParse']) {
  const operation = window[name];
  window[name] = async function(...args) {
    if (workspaceBusy) return;
    workspaceBusy = true;
    applyWorkspaceControls();
    const status = document.getElementById('wsTaskStatus');
    const previous = status.textContent;
    status.textContent = '正在处理，请稍候… 已保存的材料会保留。';
    try { return await operation(...args); }
    finally { workspaceBusy = false; applyWorkspaceControls(); if(status.textContent.startsWith('正在处理'))status.textContent=previous; }
  };
}

window.addEventListener('beforeunload', event => { if(workspaceDirty || workspaceBusy) { event.preventDefault(); event.returnValue = ''; } });
