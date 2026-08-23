const ui = {
  state: null,
  currentView: 'overview',
  refreshing: false,
  toastTimer: null,
  retentionSnapshotId: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function apiKey() {
  return localStorage.getItem('yaa_api_key') || '';
}

function requestApiKey() {
  const key = prompt(t('settings.api_key_prompt'), apiKey());
  if (key !== null) localStorage.setItem('yaa_api_key', key.trim());
  return key;
}

async function api(url, options = {}, retry = true) {
  const key = apiKey();
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'x-api-key': key } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && retry && requestApiKey() !== null) return api(url, options, false);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText || 'Request failed');
    error.data = data;
    throw error;
  }
  return data;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4200);
}

function empty(message) {
  return `<div class="empty">${escapeHTML(message)}</div>`;
}

function formatDate(value, includeTime = true) {
  if (!value) return t('common.not_scheduled');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('common.not_scheduled');
  return new Intl.DateTimeFormat(getLanguage() === 'vi' ? 'vi-VN' : 'en-US', {
    month: 'short', day: 'numeric',
    ...(ui.state?.profile?.timezone ? { timeZone: ui.state.profile.timezone } : {}),
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {})
  }).format(date);
}

function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return t('common.just_now');
  if (seconds < 3600) return t('common.minutes_ago', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('common.hours_ago', { n: Math.floor(seconds / 3600) });
  return t('common.days_ago', { n: Math.floor(seconds / 86400) });
}

function label(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
}

function statusChip(value) {
  const safe = String(value || 'unknown').toLowerCase();
  return `<span class="status ${escapeHTML(safe)}">${escapeHTML(label(safe))}</span>`;
}

async function refreshDashboard(silent = false) {
  if (ui.refreshing) return;
  ui.refreshing = true;
  if (!silent) $('#loading').classList.add('active');
  try {
    ui.state = await api('/api/dashboard');
    renderDashboard();
  } catch (error) {
    $('#system-label').textContent = t('system.dashboard_unavailable');
    $('#system-dot').classList.remove('online');
    if (!silent) showToast(error.message, 'error');
  } finally {
    ui.refreshing = false;
    $('#loading').classList.remove('active');
  }
}

function renderDashboard() {
  const state = ui.state;
  const reviews = state.pipeline.filter(item => ['needs_review', 'needs_attention'].includes(item.review_status));
  const scheduled = state.schedule.filter(item => item.status === 'scheduled');
  const actionableJobs = state.jobs.filter(job => ['queued', 'running', 'failed', 'interrupted'].includes(job.status));

  $('#brand-name').textContent = state.profile?.channel_name || t('nav.brand_name');
  $('#setup-banner').classList.toggle('hidden', !state.system.setupRequired);
  $('#system-label').textContent = state.system.setupRequired
    ? t('system.setup_required')
    : state.system.automationPaused ? t('system.automation_paused') : t('system.agents_online', { n: state.system.agents.length });
  $('#system-dot').classList.toggle('online', state.system.initialized && !state.system.automationPaused && !state.system.setupRequired);
  $('#automation-toggle').textContent = state.system.automationPaused ? t('common.resume_automation') : t('common.pause_automation');
  $('#automation-toggle').disabled = state.system.setupRequired;
  $('#generate-button').disabled = state.system.setupRequired;
  $('#review-badge').textContent = reviews.length;
  $('#review-badge').classList.toggle('hidden', reviews.length === 0);

  $('#stat-review').textContent = reviews.length;
  $('#stat-scheduled').textContent = scheduled.length;
  $('#stat-published').textContent = state.stats.published || 0;
  $('#stat-score').textContent = state.analytics.averagePerformanceScore ? `${state.analytics.averagePerformanceScore}/100` : '—';
  const quota = state.quota || { used: 0, limit: 0 };
  $('#stat-quota').textContent = quota.limit ? `${quota.used}/${quota.limit}` : '—';

  renderReviews(reviews);
  renderJobs(actionableJobs.length ? actionableJobs : state.jobs.slice(0, 5));
  renderSchedule(state.schedule.slice(0, 5), '#next-schedule');
  renderNotifications(state.notifications, state.events);
  renderPipeline(state.pipeline);
  renderCalendar(state.schedule);
  renderIdeas(state.ideas);
  renderAnalytics(state.analytics, state.learning);
  renderActivation(state.activation);
  renderReadiness(state.readiness);
  renderOperator(state.channelStrategy, state.operatorRuns || [], { ...state.system, readiness: state.readiness });
  populateSettings(state.profile, state.settings, state.system.videoProviders || []);
}

function renderReadiness(readiness = {}) {
  const status = readiness.status || 'unverified';
  const statusNode = $('#readiness-status');
  statusNode.className = `status ${escapeHTML(status)}`;
  statusNode.textContent = readiness.stale && status !== 'unverified' ? `${label(status)} · stale` : label(status);

  const titles = {
    passed: t('readiness.title_passed'),
    warning: t('readiness.title_warning'),
    failed: t('readiness.title_failed'),
    unverified: t('readiness.hero_title')
  };
  $('#readiness-title').textContent = titles[status] || titles.unverified;
  const counts = readiness.summary || {};
  $('#readiness-summary').textContent = status === 'unverified'
    ? t('readiness.hero_summary')
    : t('readiness.summary_result', { passed: counts.passed || 0, warnings: counts.warnings || 0, failed: counts.failed || 0 });
  $('#readiness-meta').textContent = readiness.completed_at
    ? t('readiness.last_run', { date: formatDate(readiness.completed_at) }) + (readiness.stale ? t('readiness.stale_suffix') : '')
    : t('readiness.no_run_recorded');

  const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
  $('#readiness-checks').innerHTML = checks.length ? checks.map(check => `
    <article class="readiness-check ${escapeHTML(check.status)}">
      <div class="readiness-check-heading"><span class="readiness-icon" aria-hidden="true">${check.status === 'passed' ? '✓' : check.status === 'failed' ? '×' : '!'}</span><div><strong>${escapeHTML(check.label)}</strong><div class="meta-line">${escapeHTML(label(check.status))}${check.blocking ? t('readiness.blocking_suffix') : t('readiness.optional_suffix')} · ${(check.durationMs || 0) / 1000}s</div></div></div>
      <p>${escapeHTML(check.message)}</p>
      ${check.remediation ? `<small><strong>${escapeHTML(t('readiness.remediation_prefix'))}</strong> ${escapeHTML(check.remediation)}</small>` : ''}
    </article>`).join('') : empty(t('readiness.no_checks'));
}

function renderReviews(reviews) {
  const container = $('#review-list');
  if (!reviews.length) {
    container.innerHTML = empty(t('overview.no_review'));
    return;
  }
  container.innerHTML = reviews.slice(0, 5).map(item => `
    <article class="review-card">
      ${item.hasThumbnail ? `<img class="review-thumb" src="/api/content/${encodeURIComponent(item.id)}/asset/thumbnail" alt="">` : '<div class="review-thumb"></div>'}
      <div class="review-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${statusChip(item.review_status)} · ${escapeHTML(t('pipeline.quality_label'))} ${qualityScore(item.qualityChecks)}%</div></div>
      <button class="button secondary small" data-open-content="${escapeHTML(item.id)}">${escapeHTML(t('overview.review_button'))}</button>
    </article>`).join('');
}

function renderJobs(jobs) {
  const container = $('#job-list');
  if (!jobs.length) {
    container.innerHTML = empty(t('overview.no_jobs'));
    return;
  }
  const stages = ['strategy', 'script', 'thumbnail', 'seo', 'production', 'quality_review'];
  container.innerHTML = jobs.slice(0, 6).map(job => {
    const checkpoints = Array.isArray(job.checkpoints) ? job.checkpoints : [];
    const completed = new Set(checkpoints.filter(item => item.status === 'completed').map(item => item.stage));
    const mediaTasks = Array.isArray(job.mediaTasks) ? job.mediaTasks : [];
    const mediaCompleted = mediaTasks.filter(item => item.status === 'succeeded').length;
    const mediaProviders = [...new Set(mediaTasks.map(item => label(item.provider)))].join(', ');
    const resumeFrom = stages.find(stage => !completed.has(stage)) || 'quality_review';
    const recoverable = ['failed', 'interrupted'].includes(job.status);
    return `
    <article class="job-card">
      <div class="job-meta">
        <strong>${escapeHTML(job.title || job.topic || t('overview.no_topic_job'))}</strong>
        <div class="meta-line">${statusChip(job.status)} · ${escapeHTML(label(job.stage))} · ${timeAgo(job.updated_at)}</div>
        ${checkpoints.length ? `<div class="checkpoint-line">${t('overview.stages_saved', { n: completed.size, total: stages.length })}${job.details?.reusedStages?.length ? ` · ${t('overview.stages_reused', { n: job.details.reusedStages.length })}` : ''}</div>` : ''}
        ${mediaTasks.length ? `<div class="checkpoint-line">${t('overview.video_clips_ready', { n: mediaCompleted, total: mediaTasks.length })} · ${escapeHTML(mediaProviders)}</div>` : ''}
        <div class="progress"><i style="width:${Math.max(0, Math.min(100, job.progress || 0))}%"></i></div>
      </div>
      ${['queued', 'running'].includes(job.status) ? `<button class="text-button" data-cancel-job="${escapeHTML(job.id)}">${escapeHTML(t('overview.cancel_button'))}</button>` : ''}
      ${recoverable ? `<div class="job-recovery"><select data-resume-stage-for="${escapeHTML(job.id)}" aria-label="${escapeHTML(t('overview.resume_stage_aria'))}">${stages.map(stage => `<option value="${stage}" ${stage === resumeFrom ? 'selected' : ''}>${escapeHTML(label(stage))}</option>`).join('')}</select><button class="button secondary small" data-resume-job="${escapeHTML(job.id)}">${escapeHTML(t('overview.resume_button'))}</button></div>` : ''}
    </article>`;
  }).join('');
}

function renderSchedule(schedule, selector) {
  const container = $(selector);
  if (!schedule.length) {
    container.innerHTML = empty(t('overview.no_schedule'));
    return;
  }
  container.innerHTML = schedule.map(item => `
    <div class="timeline-item">
      <div class="date-chip"><small>${escapeHTML(new Date(item.publish_time).toLocaleDateString(getLanguage() === 'vi' ? 'vi-VN' : 'en-US', { month: 'short' }))}</small><strong>${escapeHTML(new Date(item.publish_time).getDate())}</strong></div>
      <div class="timeline-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${formatDate(item.publish_time)} · ${statusChip(item.status)}</div></div>
      <button class="text-button" data-open-content="${escapeHTML(item.production_id)}">${escapeHTML(t('overview.view_button'))}</button>
    </div>`).join('');
}

function renderNotifications(notifications, events) {
  const items = notifications.length
    ? notifications
    : events.map(event => ({ level: event.status === 'error' ? 'error' : 'info', title: label(event.event_type), message: event.data?.error || label(event.status), created_at: event.created_at }));
  const container = $('#notification-list');
  if (!items.length) {
    container.innerHTML = empty(t('overview.no_activity'));
    return;
  }
  container.innerHTML = items.slice(0, 7).map(item => `
    <div class="activity ${escapeHTML(item.level || 'info')}"><i></i><p><strong>${escapeHTML(item.title)}</strong><br><span class="meta-line">${escapeHTML(item.message)}</span></p><small>${timeAgo(item.created_at)}</small></div>`).join('');
}

function currentPipelineFilter() {
  return $('#pipeline-filter').value || 'all';
}

function renderPipeline(items) {
  const filter = currentPipelineFilter();
  const filtered = filter === 'all' ? items : items.filter(item =>
    item.review_status === filter || item.schedule_status === filter || item.status === filter
  );
  const container = $('#pipeline-list');
  if (!filtered.length) {
    container.innerHTML = empty(t('pipeline.no_match'));
    return;
  }
  container.innerHTML = filtered.map(item => {
    const state = item.schedule_status || item.review_status || item.status;
    const next = nextAction(item);
    return `<article class="pipeline-item" data-open-content="${escapeHTML(item.id)}">
      <div class="pipeline-title"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.topic || t('pipeline.no_topic'))} · ${formatDate(item.created_at)}</span></div>
      <div class="pipeline-col"><span>${escapeHTML(t('pipeline.state_label'))}</span><strong>${statusChip(state)}</strong></div>
      <div class="pipeline-col"><span>${escapeHTML(t('pipeline.quality_label'))}</span><strong>${qualityScore(item.qualityChecks)} / 100</strong></div>
      <button class="button secondary small">${escapeHTML(next)} →</button>
    </article>`;
  }).join('');
}

function qualityScore(checks) {
  if (!Array.isArray(checks) || !checks.length) return 0;
  return Math.round((checks.filter(check => check.passed).length / checks.length) * 100);
}

function nextAction(item) {
  if (item.schedule_status === 'published') return t('pipeline.next_view');
  if (item.review_status === 'needs_attention') return t('pipeline.next_fix_issues');
  if (item.review_status === 'needs_review') return t('pipeline.next_review');
  if (item.schedule_status === 'scheduled') return t('pipeline.next_scheduled');
  return t('pipeline.next_inspect');
}

function renderCalendar(schedule) {
  renderSchedule(schedule, '#calendar-list');
}

function renderIdeas(ideas) {
  const container = $('#idea-list');
  if (!ideas.length) {
    container.innerHTML = empty(t('calendar.no_ideas'));
    return;
  }
  container.innerHTML = ideas.map(idea => `
    <article class="idea-card">
      <div class="idea-meta"><strong>${escapeHTML(idea.topic)}</strong><div class="meta-line">${escapeHTML(idea.angle || idea.rationale || t('calendar.no_angle'))} · ${statusChip(idea.status)}</div></div>
      ${idea.status === 'backlog' ? `<button class="button secondary small" data-generate-idea="${escapeHTML(idea.id)}">${escapeHTML(t('calendar.generate_button'))}</button>` : ''}
    </article>`).join('');
}

function renderAnalytics(analytics, learning = {}) {
  $('#analytics-total').textContent = analytics.totalVideos || 0;
  $('#analytics-score').textContent = analytics.averagePerformanceScore ? `${analytics.averagePerformanceScore}/100` : '—';
  const insights = Array.isArray(analytics.insights) ? analytics.insights : [];
  const approved = (learning.recommendations || []).find(item => item.status === 'approved');
  const pending = (learning.recommendations || []).find(item => item.status === 'pending');
  $('#analytics-action').textContent = approved?.title || pending?.title || insights[0] || (analytics.totalVideos
    ? t('analytics.keep_collecting')
    : t('analytics.publish_first'));
  const performers = Array.isArray(analytics.topPerformers) ? analytics.topPerformers : [];
  $('#top-performers').innerHTML = performers.length ? performers.map(item => `
    <article class="performer-card"><strong>${escapeHTML(item.videoDetails?.title || item.title || t('analytics.untitled_video'))}</strong><div class="meta-line">${escapeHTML(t('analytics.performance_label', { score: item.performance?.score ?? item.performance_score ?? '—' }))}</div></article>`).join('') : empty(t('analytics.no_analyzed_videos'));
  renderLearning(learning);
  renderRetention(learning.retention || {});
}

function renderLearning(learning = {}) {
  const baseline = learning.baseline || {};
  $('#learning-snapshot-count').textContent = t('analytics.snapshots_count', { n: learning.snapshotCount || 0 });
  $('#learning-approved-count').textContent = t('analytics.approved_count', { n: learning.approvedCount || 0 });
  const metrics = [
    ['CTR', baseline.ctr, '%'],
    ['Retention', baseline.retention, '%'],
    ['Engagement', baseline.engagementRate, '%'],
    ['Performance', baseline.performanceScore, '/100']
  ];
  $('#learning-baseline').innerHTML = learning.measuredVideos ? metrics.map(([name, value, suffix]) => `
    <div><span>${escapeHTML(name)}</span><strong>${Number(value || 0).toFixed(1)}${escapeHTML(suffix)}</strong></div>`).join('') : empty(t('analytics.two_measurements'));

  const recommendations = Array.isArray(learning.recommendations) ? learning.recommendations : [];
  $('#learning-recommendations').innerHTML = recommendations.length ? recommendations.map(item => `
    <article class="learning-card">
      <div class="learning-card-heading"><strong>${escapeHTML(item.title)}</strong>${statusChip(item.status)}</div>
      <p>${escapeHTML(item.rationale)}</p>
      <div class="learning-meta"><span>${escapeHTML(label(item.category))} · ${escapeHTML(label(item.confidence))} ${escapeHTML(t('analytics.confidence_suffix'))}</span>
        <span class="learning-actions">
          ${item.status !== 'approved' ? `<button class="text-button approve" data-learning-action="approve" data-learning-id="${escapeHTML(item.id)}">${escapeHTML(t('analytics.approve_button'))}</button>` : ''}
          ${item.status !== 'rejected' ? `<button class="text-button" data-learning-action="reject" data-learning-id="${escapeHTML(item.id)}">${escapeHTML(t('analytics.reject_button'))}</button>` : ''}
        </span>
      </div>
    </article>`).join('') : empty(t('analytics.no_recommendation'));
}

function renderRetention(retention = {}) {
  const snapshots = Array.isArray(retention.snapshots) ? retention.snapshots : [];
  const select = $('#retention-snapshot-select');
  const refresh = $('#refresh-retention-button');
  if (!snapshots.length) {
    ui.retentionSnapshotId = null;
    select.innerHTML = `<option value="">${escapeHTML(t('analytics.no_curve_option'))}</option>`;
    select.disabled = true;
    refresh.disabled = true;
    $('#retention-meta').innerHTML = '';
    $('#retention-chart').innerHTML = empty(t('analytics.no_curves'));
    $('#retention-scenes').innerHTML = '';
    return;
  }

  if (!snapshots.some(item => item.id === ui.retentionSnapshotId)) ui.retentionSnapshotId = snapshots[0].id;
  select.disabled = false;
  refresh.disabled = false;
  select.innerHTML = snapshots.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === ui.retentionSnapshotId ? 'selected' : ''}>${escapeHTML(item.title || item.videoId)} · ${escapeHTML(label(item.surface))} · ${escapeHTML(item.measurementWindow)}</option>`).join('');
  const snapshot = snapshots.find(item => item.id === ui.retentionSnapshotId) || snapshots[0];
  refresh.dataset.videoId = snapshot.videoId;
  refresh.dataset.measurementWindow = snapshot.measurementWindow;

  const summary = snapshot.summary || {};
  $('#retention-meta').innerHTML = [
    t('analytics.real_points', { n: snapshot.points?.length || 0 }),
    t('analytics.scenes_count', { n: snapshot.sceneMetrics?.length || 0 }),
    t('analytics.dropoffs', { n: summary.dropoffCount || 0 }),
    t('analytics.rewatch_signals', { n: summary.rewatchCount || 0 }),
    `${escapeHTML(label(snapshot.confidence))} ${escapeHTML(t('analytics.confidence_suffix'))}`,
    `${escapeHTML(snapshot.measurementWindow)} ${escapeHTML(t('analytics.window_suffix'))}`
  ].map(item => `<span>${item}</span>`).join('');
  $('#retention-chart').innerHTML = retentionChart(snapshot);
  $('#retention-scenes').innerHTML = (snapshot.sceneMetrics || []).map(scene => `
    <article class="retention-scene ${escapeHTML(scene.signal)}">
      <div class="retention-scene-heading"><div><span>${escapeHTML(t('analytics.scene_label', { n: Number(scene.position || 0) + 1 }))}</span><strong>${escapeHTML(scene.label)}</strong></div>${statusChip(scene.signal)}</div>
      <div class="retention-metrics">
        <div><span>${escapeHTML(t('analytics.average_watching'))}</span><strong>${(Number(scene.averageWatchRatio || 0) * 100).toFixed(1)}%</strong></div>
        <div><span>${escapeHTML(t('analytics.scene_change'))}</span><strong>${Number(scene.changePoints || 0) > 0 ? '+' : ''}${Number(scene.changePoints || 0).toFixed(1)} pts</strong></div>
        <div><span>${escapeHTML(t('analytics.relative_retention'))}</span><strong>${(Number(scene.averageRelativeRetention || 0) * 100).toFixed(1)}%</strong></div>
        <div><span>${escapeHTML(t('analytics.sharpest_drop'))}</span><strong>${Number(scene.largestDropPoints || 0).toFixed(1)} pts</strong></div>
      </div>
    </article>`).join('') || empty(t('analytics.no_scene_mapping'));
}

function retentionChart(snapshot = {}) {
  const points = Array.isArray(snapshot.points) ? snapshot.points : [];
  if (points.length < 2) return empty(t('analytics.not_enough_points'));
  const width = 1000;
  const height = 280;
  const left = 46;
  const right = 18;
  const top = 18;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxRatio = Math.max(1, Math.min(1.5, Math.max(...points.map(point => Number(point.audienceWatchRatio || 0))) * 1.05));
  const x = ratio => left + Math.max(0, Math.min(1, Number(ratio || 0))) * plotWidth;
  const y = ratio => top + (1 - Math.max(0, Math.min(maxRatio, Number(ratio || 0))) / maxRatio) * plotHeight;
  const line = points.map(point => `${x(point.elapsedRatio).toFixed(1)},${y(point.audienceWatchRatio).toFixed(1)}`).join(' ');
  const duration = Math.max(1, Number(snapshot.durationSeconds || 1));
  const sceneBands = (snapshot.sceneMetrics || []).map((scene, index) => {
    const start = x(Number(scene.startSeconds || 0) / duration);
    const end = x(Number(scene.endSeconds || 0) / duration);
    return `<g><rect x="${start.toFixed(1)}" y="${top}" width="${Math.max(1, end - start).toFixed(1)}" height="${plotHeight}" class="retention-band band-${index % 2}"/><line x1="${start.toFixed(1)}" y1="${top}" x2="${start.toFixed(1)}" y2="${top + plotHeight}" class="scene-boundary"/><title>${escapeHTML(scene.label)}</title></g>`;
  }).join('');
  const grid = [0.25, 0.5, 0.75, 1].map(value => {
    const lineY = y(value);
    return `<line x1="${left}" y1="${lineY.toFixed(1)}" x2="${width - right}" y2="${lineY.toFixed(1)}" class="retention-grid-line"/><text x="${left - 8}" y="${(lineY + 4).toFixed(1)}" text-anchor="end">${Math.round(value * 100)}%</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="retention-chart-title retention-chart-desc">
    <title id="retention-chart-title">${escapeHTML(t('analytics.retention_chart_title', { title: snapshot.title || snapshot.videoId }))}</title>
    <desc id="retention-chart-desc">${escapeHTML(t('analytics.retention_chart_desc', { points: points.length, scenes: snapshot.sceneMetrics?.length || 0 }))}</desc>
    ${sceneBands}${grid}
    <polyline points="${line}" class="retention-line"/>
    <text x="${left}" y="${height - 10}" text-anchor="start">${escapeHTML(t('analytics.chart_start'))}</text>
    <text x="${width - right}" y="${height - 10}" text-anchor="end">${escapeHTML(t('analytics.chart_end'))}</text>
  </svg>`;
}

function renderActivation(activation = {}) {
  const container = $('#activation-list');
  if (!container) return;
  const milestones = activation.milestones || {};
  const rows = [
    [t('analytics.milestone_setup_ready'), milestones.setupReady],
    [t('analytics.milestone_first_video'), milestones.firstRealVideo],
    [t('analytics.milestone_first_approval'), milestones.firstApproval],
    [t('analytics.milestone_first_publish'), milestones.firstPublish],
    [t('analytics.milestone_second_video'), milestones.secondRealVideo]
  ];
  container.innerHTML = rows.map(([name, milestone = {}]) => `
    <div class="timeline-item">
      <div class="timeline-dot ${milestone.achieved ? 'done' : ''}"></div>
      <div><strong>${escapeHTML(name)}</strong><div class="meta-line">${milestone.achieved ? escapeHTML(formatDate(milestone.at)) : escapeHTML(t('analytics.not_reached_yet'))}</div></div>
    </div>`).join('');
  if (milestones.firstRealVideo?.achieved) {
    container.insertAdjacentHTML('beforeend', `
      <div class="activation-share">
        <span>${escapeHTML(t('analytics.share_prompt'))}</span>
        <a class="button secondary small" href="https://github.com/darkzOGx/youtube-automation-agent/discussions/new?category=show-and-tell" target="_blank" rel="noreferrer">${escapeHTML(t('analytics.share_button'))}</a>
      </div>`);
  }
}

function renderOperator(strategy, runs, system) {
  const form = $('#strategy-form');
  const mapping = strategy ? {
    objective: strategy.objective,
    audience: strategy.audience,
    valueProposition: strategy.value_proposition,
    contentPillars: (strategy.contentPillars || []).join(', '),
    cadencePerWeek: strategy.cadence_per_week,
    videosPerRun: strategy.videos_per_run,
    defaultFormat: strategy.default_format,
    defaultLength: strategy.default_length,
    successMetric: strategy.success_metric,
    constraints: strategy.constraints
  } : {};
  for (const [name, value] of Object.entries(mapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value ?? '';
  }

  const strategyStatus = strategy?.status || 'not_configured';
  $('#operator-strategy-status').className = `status ${escapeHTML(strategyStatus)}`;
  $('#operator-strategy-status').textContent = label(strategyStatus);
  const run = runs[0];
  const active = run && ['queued', 'running', 'cancelling'].includes(run.status);
  const recoverable = run && ['failed', 'interrupted', 'completed_with_issues'].includes(run.status);
  $('#activate-operator-button').disabled = Boolean(system.setupRequired || active || system.readiness?.status === 'failed');
  $('#activate-operator-button').title = system.readiness?.status === 'failed' ? t('operator.readiness_blocked_title') : '';
  $('#activate-operator-button').textContent = strategy?.status === 'active' ? t('operator.run_strategy_now') : t('operator.activate_run');
  $('#pause-operator-button').classList.toggle('hidden', strategy?.status !== 'active');
  $('#cancel-operator-run').classList.toggle('hidden', !active);
  if (active) $('#cancel-operator-run').dataset.runId = run.id;
  $('#resume-operator-run').classList.toggle('hidden', !recoverable);
  $('#resume-operator-run').disabled = Boolean(system.setupRequired || system.readiness?.status === 'failed');
  if (recoverable) $('#resume-operator-run').dataset.runId = run.id;

  if (!run) {
    $('#operator-run-title').textContent = t('operator.waiting_for_strategy');
    $('#operator-run-summary').innerHTML = empty(t('operator.no_run_summary'));
    $('#operator-plan').innerHTML = empty(t('operator.no_plan'));
    return;
  }

  $('#operator-run-title').textContent = `${label(run.stage)} · ${run.progress || 0}%`;
  const sources = Array.isArray(run.research?.sources) ? run.research.sources.join(', ') : t('operator.research_pending');
  $('#operator-run-summary').innerHTML = `<div class="run-summary">
    <div class="progress"><i style="width:${Math.max(0, Math.min(100, run.progress || 0))}%"></i></div>
    <div class="run-summary-row"><span>${escapeHTML(t('operator.status_label'))}</span><strong>${statusChip(run.status)}</strong></div>
    <div class="run-summary-row"><span>${escapeHTML(t('operator.research_label'))}</span><strong>${escapeHTML(sources)}</strong></div>
    <div class="run-summary-row"><span>${escapeHTML(t('operator.produced_label'))}</span><strong>${escapeHTML(run.summary?.generated || 0)} / ${escapeHTML(run.summary?.planned || run.plan?.length || 0)}</strong></div>
    <div class="run-summary-row"><span>${escapeHTML(t('operator.needs_review_label'))}</span><strong>${escapeHTML(run.summary?.needsReview || 0)}</strong></div>
    ${run.error ? `<p class="callout">${escapeHTML(run.error)}</p>` : ''}
  </div>`;
  const plan = Array.isArray(run.plan) ? run.plan : [];
  $('#operator-plan').innerHTML = plan.length ? plan.map((item, index) => {
    const job = (run.generatedJobs || []).find(candidate => candidate.topic === item.topic);
    return `<article class="plan-card">
      <div class="meta-line">${index + 1} · ${escapeHTML(item.format)} · ${escapeHTML(item.length)} ${job ? `· ${statusChip(job.reviewStatus || job.status)}` : ''}</div>
      <strong>${escapeHTML(item.topic)}</strong>
      <p>${escapeHTML(item.angle || item.rationale)}</p>
    </article>`;
  }).join('') : empty(t('operator.no_plan_yet'));
}

function populateSettings(profile = {}, settings = {}, providers = []) {
  const form = $('#profile-form');
  const mapping = {
    channelName: profile.channel_name,
    goal: profile.goal,
    targetAudience: profile.target_audience,
    brandVoice: profile.brand_voice,
    defaultStyle: profile.default_style,
    callToAction: profile.call_to_action,
    visualStyle: profile.visual_style,
    timezone: profile.timezone,
    bannedTopics: (profile.bannedTopics || []).join(', ')
  };
  for (const [name, value] of Object.entries(mapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value || '';
  }
  $('#approval-required').checked = settings.approval_required !== 'false';
  $('#notifications-enabled').checked = settings.notification_enabled !== 'false';
  const videoMapping = {
    videoProvider: settings.video_provider || 'slideshow',
    videoGenerationMode: settings.video_generation_mode || 'hybrid',
    videoClipDuration: settings.video_clip_duration || '8',
    videoMaxGeneratedSeconds: settings.video_max_generated_seconds || '60'
  };
  for (const [name, value] of Object.entries(videoMapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value;
  }
  const selected = providers.find(provider => provider.id === videoMapping.videoProvider);
  $('#video-provider-status').textContent = videoMapping.videoProvider === 'auto'
    ? t('settings.video_provider_status_auto', { n: providers.filter(provider => provider.available && provider.id !== 'slideshow').length })
    : videoMapping.videoProvider === 'slideshow' ? t('settings.video_provider_status_slideshow')
      : selected?.available ? t('settings.video_provider_status_configured', { name: label(selected.id), model: selected.model }) : t('settings.video_provider_status_not_configured', { name: label(videoMapping.videoProvider) });
}

function switchView(view) {
  ui.currentView = view;
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach(item => item.classList.toggle('active', item.id === `${view}-view`));
  const titleKeys = {
    overview: ['overview.eyebrow', 'overview.title'],
    operator: ['operator.eyebrow', 'operator.title'],
    pipeline: ['pipeline.eyebrow', 'pipeline.title'],
    calendar: ['calendar.eyebrow', 'calendar.title'],
    analytics: ['analytics.eyebrow', 'analytics.title'],
    readiness: ['readiness.eyebrow', 'readiness.title'],
    settings: ['settings.eyebrow', 'settings.title']
  };
  $('#view-eyebrow').textContent = t(titleKeys[view][0]);
  $('#view-title').textContent = t(titleKeys[view][1]);
  location.hash = view;
  if (view === 'settings') renderIntegrationsPanel();
}

function selectOptions(options, selected) {
  return options.map(([value, label]) =>
    `<option value="${escapeHTML(value)}" ${value === selected ? 'selected' : ''}>${escapeHTML(label)}</option>`
  ).join('');
}

function renderSourceEditor(source = {}, disabled = false) {
  return `<article class="provenance-item" data-provenance-source data-id="${escapeHTML(source.id || '')}" data-published-at="${escapeHTML(source.publishedAt || '')}" data-accessed-at="${escapeHTML(source.accessedAt || '')}">
    <div class="provenance-item-heading"><strong>${t('content.source_heading')}</strong><button type="button" class="text-button danger-text" data-remove-provenance ${disabled ? 'disabled' : ''}>${t('content.remove')}</button></div>
    <label><span>${t('content.url_label')}</span><input data-field="url" type="url" value="${escapeHTML(source.url || '')}" placeholder="${escapeHTML(t('content.url_placeholder'))}" required ${disabled ? 'disabled' : ''}></label>
    <div class="form-grid two">
      <label><span>${t('content.title_label')}</span><input data-field="title" value="${escapeHTML(source.title || '')}" maxlength="300" ${disabled ? 'disabled' : ''}></label>
      <label><span>${t('content.publisher_label')}</span><input data-field="publisher" value="${escapeHTML(source.publisher || '')}" maxlength="200" ${disabled ? 'disabled' : ''}></label>
      <label><span>${t('content.type_label')}</span><select data-field="sourceType" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['official', t('content.source_type_official')], ['article', t('content.source_type_article')], ['video', t('content.source_type_video')], ['dataset', t('content.source_type_dataset')], ['asset', t('content.source_type_asset')], ['other', t('content.source_type_other')]
      ], source.sourceType || 'other')}</select></label>
      <label><span>${t('content.review_status_label')}</span><select data-field="status" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['pending', t('content.source_status_pending')], ['verified', t('content.source_status_verified')], ['rejected', t('content.source_status_rejected')]
      ], source.status || 'pending')}</select></label>
    </div>
    <label><span>${t('content.evidence_notes_label')}</span><textarea data-field="notes" rows="2" maxlength="1000" ${disabled ? 'disabled' : ''}>${escapeHTML(source.notes || '')}</textarea></label>
    ${source.url ? `<a class="source-link" href="${escapeHTML(source.url)}" target="_blank" rel="noopener">${t('content.open_source_link')}</a>` : ''}
  </article>`;
}

function renderClaimEditor(claim = {}, sources = [], disabled = false) {
  const linked = new Set(claim.sourceIds || []);
  return `<article class="provenance-item ${claim.riskLevel === 'high' ? 'high-risk' : ''}" data-provenance-claim data-id="${escapeHTML(claim.id || '')}">
    <div class="provenance-item-heading"><strong>${t('content.claim_heading')}</strong><button type="button" class="text-button danger-text" data-remove-provenance ${disabled ? 'disabled' : ''}>${t('content.remove')}</button></div>
    <label><span>${t('content.claim_label')}</span><textarea data-field="text" rows="3" maxlength="1000" required ${disabled ? 'disabled' : ''}>${escapeHTML(claim.text || '')}</textarea></label>
    <div class="form-grid two">
      <label><span>${t('content.risk_label')}</span><select data-field="riskLevel" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['standard', t('content.risk_standard')], ['high', t('content.risk_high')]
      ], claim.riskLevel || 'standard')}</select></label>
      <label><span>${t('content.resolution_label')}</span><select data-field="status" ${disabled ? 'disabled' : ''}>${selectOptions([
        ['pending', t('content.claim_status_pending')], ['supported', t('content.claim_status_supported')], ['unsupported', t('content.claim_status_unsupported')], ['waived', t('content.claim_status_waived')]
      ], claim.status || 'pending')}</select></label>
    </div>
    <fieldset class="source-checklist" ${disabled ? 'disabled' : ''}><legend>${t('content.supporting_sources_legend')}</legend>
      ${sources.length ? sources.map(source => `<label><input type="checkbox" data-claim-source="${escapeHTML(source.id)}" ${linked.has(source.id) ? 'checked' : ''}> ${escapeHTML(source.title || source.url)}</label>`).join('') : `<small>${t('content.add_source_before_claim')}</small>`}
    </fieldset>
    <label><span>${t('content.reviewer_notes_label')}</span><textarea data-field="notes" rows="2" maxlength="1000" placeholder="${escapeHTML(t('content.required_when_waived_placeholder'))}" ${disabled ? 'disabled' : ''}>${escapeHTML(claim.notes || '')}</textarea></label>
  </article>`;
}

function renderProvenanceEditor(provenance = {}, canReview = true) {
  const sources = provenance.sources || [];
  const claims = provenance.claims || [];
  const summary = provenance.summary || {};
  const statusLabel = provenance.status === 'verified' ? t('content.evidence_verified') : provenance.status === 'not_required' ? t('content.no_claims_declared') : t('content.unresolved_count', { n: summary.unresolvedClaims || 0 });
  return `<section class="provenance-panel">
    <div class="panel-heading"><div><p class="eyebrow">${t('content.provenance_eyebrow')}</p><h3>${t('content.evidence_desk_heading')}</h3><p>${t('content.evidence_desk_desc')}</p></div><span class="status ${provenance.status === 'verified' || provenance.status === 'not_required' ? 'success' : 'warning'}">${escapeHTML(statusLabel)}</span></div>
    <div class="provenance-toolbar"><strong>${t('content.sources_label')}</strong>${canReview ? `<button type="button" class="text-button" data-add-provenance-source>${t('content.add_source_button')}</button>` : ''}</div>
    <div id="provenance-sources" class="provenance-list">${sources.map(source => renderSourceEditor(source, !canReview)).join('') || `<p class="empty-inline">${t('content.no_sources_attached')}</p>`}</div>
    <div class="provenance-toolbar"><strong>${t('content.claims_label')}</strong>${canReview ? `<button type="button" class="text-button" data-add-provenance-claim>${t('content.add_claim_button')}</button>` : ''}</div>
    <div id="provenance-claims" class="provenance-list">${claims.map(claim => renderClaimEditor(claim, sources, !canReview)).join('') || `<p class="empty-inline">${t('content.no_claims_attached')}</p>`}</div>
    <label class="toggle disclosure-toggle"><input id="contains-synthetic-media" type="checkbox" ${provenance.containsSyntheticMedia ? 'checked' : ''} ${canReview ? '' : 'disabled'}><span></span> ${t('content.synthetic_media_toggle')}</label>
    ${canReview ? `<button type="button" class="button secondary" data-save-provenance>${t('content.save_evidence_button')}</button>` : ''}
  </section>`;
}

function renderSceneEditor(item, canReview = true) {
  const scenes = item.scenes || [];
  if (!scenes.length) return '';
  const verifiedSources = (item.provenance?.sources || []).filter(source => source.status === 'verified');
  const audio = item.assets?.audio || {};
  const intentionalSilence = audio.intentionalSilence === true;
  const narrationIssues = scenes.filter(scene => !['current', 'intentional_silence'].includes(scene.narrationStatus)).length;
  return `<section class="scene-repair-panel">
    <div class="panel-heading scene-heading">
      <div><p class="eyebrow">${t('content.scene_studio_eyebrow')}</p><h3>${t('content.scene_studio_heading')}</h3><p>${t('content.scene_studio_desc')}</p></div>
      ${canReview ? `<button type="button" class="button primary small" data-rebuild-scenes="${escapeHTML(item.id)}">${t('content.rebuild_final_video_button')}</button>` : ''}
    </div>
    <div class="narration-recovery ${intentionalSilence ? 'intentional' : narrationIssues ? 'attention' : ''}">
      <div><p class="eyebrow">${t('content.narration_reliability_eyebrow')}</p><strong>${intentionalSilence ? t('content.silence_confirmed') : narrationIssues ? t('content.scenes_need_narration', { n: narrationIssues }) : t('content.narration_current')}</strong>
      <p>${intentionalSilence ? escapeHTML(audio.silenceReason || '') : audio.error ? escapeHTML(audio.error) : t('content.narration_recovery_desc')}</p>
      ${audio.provider ? `<span class="narration-evidence">${escapeHTML(audio.provider)}${audio.model ? ` · ${escapeHTML(audio.model)}` : ''}${audio.externalTaskId ? ` · ${escapeHTML(t('content.task_label', { id: audio.externalTaskId }))}` : ''}</span>` : ''}</div>
      ${canReview ? intentionalSilence
        ? `<button type="button" class="button secondary small" data-require-narration>${t('content.require_narration_button')}</button>`
        : `<button type="button" class="button secondary small" data-intentional-silence>${t('content.use_intentional_silence_button')}</button>` : ''}
    </div>
    <div class="scene-summary"><strong>${t('content.scenes_count', { n: scenes.length })}</strong><span>${t('content.timeline_duration', { n: Math.round(scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0)) })}</span><span>${t('content.pending_repairs', { n: scenes.filter(scene => scene.status !== 'ready').length })}</span></div>
    <div class="scene-list">
      ${scenes.map((scene, index) => {
        const disabled = !canReview || scene.locked;
        const sourceIds = new Set(scene.provenanceSourceIds || []);
        const preview = scene.assetUrl
          ? scene.assetType === 'video'
            ? `<video controls preload="metadata"><source src="${escapeHTML(scene.assetUrl)}"></video>`
            : `<img src="${escapeHTML(scene.assetUrl)}" alt="${escapeHTML(scene.label)} ${escapeHTML(t('content.scene_asset_alt_suffix'))}">`
          : `<div class="preview-placeholder">${t('content.no_scene_asset')}</div>`;
        return `<article class="scene-card ${scene.locked ? 'locked' : ''}" data-scene-card="${escapeHTML(scene.id)}">
          <div class="scene-card-top">
            <div class="scene-preview">${preview}<span class="scene-number">${index + 1}</span></div>
            <div class="scene-identity">
              <div class="scene-status-row">${statusChip(scene.status)} ${statusChip(`narration_${scene.narrationStatus || 'unavailable'}`)}<span>r${scene.revision}</span></div>
              <label><span>${t('content.scene_label_field')}</span><input data-scene-field="label" maxlength="120" value="${escapeHTML(scene.label)}" ${disabled ? 'disabled' : ''}></label>
              <label><span>${t('content.duration_label')}</span><input data-scene-field="duration" type="number" min="2" max="600" step="0.5" value="${escapeHTML(scene.duration)}" ${disabled ? 'disabled' : ''}></label>
            </div>
          </div>
          <label><span>${t('content.narration_field_label')}</span><textarea data-scene-field="scriptText" rows="4" maxlength="10000" ${disabled ? 'disabled' : ''}>${escapeHTML(scene.scriptText)}</textarea></label>
          <label><span>${t('content.visual_prompt_label')}</span><textarea data-scene-field="prompt" rows="3" maxlength="2000" ${disabled ? 'disabled' : ''}>${escapeHTML(scene.prompt)}</textarea></label>
          ${verifiedSources.length ? `<fieldset class="source-checklist scene-sources" ${disabled ? 'disabled' : ''}><legend>${t('content.verified_evidence_legend')}</legend>${verifiedSources.map(source => `<label><input type="checkbox" data-scene-source value="${escapeHTML(source.id)}" ${sourceIds.has(source.id) ? 'checked' : ''}> ${escapeHTML(source.title)}</label>`).join('')}</fieldset>` : ''}
          <div class="scene-options">
            <label class="toggle"><input type="checkbox" data-scene-factual checked ${disabled ? 'disabled' : ''}><span></span> ${t('content.narration_factual_toggle')}</label>
            <span>${escapeHTML(t('content.visual_prefix'))} ${escapeHTML(scene.provider || t('content.local_default'))} ${scene.model ? `· ${escapeHTML(scene.model)}` : ''}</span>
          </div>
          <div class="scene-narration-evidence"><span>${escapeHTML(t('content.narration_prefix'))} ${escapeHTML(scene.narrationProvider || t('content.not_generated'))}${scene.narrationModel ? ` · ${escapeHTML(scene.narrationModel)}` : ''}${scene.narrationTaskId ? ` · ${escapeHTML(t('content.task_label', { id: scene.narrationTaskId }))}` : ''}</span>${scene.narrationError ? `<span class="danger-text">${escapeHTML(scene.narrationError)}</span>` : ''}</div>
          ${canReview ? `<div class="scene-actions">
            <button type="button" class="text-button" data-scene-move="up" ${disabled || index === 0 ? 'disabled' : ''}>${t('content.move_earlier')}</button>
            <button type="button" class="text-button" data-scene-move="down" ${disabled || index === scenes.length - 1 ? 'disabled' : ''}>${t('content.move_later')}</button>
            <button type="button" class="text-button approve" data-scene-save ${disabled ? 'disabled' : ''}>${t('content.save_scene_button')}</button>
            <button type="button" class="text-button" data-scene-narration ${disabled ? 'disabled' : ''}>${t('content.regenerate_narration_only_button')}</button>
            <button type="button" class="text-button" data-scene-regenerate ${disabled ? 'disabled' : ''}>${t('content.regenerate_scene_button')}</button>
            <label class="text-button upload-button ${disabled ? 'disabled' : ''}">${t('content.replace_asset_button')}<input type="file" data-scene-upload accept="image/png,image/jpeg,image/webp,video/mp4" ${disabled ? 'disabled' : ''}></label>
            <button type="button" class="text-button" data-scene-lock>${scene.locked ? t('content.unlock_button') : t('content.lock_button')}</button>
          </div>` : ''}
        </article>`;
      }).join('')}
    </div>
  </section>`;
}

function renderShortsStudio(item) {
  if (!item.assets?.finalVideo?.path || item.assets.finalVideo.simulated) return '';
  const clips = item.shorts || [];
  const parentApproved = item.review_status === 'approved';
  return `<section class="shorts-studio">
    <div class="panel-heading shorts-heading">
      <div><p class="eyebrow">${t('content.shorts_studio_eyebrow')}</p><h3>${t('content.shorts_studio_heading')}</h3><p>${t('content.shorts_studio_desc')}</p></div>
      <button type="button" class="button secondary small" data-propose-shorts="${escapeHTML(item.id)}">${clips.length ? t('content.refresh_drafts_button') : t('content.create_short_drafts_button')}</button>
    </div>
    <div class="shorts-evidence ${parentApproved ? 'ready' : ''}">
      <span>${parentApproved ? t('content.source_approved_badge') : t('content.source_approval_required')}</span>
      <span>${escapeHTML(item.provenance?.status === 'verified' ? t('content.evidence_verified') : item.provenance?.status === 'not_required' ? t('content.no_factual_claims_declared') : t('content.evidence_review_incomplete'))}</span>
      <span>${t('content.local_render_note')}</span>
    </div>
    ${clips.length ? `<div class="shorts-grid">${clips.map(clip => {
      const locked = ['scheduled', 'uploading', 'published', 'reconciliation_required'].includes(clip.status);
      const rendered = Boolean(clip.assetUrls?.video);
      return `<article class="short-card" data-short-card="${escapeHTML(clip.id)}">
        <div class="short-preview">${rendered
          ? `<video controls preload="metadata"><source src="${escapeHTML(clip.assetUrls.video)}" type="video/mp4"></video>`
          : `<div class="short-placeholder"><strong>9:16</strong><span>${escapeHTML(t('content.layout_suffix', { layout: label(clip.layout) }))}</span></div>`}</div>
        <div class="short-editor">
          <div class="scene-status-row">${statusChip(clip.status)}<span>${Number(clip.duration || 0).toFixed(0)}s</span><span>${escapeHTML((clip.sourceSceneLabels || []).join(' + '))}</span></div>
          <label><span>${t('content.short_title_label')}</span><input data-short-field="title" maxlength="100" value="${escapeHTML(clip.title)}" ${locked ? 'disabled' : ''}></label>
          <label><span>${t('content.short_description_label')}</span><textarea data-short-field="description" rows="3" maxlength="5000" ${locked ? 'disabled' : ''}>${escapeHTML(clip.description)}</textarea></label>
          <label><span>${t('content.tags_label')}</span><input data-short-field="tags" value="${escapeHTML((clip.tags || []).join(', '))}" ${locked ? 'disabled' : ''}></label>
          <div class="form-grid two">
            <label><span>${t('content.vertical_layout_label')}</span><select data-short-field="layout" ${locked ? 'disabled' : ''}><option value="blur" ${clip.layout === 'blur' ? 'selected' : ''}>${t('content.layout_blur')}</option><option value="crop" ${clip.layout === 'crop' ? 'selected' : ''}>${t('content.layout_crop')}</option><option value="stacked" ${clip.layout === 'stacked' ? 'selected' : ''}>${t('content.layout_stacked')}</option></select></label>
            <label><span>${t('content.publish_time_label')}</span><input data-short-field="publishTime" type="datetime-local" value="${toLocalInput(clip.publishTime)}" ${locked ? 'disabled' : ''}></label>
            <label><span>${t('content.privacy_label')}</span><select data-short-field="privacyStatus" ${locked ? 'disabled' : ''}><option value="private" ${clip.privacyStatus === 'private' ? 'selected' : ''}>${t('content.privacy_private')}</option><option value="unlisted" ${clip.privacyStatus === 'unlisted' ? 'selected' : ''}>${t('content.privacy_unlisted')}</option><option value="public" ${clip.privacyStatus === 'public' ? 'selected' : ''}>${t('content.privacy_public')}</option></select></label>
          </div>
          <p class="short-rationale">${escapeHTML(clip.rationale || '')}${clip.error ? `<br><span class="danger-text">${escapeHTML(clip.error)}</span>` : ''}</p>
          ${clip.youtubeUrl ? `<a class="source-link" href="${escapeHTML(clip.youtubeUrl)}" target="_blank" rel="noopener">${t('content.open_published_short_link')}</a>` : ''}
          ${!locked ? `<div class="short-actions"><button type="button" class="text-button" data-short-save>${t('content.save_draft_button')}</button><button type="button" class="button secondary small" data-short-render>${rendered ? t('content.render_again_button') : t('content.render_short_button')}</button><button type="button" class="button primary small" data-short-approve ${!parentApproved || clip.status !== 'rendered' ? 'disabled' : ''} title="${!parentApproved ? escapeHTML(t('content.approve_source_first_tooltip')) : clip.status !== 'rendered' ? escapeHTML(t('content.render_short_first_tooltip')) : escapeHTML(t('content.confirm_schedule_short_tooltip'))}">${t('content.approve_schedule_button')}</button></div>` : ''}
        </div>
      </article>`;
    }).join('')}</div>` : `<p class="empty-inline">${t('content.no_short_drafts')}</p>`}
  </section>`;
}

async function openContent(productionId) {
  $('#loading').classList.add('active');
  try {
    const item = await api(`/api/content/${encodeURIComponent(productionId)}`);
    const data = item.editorData || {};
    const title = data.title || item.seo?.title || item.script?.title || item.strategy?.topic || t('content.untitled_fallback');
    const description = data.description || item.seo?.description || '';
    const tags = data.tags || item.seo?.tags || [];
    const publishTime = data.publishTime || item.schedule?.publish_time || item.scheduled_publish_time;
    const canReview = !['published'].includes(item.schedule?.status);
    const experiment = data.packagingExperiment;
    const selectedTitleVariant = Number(data.selectedTitleVariant || 0);
    const selectedThumbnailVariant = Number(data.selectedThumbnailVariant || 0);
    $('#content-detail').innerHTML = `
      <div class="dialog-heading"><div><p class="eyebrow">${t('content.review_eyebrow')}</p><h2>${escapeHTML(title)}</h2><div class="meta-line">${statusChip(item.schedule?.status || item.review_status || item.status)} · ${escapeHTML(t('content.quality_label', { pct: qualityScore(item.qualityChecks) }))}</div></div><button type="button" class="close-button" data-close>×</button></div>
      <form id="content-review-form" class="editor content-review-editor">
        <div class="content-layout">
          <div>
            <div class="preview">${item.assetUrls.video ? `<video controls preload="metadata" poster="${item.assetUrls.thumbnail || ''}"><source src="${item.assetUrls.video}" type="video/mp4"></video>` : item.assetUrls.thumbnail ? `<img src="${item.assetUrls.thumbnail}" alt="${escapeHTML(t('content.generated_thumbnail_alt'))}">` : `<div class="preview-placeholder">${t('content.no_preview_produced')}</div>`}</div>
            <div class="quality-grid">${(item.qualityChecks || []).map(check => `<div class="quality-check ${check.passed ? 'pass' : 'fail'}">${check.passed ? '✓' : '×'} ${escapeHTML(check.message)}</div>`).join('') || `<div class="quality-check">${t('content.no_quality_results')}</div>`}</div>
            ${item.review_notes ? `<p class="callout">${escapeHTML(item.review_notes)}</p>` : ''}
          </div>
          <div class="editor">
            <label><span>${t('content.title_label')}</span><input name="title" maxlength="100" value="${escapeHTML(title)}" required></label>
            <label><span>${t('content.description_label')}</span><textarea name="description" rows="7">${escapeHTML(description)}</textarea></label>
            <label><span>${t('content.tags_label')}</span><input name="tags" value="${escapeHTML(tags.join(', '))}"></label>
            ${experiment ? `<section class="experiment-panel">
              <div><p class="eyebrow">${t('content.experiment_eyebrow')}</p><strong>${escapeHTML(experiment.hypothesis)}</strong><p>${t('content.experiment_desc')}</p></div>
              <label><span>${t('content.title_variant_label')}</span><select name="selectedTitleVariant">${experiment.titleVariants.map((variant, index) => `<option value="${index}" data-title="${escapeHTML(variant.title)}" ${index === selectedTitleVariant ? 'selected' : ''}>${escapeHTML(variant.label)} — ${escapeHTML(variant.title)}</option>`).join('')}</select></label>
              <div class="experiment-thumbnails">${experiment.thumbnailVariants.map((variant, index) => `<label class="experiment-thumb ${index === selectedThumbnailVariant ? 'selected' : ''}"><input type="radio" name="selectedThumbnailVariant" value="${index}" ${index === selectedThumbnailVariant ? 'checked' : ''}><img src="${escapeHTML(item.assetUrls.experimentThumbnails?.[index] || '')}" alt="${escapeHTML(t('content.thumbnail_variant_alt', { label: variant.label }))}"><span>${escapeHTML(variant.label)}</span></label>`).join('')}</div>
            </section>` : ''}
          </div>
        </div>
        ${renderSceneEditor(item, canReview)}
        ${renderShortsStudio(item)}
        ${renderProvenanceEditor(item.provenance, canReview)}
          <div class="form-grid two">
            <label><span>${t('content.publish_time_label')}</span><input name="publishTime" type="datetime-local" value="${toLocalInput(publishTime)}"></label>
            <label><span>${t('content.privacy_label')}</span><select name="privacyStatus"><option value="private" ${data.privacyStatus === 'private' ? 'selected' : ''}>${t('content.privacy_private')}</option><option value="unlisted" ${data.privacyStatus === 'unlisted' ? 'selected' : ''}>${t('content.privacy_unlisted')}</option><option value="public" ${data.privacyStatus === 'public' ? 'selected' : ''}>${t('content.privacy_public')}</option></select></label>
          </div>
          <div class="settings-row">
            <label class="toggle"><input name="factChecked" type="checkbox" ${data.factChecked ? 'checked' : ''}><span></span> ${t('content.facts_reviewed_toggle')}</label>
            <label class="toggle"><input name="rightsConfirmed" type="checkbox" ${data.rightsConfirmed ? 'checked' : ''}><span></span> ${t('content.rights_confirmed_toggle')}</label>
          </div>
          ${canReview ? `<div class="form-actions"><button type="button" class="button primary" data-approve-content="${escapeHTML(item.id)}">${t('content.approve_schedule_button')}</button><button type="button" class="button secondary" data-save-content="${escapeHTML(item.id)}">${t('content.save_draft_button')}</button><button type="button" class="button danger" data-reject-content="${escapeHTML(item.id)}">${t('content.reject_button')}</button><button type="button" class="button ghost" data-retry-content="${escapeHTML(item.id)}">${t('content.regenerate_button')}</button></div>` : `<a class="button secondary" href="${escapeHTML(item.schedule?.youtube_url || '#')}" target="_blank" rel="noopener">${t('content.open_youtube_link')}</a>`}
      </form>`;
    $('#content-review-form').dataset.productionId = item.id;
    $('#content-dialog').showModal();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading').classList.remove('active');
  }
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return escapeHTML(new Date(date.getTime() - offset).toISOString().slice(0, 16));
}

function contentFormData() {
  const form = $('#content-review-form');
  const values = Object.fromEntries(new FormData(form));
  return {
    title: values.title,
    description: values.description,
    tags: values.tags,
    publishTime: values.publishTime ? new Date(values.publishTime).toISOString() : undefined,
    privacyStatus: values.privacyStatus,
    selectedTitleVariant: values.selectedTitleVariant,
    selectedThumbnailVariant: values.selectedThumbnailVariant,
    factChecked: form.elements.factChecked?.checked || false,
    rightsConfirmed: form.elements.rightsConfirmed?.checked || false
  };
}

function sceneFormData(card) {
  return {
    label: card.querySelector('[data-scene-field="label"]').value,
    duration: Number(card.querySelector('[data-scene-field="duration"]').value),
    scriptText: card.querySelector('[data-scene-field="scriptText"]').value,
    prompt: card.querySelector('[data-scene-field="prompt"]').value,
    provenanceSourceIds: Array.from(card.querySelectorAll('[data-scene-source]:checked')).map(input => input.value),
    factualChange: card.querySelector('[data-scene-factual]')?.checked !== false
  };
}

function shortFormData(card) {
  const publishTime = card.querySelector('[data-short-field="publishTime"]')?.value;
  return {
    title: card.querySelector('[data-short-field="title"]')?.value,
    description: card.querySelector('[data-short-field="description"]')?.value,
    tags: card.querySelector('[data-short-field="tags"]')?.value,
    layout: card.querySelector('[data-short-field="layout"]')?.value,
    publishTime: publishTime ? new Date(publishTime).toISOString() : undefined,
    privacyStatus: card.querySelector('[data-short-field="privacyStatus"]')?.value
  };
}

async function refreshContentDialog(productionId, message) {
  if (message) showToast(message);
  if ($('#content-dialog').open) $('#content-dialog').close();
  await refreshDashboard(true);
  await openContent(productionId);
}

async function uploadSceneAsset(productionId, sceneId, file) {
  if (!confirm(t('confirm.own_permission_replacement'))) return;
  const synthetic = confirm(t('confirm.synthetic_media_disclosure'));
  $('#loading').classList.add('active');
  try {
    await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/asset`, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type,
        'x-file-name': file.name,
        'x-rights-confirmed': 'true',
        'x-synthetic-media': String(synthetic)
      }
    });
    await refreshContentDialog(productionId, t('confirm.scene_asset_replaced_toast'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading').classList.remove('active');
  }
}

function provenanceFormData() {
  const sources = $$('[data-provenance-source]').map(item => ({
    id: item.dataset.id,
    url: item.querySelector('[data-field="url"]').value,
    title: item.querySelector('[data-field="title"]').value,
    publisher: item.querySelector('[data-field="publisher"]').value,
    sourceType: item.querySelector('[data-field="sourceType"]').value,
    status: item.querySelector('[data-field="status"]').value,
    notes: item.querySelector('[data-field="notes"]').value,
    publishedAt: item.dataset.publishedAt || null,
    accessedAt: item.dataset.accessedAt || null
  }));
  const claims = $$('[data-provenance-claim]').map(item => ({
    id: item.dataset.id,
    text: item.querySelector('[data-field="text"]').value,
    riskLevel: item.querySelector('[data-field="riskLevel"]').value,
    status: item.querySelector('[data-field="status"]').value,
    notes: item.querySelector('[data-field="notes"]').value,
    sourceIds: [...item.querySelectorAll('[data-claim-source]:checked')].map(input => input.dataset.claimSource)
  }));
  return {
    sources,
    claims,
    containsSyntheticMedia: $('#contains-synthetic-media')?.checked || false
  };
}

function clientId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid}`;
}

function currentSourceOptions() {
  return $$('[data-provenance-source]').map(item => ({
    id: item.dataset.id,
    title: item.querySelector('[data-field="title"]').value || item.querySelector('[data-field="url"]').value || 'New source'
  }));
}

async function persistProvenance(productionId, successMessage = null) {
  $('#loading').classList.add('active');
  try {
    const result = await api(`/api/content/${encodeURIComponent(productionId)}/provenance`, {
      method: 'PUT',
      body: JSON.stringify(provenanceFormData())
    });
    if (successMessage) {
      showToast(successMessage);
      $('#content-dialog').close();
      await openContent(productionId);
    }
    return result;
  } catch (error) {
    showToast(error.message, 'error');
    throw error;
  } finally {
    $('#loading').classList.remove('active');
  }
}

async function mutate(url, method, body, successMessage) {
  $('#loading').classList.add('active');
  try {
    const result = await api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    showToast(successMessage);
    await refreshDashboard(true);
    return result;
  } catch (error) {
    const failures = error.data?.quality?.blockingFailures;
    showToast(failures ? `${error.message}: ${failures.join(', ')}` : error.message, 'error');
    throw error;
  } finally {
    $('#loading').classList.remove('active');
  }
}

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]');
  if (nav) return switchView(nav.dataset.view);
  const go = event.target.closest('[data-go]');
  if (go) return switchView(go.dataset.go);
  if (event.target.closest('[data-close]')) return event.target.closest('dialog').close();
  const wizardBack = event.target.closest('[data-wizard-back]');
  if (wizardBack) return wizardShowStep(wizardBack.dataset.wizardBack);
  const wizardGoto = event.target.closest('[data-wizard-goto]');
  if (wizardGoto) return wizardShowStep(wizardGoto.dataset.wizardGoto);

  const open = event.target.closest('[data-open-content]');
  if (open) return openContent(open.dataset.openContent);

  const cancel = event.target.closest('[data-cancel-job]');
  if (cancel && confirm(t('confirm.cancel_job'))) {
    await mutate(`/api/jobs/${encodeURIComponent(cancel.dataset.cancelJob)}/cancel`, 'POST', {}, t('confirm.cancellation_requested_toast')).catch(() => {});
  }

  const idea = event.target.closest('[data-generate-idea]');
  if (idea) {
    await mutate(`/api/ideas/${encodeURIComponent(idea.dataset.generateIdea)}/generate`, 'POST', { length: 'medium' }, t('dialog.idea_queued_toast')).catch(() => {});
  }

  const resume = event.target.closest('[data-resume-job]');
  if (resume) {
    const jobId = resume.dataset.resumeJob;
    const select = $$('[data-resume-stage-for]').find(item => item.dataset.resumeStageFor === jobId);
    const stage = select?.value;
    if (confirm(t('confirm.resume_job', { stage: label(stage) }))) {
      await mutate(`/api/jobs/${encodeURIComponent(jobId)}/resume`, 'POST', { stage }, t('confirm.resumed_from_toast', { stage: label(stage) })).catch(() => {});
    }
  }

  const learning = event.target.closest('[data-learning-action]');
  if (learning) {
    const action = learning.dataset.learningAction;
    const id = learning.dataset.learningId;
    const message = action === 'approve'
      ? t('analytics.learning_approved_toast')
      : t('analytics.learning_rejected_toast');
    await mutate(`/api/learning/recommendations/${encodeURIComponent(id)}/${action}`, 'POST', {}, message).catch(() => {});
  }

  const refreshRetention = event.target.closest('#refresh-retention-button');
  if (refreshRetention?.dataset.videoId) {
    refreshRetention.disabled = true;
    try {
      await api(`/api/retention/${encodeURIComponent(refreshRetention.dataset.videoId)}/refresh`, {
        method: 'POST',
        body: JSON.stringify({ measurementWindow: refreshRetention.dataset.measurementWindow || 'rolling' })
      });
      showToast(t('analytics.retention_refreshed_toast'));
      await refreshDashboard(true);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      refreshRetention.disabled = false;
    }
  }

  const proposeShorts = event.target.closest('[data-propose-shorts]');
  if (proposeShorts) {
    const productionId = proposeShorts.dataset.proposeShorts;
    const replacing = Boolean(document.querySelector('[data-short-card]'));
    if (replacing && !confirm(t('confirm.replace_short_drafts'))) return;
    try {
      await api(`/api/content/${encodeURIComponent(productionId)}/shorts/propose`, {
        method: 'POST', body: JSON.stringify({ count: 3, replace: replacing })
      });
      await refreshContentDialog(productionId, t('confirm.shorts_created_toast'));
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const shortAction = event.target.closest('[data-short-save], [data-short-render], [data-short-approve]');
  if (shortAction) {
    const card = shortAction.closest('[data-short-card]');
    const productionId = $('#content-review-form')?.dataset.productionId;
    const clipId = card?.dataset.shortCard;
    if (!productionId || !clipId) return;
    try {
      const values = shortFormData(card);
      await api(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}`, {
        method: 'PATCH', body: JSON.stringify(values)
      });
      if (shortAction.matches('[data-short-save]')) {
        await refreshContentDialog(productionId, t('confirm.short_saved_toast'));
        return;
      }
      if (shortAction.matches('[data-short-render]')) {
        await api(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}/render`, {
          method: 'POST', body: '{}'
        });
        await refreshContentDialog(productionId, t('confirm.short_rendered_toast'));
        return;
      }
      if (!confirm(t('confirm.approve_short_evidence'))) return;
      await api(`/api/content/${encodeURIComponent(productionId)}/shorts/${encodeURIComponent(clipId)}/approve`, {
        method: 'POST', body: JSON.stringify({ ...values, confirmed: true })
      });
      await refreshContentDialog(productionId, t('confirm.short_approved_toast'));
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const sceneButton = event.target.closest('[data-scene-save], [data-scene-narration], [data-scene-regenerate], [data-scene-lock], [data-scene-move]');
  if (sceneButton) {
    const card = sceneButton.closest('[data-scene-card]');
    const productionId = $('#content-review-form')?.dataset.productionId;
    const sceneId = card?.dataset.sceneCard;
    if (!productionId || !sceneId) return;
    try {
      if (sceneButton.matches('[data-scene-lock]')) {
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}`, {
          method: 'PATCH', body: JSON.stringify({ locked: !card.classList.contains('locked') })
        });
        await refreshContentDialog(productionId, card.classList.contains('locked') ? t('confirm.scene_unlocked_toast') : t('confirm.scene_locked_toast'));
        return;
      }
      if (sceneButton.matches('[data-scene-move]')) {
        const cards = $$('[data-scene-card]');
        const index = cards.indexOf(card);
        const target = sceneButton.dataset.sceneMove === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= cards.length) return;
        const ids = cards.map(item => item.dataset.sceneCard);
        [ids[index], ids[target]] = [ids[target], ids[index]];
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/reorder`, {
          method: 'POST', body: JSON.stringify({ sceneIds: ids })
        });
        await refreshContentDialog(productionId, t('confirm.timeline_reordered_toast'));
        return;
      }
      await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}`, {
        method: 'PATCH', body: JSON.stringify(sceneFormData(card))
      });
      if (sceneButton.matches('[data-scene-save]')) {
        await refreshContentDialog(productionId, t('confirm.scene_saved_toast'));
        return;
      }
      if (sceneButton.matches('[data-scene-narration]')) {
        if (!confirm(t('confirm.regenerate_scene_narration'))) return;
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/narration`, {
          method: 'POST', body: JSON.stringify({ confirmCost: true })
        });
        await refreshContentDialog(productionId, t('confirm.scene_narration_regenerated_toast'));
        return;
      }
      const estimate = await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/estimate`);
      const message = estimate.paid
        ? t('confirm.regenerate_scene_paid', { provider: estimate.provider, seconds: estimate.generatedSeconds })
        : t('confirm.regenerate_scene_local');
      if (!confirm(message)) return;
      await api(`/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(sceneId)}/regenerate`, {
        method: 'POST', body: JSON.stringify({ confirmPaid: estimate.paid })
      });
      await refreshContentDialog(productionId, t('confirm.scene_regenerated_toast'));
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const silenceAction = event.target.closest('[data-intentional-silence], [data-require-narration]');
  if (silenceAction) {
    const productionId = $('#content-review-form')?.dataset.productionId;
    if (!productionId) return;
    const enabled = silenceAction.matches('[data-intentional-silence]');
    let reason = '';
    if (enabled) {
      reason = prompt(t('confirm.intentional_silence_reason_prompt')) || '';
      if (!reason) return;
      if (!confirm(t('confirm.confirm_intentional_silence'))) return;
    } else if (!confirm(t('confirm.require_narration_again'))) {
      return;
    }
    try {
      await api(`/api/content/${encodeURIComponent(productionId)}/narration/silence`, {
        method: 'POST', body: JSON.stringify({ enabled, confirmed: enabled, reason })
      });
      await refreshContentDialog(productionId, enabled ? t('confirm.silence_recorded_toast') : t('confirm.narration_required_toast'));
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  const rebuildScenes = event.target.closest('[data-rebuild-scenes]');
  if (rebuildScenes) {
    const productionId = rebuildScenes.dataset.rebuildScenes;
    if (confirm(t('confirm.rebuild_scenes'))) {
      try {
        await api(`/api/content/${encodeURIComponent(productionId)}/scenes/rebuild`, { method: 'POST', body: '{}' });
        await refreshContentDialog(productionId, t('confirm.video_rebuilt_toast'));
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
    return;
  }

  const addSource = event.target.closest('[data-add-provenance-source]');
  if (addSource) {
    const list = $('#provenance-sources');
    list.querySelector('.empty-inline')?.remove();
    list.insertAdjacentHTML('beforeend', renderSourceEditor({ id: clientId('source') }));
    return;
  }

  const addClaim = event.target.closest('[data-add-provenance-claim]');
  if (addClaim) {
    const list = $('#provenance-claims');
    list.querySelector('.empty-inline')?.remove();
    list.insertAdjacentHTML('beforeend', renderClaimEditor({ id: clientId('claim') }, currentSourceOptions()));
    return;
  }

  const removeProvenance = event.target.closest('[data-remove-provenance]');
  if (removeProvenance) {
    removeProvenance.closest('.provenance-item')?.remove();
    return;
  }

  const saveProvenance = event.target.closest('[data-save-provenance]');
  if (saveProvenance) {
    const productionId = $('#content-review-form')?.dataset.productionId;
    if (productionId) await persistProvenance(productionId, t('confirm.evidence_saved_toast')).catch(() => {});
    return;
  }

  const save = event.target.closest('[data-save-content]');
  if (save) {
    try {
      await persistProvenance(save.dataset.saveContent);
      await mutate(`/api/content/${encodeURIComponent(save.dataset.saveContent)}`, 'PATCH', contentFormData(), t('confirm.draft_saved_toast'));
    } catch (_error) { /* toast already shown */ }
  }

  const approve = event.target.closest('[data-approve-content]');
  if (approve) {
    try {
      await persistProvenance(approve.dataset.approveContent);
      await mutate(`/api/content/${encodeURIComponent(approve.dataset.approveContent)}/approve`, 'POST', contentFormData(), t('confirm.content_approved_toast'));
      $('#content-dialog').close();
    } catch (_error) { /* toast already shown */ }
  }

  const reject = event.target.closest('[data-reject-content]');
  if (reject) {
    const notes = prompt(t('confirm.reject_reason_prompt'), t('confirm.reject_reason_default'));
    if (notes !== null) {
      await mutate(`/api/content/${encodeURIComponent(reject.dataset.rejectContent)}/reject`, 'POST', { notes }, t('confirm.content_rejected_toast')).catch(() => {});
      $('#content-dialog').close();
    }
  }

  const retry = event.target.closest('[data-retry-content]');
  if (retry && confirm(t('confirm.retry_same_topic'))) {
    await mutate(`/api/content/${encodeURIComponent(retry.dataset.retryContent)}/retry`, 'POST', {}, t('confirm.regeneration_started_toast')).catch(() => {});
    $('#content-dialog').close();
  }
});

document.addEventListener('change', event => {
  if (event.target.matches('#retention-snapshot-select')) {
    ui.retentionSnapshotId = event.target.value;
    renderRetention(ui.state?.learning?.retention || {});
  }
  if (event.target.matches('[name="selectedTitleVariant"]')) {
    const title = event.target.selectedOptions[0]?.dataset.title;
    const input = $('#content-review-form [name="title"]');
    if (title && input) input.value = title;
  }
  if (event.target.matches('[data-scene-upload]')) {
    const file = event.target.files?.[0];
    const card = event.target.closest('[data-scene-card]');
    const productionId = $('#content-review-form')?.dataset.productionId;
    if (file && card && productionId) {
      uploadSceneAsset(productionId, card.dataset.sceneCard, file);
    }
  }
});

$('#language-select').value = getLanguage();
$('#language-select').addEventListener('change', event => {
  setLanguage(event.target.value);
  location.reload();
});

$('#generate-button').addEventListener('click', () => $('#generate-dialog').showModal());
$('#add-idea-button').addEventListener('click', () => $('#idea-dialog').showModal());
$('#refresh-button').addEventListener('click', () => refreshDashboard());
$('#pipeline-filter').addEventListener('change', () => renderPipeline(ui.state?.pipeline || []));

$('#run-readiness-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = t('readiness.running_checks');
  try {
    await mutate('/api/readiness/run', 'POST', {
      includePaidMedia: $('#paid-image-probe').checked,
      includePaidVideo: $('#paid-video-probe').checked
    }, t('readiness.run_completed_toast'));
    switchView('readiness');
  } catch (_error) { /* toast already shown */ }
  finally {
    button.disabled = false;
    button.textContent = t('readiness.run_check');
  }
});

$('#automation-toggle').addEventListener('click', async () => {
  const action = ui.state?.system.automationPaused ? 'resume' : 'pause';
  const toastKey = action === 'resume' ? 'system.automation_resumed_toast' : 'system.automation_paused_toast';
  await mutate(`/api/automation/${action}`, 'POST', {}, t(toastKey)).catch(() => {});
});

function strategyFormData(status = ui.state?.channelStrategy?.status || 'draft') {
  const form = $('#strategy-form');
  const values = Object.fromEntries(new FormData(form));
  return {
    ...values,
    contentPillars: values.contentPillars.split(',').map(value => value.trim()).filter(Boolean),
    cadencePerWeek: Number(values.cadencePerWeek),
    videosPerRun: Number(values.videosPerRun),
    status
  };
}

$('#strategy-form').addEventListener('submit', async event => {
  event.preventDefault();
  await mutate('/api/operator/strategy', 'PUT', strategyFormData(), t('operator.strategy_saved_toast')).catch(() => {});
});

$('#activate-operator-button').addEventListener('click', async () => {
  if (!$('#strategy-form').reportValidity()) return;
  await mutate('/api/operator/start', 'POST', strategyFormData('active'), t('operator.started_toast')).catch(() => {});
});

$('#pause-operator-button').addEventListener('click', async () => {
  await mutate('/api/operator/pause', 'POST', {}, t('operator.paused_toast')).catch(() => {});
});

$('#cancel-operator-run').addEventListener('click', async event => {
  const runId = event.currentTarget.dataset.runId;
  if (runId && confirm(t('operator.cancel_confirm'))) {
    await mutate(`/api/operator/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {}, t('operator.stop_requested_toast')).catch(() => {});
  }
});

$('#resume-operator-run').addEventListener('click', async event => {
  const runId = event.currentTarget.dataset.runId;
  if (runId && confirm(t('operator.resume_confirm'))) {
    await mutate(`/api/operator/runs/${encodeURIComponent(runId)}/resume`, 'POST', {}, t('operator.resumed_toast')).catch(() => {});
  }
});

$('#generate-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/generate', 'POST', { ...values, topic: values.topic.trim() || null }, t('dialog.generation_started_toast'));
    $('#generate-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#idea-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/api/ideas', 'POST', values, t('dialog.idea_added_toast'));
    $('#idea-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.bannedTopics = values.bannedTopics.split(',').map(value => value.trim()).filter(Boolean);
  try {
    await mutate('/api/profile', 'PUT', values, t('settings.channel_setup_saved_toast'));
    await mutate('/api/settings', 'PUT', {
      approval_required: $('#approval-required').checked,
      notification_enabled: $('#notifications-enabled').checked,
      channel_timezone: values.timezone,
      video_provider: values.videoProvider,
      video_generation_mode: values.videoGenerationMode,
      video_clip_duration: Number(values.videoClipDuration),
      video_max_generated_seconds: Number(values.videoMaxGeneratedSeconds)
    }, t('settings.operator_settings_saved_toast'));
  } catch (_error) { /* toast already shown */ }
});

$('#api-key-button').addEventListener('click', () => {
  if (requestApiKey() !== null) showToast(t('settings.dashboard_api_key_saved_toast'));
});

// Setup wizard — replaces `npm run credentials:setup` / `npm run walkthrough`
// for people running the packaged app, which has no terminal.
const WIZARD_STEPS = ['ai', 'video', 'youtube', 'summary'];
const WIZARD_TITLE_KEYS = { ai: 'wizard.ai_title', video: 'wizard.video_title', youtube: 'wizard.youtube_title', summary: 'wizard.summary_title' };
let wizardProviders = null;
let wizardYoutubePoll = null;

function wizardShowStep(step) {
  if (!WIZARD_STEPS.includes(step)) return;
  $$('.wizard-step').forEach(el => el.classList.remove('active'));
  $(`#wizard-step-${step}`).classList.add('active');
  $('#wizard-step-label').textContent = t('wizard.step_label', { n: WIZARD_STEPS.indexOf(step) + 1, total: WIZARD_STEPS.length });
  $('#wizard-step-title').textContent = t(WIZARD_TITLE_KEYS[step]);
  if (step !== 'youtube') clearInterval(wizardYoutubePoll);
  if (step === 'summary') wizardRenderSummary();
}

async function wizardLoadProviders() {
  if (wizardProviders) return wizardProviders;
  wizardProviders = await api('/api/setup/providers');
  $('#wizard-ai-provider').innerHTML = Object.entries(wizardProviders.aiProviders)
    .map(([id, guide]) => `<option value="${id}">${escapeHTML(guide.label)}</option>`).join('');
  $('#wizard-video-provider').innerHTML = Object.entries(wizardProviders.videoProviders)
    .map(([id, guide]) => `<option value="${id}">${escapeHTML(guide.label)}</option>`).join('');
  wizardUpdateAiModelOptions();
  wizardUpdateVideoFields();
  return wizardProviders;
}

function wizardUpdateAiModelOptions() {
  const guide = wizardProviders?.aiProviders[$('#wizard-ai-provider').value];
  if (!guide) return;
  $('#wizard-ai-model').innerHTML = (guide.models || []).map(m => `<option value="${escapeHTML(m)}">${escapeHTML(m)}</option>`).join('');
  if (guide.defaultModel) $('#wizard-ai-model').value = guide.defaultModel;
  $('#wizard-ai-instructions').innerHTML = t('wizard.get_key_from_html', { url: escapeHTML(guide.keyUrl), label: escapeHTML(guide.label), hint: escapeHTML(guide.keyHint || ''), covers: escapeHTML(guide.covers || '') });
}

function wizardUpdateVideoFields() {
  const providerId = $('#wizard-video-provider').value;
  const guide = wizardProviders?.videoProviders[providerId];
  const needsKey = providerId !== 'slideshow';
  $('#wizard-video-key-row').classList.toggle('hidden', !needsKey);
  if (needsKey && guide) {
    $('#wizard-video-key-label').textContent = guide.credentialName || t('wizard.api_key');
    $('#wizard-video-secret-row').classList.toggle('hidden', !guide.secretName);
    if (guide.secretName) $('#wizard-video-secret-label').textContent = guide.secretName;
  }
}

function wizardShowYoutubeConnected(youtube) {
  const html = `${youtube.channelThumbnail ? `<img src="${escapeHTML(youtube.channelThumbnail)}" alt="" style="width:28px;height:28px;border-radius:50%;vertical-align:middle;margin-right:8px;">` : ''}${escapeHTML(t('settings.connected_label'))} <strong>${escapeHTML(youtube.channelTitle || t('settings.your_channel'))}</strong>`;
  for (const id of ['#wizard-youtube-connected', '#wizard-summary-channel']) {
    const el = $(id);
    if (!el) continue;
    el.classList.remove('hidden');
    el.innerHTML = html;
  }
}

function wizardPollYoutube() {
  clearInterval(wizardYoutubePoll);
  wizardYoutubePoll = setInterval(async () => {
    try {
      const status = await api('/api/setup/status');
      if (status.youtube.connected) {
        clearInterval(wizardYoutubePoll);
        wizardShowYoutubeConnected(status.youtube);
        showToast(t('wizard.youtube_connected_toast', { channel: status.youtube.channelTitle }));
        setTimeout(() => wizardShowStep('summary'), 900);
      }
    } catch (_error) { /* keep polling — a transient network hiccup shouldn't stop it */ }
  }, 2000);
}

async function wizardRenderSummary() {
  const status = await api('/api/setup/status');
  const rows = [
    { ok: Boolean(status.aiProviderConfigured), label: t('wizard.cap_write_scripts') },
    { ok: Boolean(status.aiProviderConfigured), label: t('wizard.cap_generate_media') },
    { ok: status.ffmpegAvailable, label: t('wizard.cap_assemble_video') },
    { ok: Boolean(status.videoProviderConfigured) && status.videoProviderConfigured !== 'slideshow', label: t('wizard.cap_video_clips') },
    { ok: status.youtube.connected, label: t('wizard.cap_upload') }
  ];
  $('#wizard-capabilities').innerHTML = rows.map(row => `<div class="card">${row.ok ? '✓' : '✗'} ${escapeHTML(row.label)}</div>`).join('');
  if (status.youtube.connected) wizardShowYoutubeConnected(status.youtube);
}

$('#setup-wizard-button').addEventListener('click', async () => {
  await wizardLoadProviders();
  wizardShowStep('ai');
  $('#setup-wizard-dialog').showModal();
});

$('#setup-wizard-dialog').addEventListener('close', () => clearInterval(wizardYoutubePoll));

$('#wizard-ai-provider').addEventListener('change', wizardUpdateAiModelOptions);
$('#wizard-video-provider').addEventListener('change', wizardUpdateVideoFields);

$('#wizard-ai-test').addEventListener('click', async () => {
  const providerId = $('#wizard-ai-provider').value;
  const apiKey = $('#wizard-ai-key').value.trim();
  const model = $('#wizard-ai-model').value;
  if (!apiKey) return showToast(t('wizard.ai_key_required_toast'), 'error');
  const button = $('#wizard-ai-test');
  button.disabled = true;
  button.textContent = t('wizard.testing');
  try {
    await api('/api/setup/ai-provider', { method: 'POST', body: JSON.stringify({ providerId, apiKey, model }) });
    showToast(t('wizard.ai_connected_toast'));
    wizardShowStep('video');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = t('wizard.test_save');
  }
});

$('#wizard-video-next').addEventListener('click', async () => {
  const providerId = $('#wizard-video-provider').value;
  if (providerId === 'slideshow') return wizardShowStep('youtube');
  const apiKey = $('#wizard-video-key').value.trim();
  const secret = $('#wizard-video-secret').value.trim();
  if (!apiKey) return showToast(t('wizard.video_key_required_toast'), 'error');
  try {
    await api('/api/setup/video-provider', { method: 'POST', body: JSON.stringify({ providerId, apiKey, secret: secret || undefined }) });
    showToast(t('wizard.video_saved_toast'));
    wizardShowStep('youtube');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

$('#wizard-youtube-connect').addEventListener('click', async () => {
  const clientId = $('#wizard-yt-client-id').value.trim();
  const clientSecret = $('#wizard-yt-client-secret').value.trim();
  if (!clientId || !clientSecret) return showToast(t('wizard.client_credentials_required_toast'), 'error');
  const button = $('#wizard-youtube-connect');
  button.disabled = true;
  try {
    await api('/api/setup/youtube/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    const { url } = await api('/api/setup/youtube/oauth-url');
    window.open(url, '_blank');
    $('#wizard-youtube-status').textContent = t('settings.waiting_browser');
    wizardPollYoutube();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#wizard-activate').addEventListener('click', async () => {
  const button = $('#wizard-activate');
  button.disabled = true;
  button.textContent = t('wizard.activating');
  try {
    await api('/api/setup/complete', { method: 'POST' });
    showToast(t('wizard.setup_complete_toast'));
    $('#setup-wizard-dialog').close();
    await refreshDashboard(true);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = t('wizard.activate');
  }
});

// Channel setup — "Integrations" panel. Shows the guided wizard CTA when
// nothing is configured yet; once something is, shows the current values
// inline, editable in place, instead of dumping the user back into the
// multi-step wizard from scratch just to tweak one field.
async function renderIntegrationsPanel() {
  const panel = $('#integrations-panel');
  const [status] = await Promise.all([api('/api/setup/status'), wizardLoadProviders()]);
  const hasAnything = Boolean(status.aiProviderConfigured) || status.youtube.connected;

  panel.innerHTML = hasAnything ? integrationsConfiguredHTML(status) : integrationsEmptyHTML();

  if (!hasAnything) {
    $('#settings-start-wizard').addEventListener('click', () => $('#setup-wizard-button').click());
    return;
  }

  $('#settings-run-wizard').addEventListener('click', () => $('#setup-wizard-button').click());

  const aiSelect = $('#settings-ai-provider');
  aiSelect.innerHTML = Object.entries(wizardProviders.aiProviders)
    .map(([id, guide]) => `<option value="${id}" ${id === status.aiProviderConfigured ? 'selected' : ''}>${escapeHTML(guide.label)}</option>`).join('');
  const updateAiModels = () => {
    const guide = wizardProviders.aiProviders[aiSelect.value];
    $('#settings-ai-model').innerHTML = (guide.models || []).map(m => `<option value="${escapeHTML(m)}">${escapeHTML(m)}</option>`).join('');
    const current = aiSelect.value === status.aiProviderConfigured ? status.aiModelConfigured : null;
    $('#settings-ai-model').value = current || guide.defaultModel || '';
  };
  aiSelect.addEventListener('change', updateAiModels);
  updateAiModels();

  $('#settings-ai-save').addEventListener('click', async () => {
    const providerId = aiSelect.value;
    const apiKey = $('#settings-ai-key').value.trim();
    const model = $('#settings-ai-model').value;
    if (!apiKey && providerId !== status.aiProviderConfigured) {
      return showToast(t('settings.ai_key_required_toast'), 'error');
    }
    try {
      await api('/api/setup/ai-provider', { method: 'POST', body: JSON.stringify({ providerId, apiKey: apiKey || undefined, model }) });
      showToast(t('settings.ai_saved_toast'));
      renderIntegrationsPanel();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  const videoSelect = $('#settings-video-provider');
  const currentVideo = status.videoProviderConfigured || 'slideshow';
  videoSelect.innerHTML = Object.entries(wizardProviders.videoProviders)
    .map(([id, guide]) => `<option value="${id}" ${id === currentVideo ? 'selected' : ''}>${escapeHTML(guide.label)}</option>`).join('');
  const updateVideoFields = () => {
    const providerId = videoSelect.value;
    const guide = wizardProviders.videoProviders[providerId];
    const needsKey = providerId !== 'slideshow';
    $('#settings-video-key-row').classList.toggle('hidden', !needsKey);
    if (needsKey) {
      $('#settings-video-key-label').textContent = guide.credentialName || t('settings.api_key');
      $('#settings-video-secret-row').classList.toggle('hidden', !guide.secretName);
      if (guide.secretName) $('#settings-video-secret-label').textContent = guide.secretName;
    }
  };
  videoSelect.addEventListener('change', updateVideoFields);
  updateVideoFields();

  $('#settings-video-save').addEventListener('click', async () => {
    const providerId = videoSelect.value;
    const apiKey = $('#settings-video-key').value.trim();
    const secret = $('#settings-video-secret').value.trim();
    if (providerId !== 'slideshow' && !apiKey && providerId !== currentVideo) {
      return showToast(t('settings.video_key_required_toast'), 'error');
    }
    try {
      await api('/api/setup/video-provider', { method: 'POST', body: JSON.stringify({ providerId, apiKey: apiKey || undefined, secret: secret || undefined }) });
      showToast(t('settings.video_saved_toast'));
      renderIntegrationsPanel();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#settings-youtube-connect').addEventListener('click', async () => {
    const button = $('#settings-youtube-connect');
    button.disabled = true;
    try {
      if (!status.youtube.hasClientCredentials) {
        const clientId = $('#settings-yt-client-id').value.trim();
        const clientSecret = $('#settings-yt-client-secret').value.trim();
        if (!clientId || !clientSecret) {
          showToast(t('settings.client_credentials_required_toast'), 'error');
          return;
        }
        await api('/api/setup/youtube/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
      }
      const { url } = await api('/api/setup/youtube/oauth-url');
      window.open(url, '_blank');
      const statusEl = $('#settings-youtube-status');
      statusEl.classList.remove('hidden');
      statusEl.textContent = t('settings.waiting_browser');
      const poll = setInterval(async () => {
        try {
          const latest = await api('/api/setup/status');
          if (latest.youtube.connected) {
            clearInterval(poll);
            showToast(t('settings.youtube_connected_toast', { channel: latest.youtube.channelTitle }));
            renderIntegrationsPanel();
          }
        } catch (_error) { /* keep polling */ }
      }, 2000);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

function integrationsEmptyHTML() {
  return `
    <div class="panel-heading"><h2>${t('settings.integrations_title')}</h2></div>
    <p>${t('settings.not_finished')}</p>
    <button type="button" class="button primary" id="settings-start-wizard">${t('settings.start_wizard')}</button>
  `;
}

function integrationsConfiguredHTML(status) {
  const youtubeConnected = status.youtube.connected;
  return `
    <div class="panel-heading"><h2>${t('settings.integrations_title')}</h2><button type="button" class="text-button" id="settings-run-wizard">${t('settings.run_guided_setup')}</button></div>
    <div class="integrations-grid">
      <div class="integration-row">
        <div class="integration-row-header"><span>${t('settings.ai_provider')}</span>${status.aiProviderConfigured ? `<span class="status ok">${t('settings.connected')}</span>` : `<span class="status">${t('settings.not_configured')}</span>`}</div>
        <div class="form-grid two">
          <label><span>${t('settings.provider')}</span><select id="settings-ai-provider"></select></label>
          <label><span>${t('settings.model')}</span><select id="settings-ai-model"></select></label>
        </div>
        <label><span>${t('settings.api_key')}</span><input id="settings-ai-key" type="password" autocomplete="off" placeholder="${status.aiProviderConfigured ? escapeHTML(t('settings.api_key_placeholder_existing')) : escapeHTML(t('settings.api_key_placeholder_new'))}"></label>
        <div class="form-actions"><button type="button" class="button secondary" id="settings-ai-save">${t('settings.save_ai_provider')}</button></div>
      </div>
      <div class="integration-row">
        <div class="integration-row-header"><span>${t('settings.video_provider_row')}</span>${status.videoProviderConfigured && status.videoProviderConfigured !== 'slideshow' ? `<span class="status ok">${t('settings.connected')}</span>` : `<span class="status">${t('settings.local_slideshow')}</span>`}</div>
        <div class="form-grid two">
          <label><span>${t('settings.provider')}</span><select id="settings-video-provider"></select></label>
        </div>
        <div id="settings-video-key-row" class="form-grid two hidden">
          <label><span id="settings-video-key-label">${t('settings.api_key')}</span><input id="settings-video-key" type="password" autocomplete="off" placeholder="${escapeHTML(t('settings.api_key_placeholder_existing'))}"></label>
          <label id="settings-video-secret-row" class="hidden"><span id="settings-video-secret-label">${t('settings.secret')}</span><input id="settings-video-secret" type="password" autocomplete="off"></label>
        </div>
        <div class="form-actions"><button type="button" class="button secondary" id="settings-video-save">${t('settings.save_video_provider')}</button></div>
      </div>
      <div class="integration-row">
        <div class="integration-row-header"><span>${t('settings.youtube_channel')}</span>${youtubeConnected ? `<span class="status ok">${t('settings.connected')}</span>` : `<span class="status">${t('settings.not_connected')}</span>`}</div>
        ${youtubeConnected ? `<div class="callout">${status.youtube.channelThumbnail ? `<img src="${escapeHTML(status.youtube.channelThumbnail)}" alt="" style="width:28px;height:28px;border-radius:50%;vertical-align:middle;margin-right:8px;">` : ''}${escapeHTML(t('settings.connected_label'))} <strong>${escapeHTML(status.youtube.channelTitle || t('settings.your_channel'))}</strong></div>` : ''}
        ${status.youtube.hasClientCredentials ? '' : `
        <div class="form-grid two">
          <label><span>${t('settings.client_id')}</span><input id="settings-yt-client-id" autocomplete="off" placeholder="xxxx.apps.googleusercontent.com"></label>
          <label><span>${t('settings.client_secret')}</span><input id="settings-yt-client-secret" type="password" autocomplete="off"></label>
        </div>`}
        <div class="form-actions"><button type="button" class="button secondary" id="settings-youtube-connect">${youtubeConnected ? t('settings.change_channel') : t('settings.connect_youtube')}</button></div>
        <p id="settings-youtube-status" class="callout hidden"></p>
      </div>
    </div>
  `;
}

const initialView = location.hash.slice(1);
if (['overview', 'operator', 'pipeline', 'calendar', 'analytics', 'readiness', 'settings'].includes(initialView)) switchView(initialView);
refreshDashboard();
setInterval(() => refreshDashboard(true), 8000);
