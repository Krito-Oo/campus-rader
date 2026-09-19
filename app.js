/**
 * 校园机会雷达 - 主逻辑
 * 功能：浏览/搜索/筛选、今日提醒与截止倒计时、收藏（localStorage）、
 *       学生自主发布（localStorage）、信息风险提示、关联通知合并展示
 */
(function () {
  'use strict';

  var NOW = window.TIME_ANCHOR; // 以考核当日 2026-09-19 14:00 为时间锚点
  var FAV_KEY = 'campus_radar_favs_v1';
  var POST_KEY = 'campus_radar_posts_v1';

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function parseTime(t) { return t ? new Date(t + ':00+08:00') : null; }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDateTime(d) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function loadJSON(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(okMsg); }
      catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else {
      fallback();
    }
  }

  // ---------- 数据 ----------
  var userPosts = loadJSON(POST_KEY, []);
  var favs = loadJSON(FAV_KEY, []);
  var allItems = window.ACTIVITIES.concat(userPosts);

  // 类型 → 配色 class（卡片顶部色条 / 时间线圆点共用）
  var TYPE_CLS = {
    '竞赛': 'tc-comp', '讲座分享': 'tc-talk', '招募': 'tc-recruit',
    '学习成长': 'tc-study', '志愿服务': 'tc-vol', '校园活动': 'tc-act',
    '学生发起': 'tc-stu', '重要通知': 'tc-notice', '学习资料': 'tc-res'
  };
  function typeCls(item) { return TYPE_CLS[item.type] || 'tc-res'; }

  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var currentView = 'cards'; // 'cards' | 'timeline'

  // ---------- 状态计算 ----------
  function getState(item) {
    var start = parseTime(item.timeStart);
    var end = parseTime(item.timeEnd);
    var deadline = parseTime(item.deadline);
    var st = {
      isToday: !!(start && sameDay(start, NOW)),
      ended: false,
      deadlinePassed: false,
      hoursToDeadline: null,
      canJoin: true
    };
    if (end && end < NOW) st.ended = true;
    else if (start && !end && start < NOW && sameDay(start, NOW)) st.ended = false; // 当天未定结束时间的，不算结束
    else if (start && !end && start < NOW) st.ended = true;
    if (deadline) {
      st.hoursToDeadline = (deadline - NOW) / 3600000;
      if (st.hoursToDeadline < 0) st.deadlinePassed = true;
    }
    if (st.ended || st.deadlinePassed) st.canJoin = false;
    if (item.id === 19) st.canJoin = true; // 路演可候补入场
    return st;
  }

  function deadlineChip(item, st) {
    if (!item.deadline) {
      if (item.deadlineText) return '<span class="deadline-chip">' + esc(item.deadlineText) + '</span>';
      return '';
    }
    if (st.deadlinePassed) return '<span class="deadline-chip done">报名已截止</span>';
    var h = st.hoursToDeadline;
    var label;
    if (h <= 24) label = '⏰ ' + Math.max(1, Math.round(h)) + ' 小时后截止';
    else if (h <= 72) label = '⏰ ' + Math.round(h / 24) + ' 天后截止';
    else label = '⏰ ' + fmtDateTime(parseTime(item.deadline)) + ' 截止';
    var cls = h <= 24 ? 'urgent' : (h <= 72 ? 'soon' : '');
    return '<span class="deadline-chip ' + cls + '">' + label + '</span>';
  }

  // ---------- 筛选状态 ----------
  var filters = { keyword: '', type: '全部', freshmanOnly: false, openOnly: false, hideRisky: false };

  function matchFilters(item) {
    var st = getState(item);
    if (filters.type !== '全部' && item.type !== filters.type) return false;
    if (filters.freshmanOnly && !item.freshman) return false;
    if (filters.openOnly && !st.canJoin) return false;
    if (filters.hideRisky && item.risk) return false;
    if (filters.keyword) {
      var kw = filters.keyword.toLowerCase();
      var hay = [item.title, item.desc, item.location, item.audience, item.type,
        (item.tags || []).join(' '), item.sourceLabel].join(' ').toLowerCase();
      if (hay.indexOf(kw) === -1) return false;
    }
    return true;
  }

  // 排序：今天进行 > 未截止按截止时间近远 > 无截止 > 已结束/已截止
  function sortItems(list) {
    return list.slice().sort(function (a, b) {
      var sa = getState(a), sb = getState(b);
      function rank(it, st) {
        if (st.isToday && !st.ended) return 0;
        if (st.ended) return 4;
        if (st.deadlinePassed) return 3;
        if (st.hoursToDeadline != null) return 1;
        return 2;
      }
      var ra = rank(a, sa), rb = rank(b, sb);
      if (ra !== rb) return ra - rb;
      if (sa.hoursToDeadline != null && sb.hoursToDeadline != null) return sa.hoursToDeadline - sb.hoursToDeadline;
      if (sa.hoursToDeadline != null) return -1;
      if (sb.hoursToDeadline != null) return 1;
      return a.id - b.id;
    });
  }

  // ---------- 渲染：提醒条 ----------
  function renderAlerts() {
    var todayItems = [];
    var urgentItems = [];
    allItems.forEach(function (item) {
      var st = getState(item);
      if (item.risk) return; // 风险信息不进提醒
      if (st.isToday && !st.ended) todayItems.push(item);
      if (st.hoursToDeadline != null && st.hoursToDeadline >= 0 && st.hoursToDeadline <= 48) urgentItems.push(item);
    });
    todayItems.sort(function (a, b) { return (parseTime(a.timeStart) || 0) - (parseTime(b.timeStart) || 0); });
    urgentItems.sort(function (a, b) { return getState(a).hoursToDeadline - getState(b).hoursToDeadline; });

    var html = '';
    if (todayItems.length) {
      html += '<div class="alert-card today"><h3>📅 今天进行（' + todayItems.length + '）</h3>' +
        todayItems.map(function (it) {
          var start = parseTime(it.timeStart);
          return '<div class="alert-item" data-id="' + it.id + '">' +
            '<span class="alert-item-name">' + esc(it.title) + '</span>' +
            '<span class="alert-item-tag today-tag">' + (start ? pad(start.getHours()) + ':' + pad(start.getMinutes()) : '今天') + '</span></div>';
        }).join('') + '</div>';
    }
    if (urgentItems.length) {
      html += '<div class="alert-card urgent"><h3>⏰ 48 小时内截止报名（' + urgentItems.length + '）</h3>' +
        urgentItems.map(function (it) {
          var h = getState(it).hoursToDeadline;
          var tag = h <= 24 ? Math.max(1, Math.round(h)) + ' 小时后' : Math.round(h / 24) + ' 天后';
          return '<div class="alert-item" data-id="' + it.id + '">' +
            '<span class="alert-item-name">' + esc(it.title) + '</span>' +
            '<span class="alert-item-tag">' + tag + '</span></div>';
        }).join('') + '</div>';
    }
    $('alertStrip').innerHTML = html;
  }

  // ---------- 渲染：分类 chips ----------
  function renderChips() {
    var types = ['全部'].concat(window.ACTIVITY_TYPES);
    $('typeChips').innerHTML = types.map(function (t) {
      return '<button class="chip' + (filters.type === t ? ' active' : '') + '" data-type="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
  }

  // ---------- 渲染：卡片 ----------
  function renderCards() {
    var list = sortItems(allItems.filter(matchFilters));
    var total = allItems.length;
    $('resultMeta').textContent = '共 ' + list.length + ' 条 / 全部 ' + total + ' 条信息（含 ' + userPosts.length + ' 条同学发布）';
    $('emptyState').hidden = list.length > 0;

    $('cardGrid').innerHTML = list.map(function (item) {
      var st = getState(item);
      var badges = ['<span class="badge badge-type">' + esc(item.type) + '</span>'];
      badges.push('<span class="badge badge-source-' + item.source + '">' + esc(item.sourceLabel) + '</span>');
      if (st.isToday && !st.ended) badges.push('<span class="badge badge-today">今天进行</span>');
      if (st.ended) badges.push('<span class="badge badge-ended">已结束</span>');
      if (item.updates && item.updates.length) badges.push('<span class="badge badge-update">🆕 有更新</span>');
      if (item.risk) badges.push('<span class="badge badge-risk">⚠️ ' + (item.risk.level === 'high' ? '高风险' : '待核实') + '</span>');
      if (item.pending) badges.push('<span class="badge badge-update">待核实</span>');

      var meta = '';
      if (item.timeText) meta += '<div class="meta-line"><span class="meta-icon">🕐</span><span>' + esc(item.timeText) + '</span></div>';
      if (item.location) meta += '<div class="meta-line"><span class="meta-icon">📍</span><span>' + esc(item.location) + '</span></div>';
      if (item.audience) meta += '<div class="meta-line"><span class="meta-icon">👥</span><span>' + esc(item.audience) + '</span></div>';

      var starred = favs.indexOf(item.id) !== -1;
      var cardCls = 'card' + (st.ended ? ' is-ended' : '') + (item.risk ? ' is-risky' : '');

      return '<article class="' + cardCls + ' ' + typeCls(item) + '" data-id="' + item.id + '">' +
        '<div class="card-top"><div class="card-badges">' + badges.join('') + '</div>' +
        '<button class="star-btn' + (starred ? ' starred' : '') + '" data-star="' + item.id + '" title="' + (starred ? '取消收藏' : '收藏 / 想参加') + '">' + (starred ? '★' : '☆') + '</button></div>' +
        '<h3 class="card-title">' + esc(item.title) + '</h3>' +
        '<p class="card-desc">' + esc(item.desc) + '</p>' +
        '<div class="card-meta">' + meta + '</div>' +
        '<div class="card-foot">' + deadlineChip(item, st) +
        (item.freshman ? '<span class="freshman-tag">🌱 新生友好</span>' : '<span></span>') + '</div>' +
        '</article>';
    }).join('');
  }

  // ---------- 渲染：时间线 ----------
  function renderTimeline() {
    var list = allItems.filter(matchFilters);
    $('resultMeta').textContent = '共 ' + list.length + ' 条 / 全部 ' + allItems.length + ' 条信息（含 ' + userPosts.length + ' 条同学发布）';
    $('emptyState').hidden = list.length > 0;

    var groups = {};
    var order = [];
    list.forEach(function (item) {
      var t = parseTime(item.timeStart) || parseTime(item.deadline);
      var key = t ? (t.getFullYear() + '-' + t.getMonth() + '-' + t.getDate()) : 'none';
      if (!groups[key]) { groups[key] = { date: t, items: [] }; order.push(key); }
      groups[key].items.push(item);
    });
    order.sort(function (a, b) {
      if (a === 'none') return 1;
      if (b === 'none') return -1;
      return groups[a].date - groups[b].date;
    });

    $('timelineView').innerHTML = order.map(function (key) {
      var g = groups[key];
      var head;
      if (key === 'none') {
        head = '🗂 时间待定';
      } else {
        var d = g.date;
        var label = sameDay(d, NOW) ? '今天' :
          (sameDay(d, new Date(NOW.getTime() + 86400000)) ? '明天' : WEEKDAYS[d.getDay()]);
        head = '<span class="tl-label">' + label + '</span>' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
      }
      var rows = g.items.sort(function (a, b) {
        var ta = parseTime(a.timeStart) || parseTime(a.deadline) || 0;
        var tb = parseTime(b.timeStart) || parseTime(b.deadline) || 0;
        return ta - tb;
      }).map(function (item) {
        var st = getState(item);
        var t = parseTime(item.timeStart);
        var timeStr = t ? pad(t.getHours()) + ':' + pad(t.getMinutes()) : '—';
        var starred = favs.indexOf(item.id) !== -1;
        var rowCls = 'tl-row' + (st.ended ? ' is-ended' : '') + (item.risk ? ' is-risky' : '');
        return '<div class="' + rowCls + '" data-id="' + item.id + '">' +
          '<span class="tl-time">' + timeStr + '</span>' +
          '<span class="tl-dot ' + typeCls(item) + '"></span>' +
          '<span class="tl-title">' + esc(item.title) +
            (st.isToday && !st.ended ? ' <span class="badge badge-today">今天</span>' : '') +
            (st.ended ? ' <span class="badge badge-ended">已结束</span>' : '') +
            (item.updates && item.updates.length ? ' <span class="badge badge-update">🆕 有更新</span>' : '') +
            (item.risk ? ' <span class="badge badge-risk">⚠️ ' + (item.risk.level === 'high' ? '高风险' : '待核实') + '</span>' : '') +
          '</span>' +
          '<span class="tl-right">' + deadlineChip(item, st) +
          '<button class="star-btn' + (starred ? ' starred' : '') + '" data-star="' + item.id + '" title="' + (starred ? '取消收藏' : '收藏 / 想参加') + '">' + (starred ? '★' : '☆') + '</button></span>' +
          '</div>';
      }).join('');
      var groupCls = 'tl-group' + (key !== 'none' && sameDay(g.date, NOW) ? ' tl-today' : '');
      return '<div class="' + groupCls + '"><div class="tl-date">' + head + '</div>' + rows + '</div>';
    }).join('');
  }

  // ---------- 主视图调度 ----------
  function renderMain() {
    if (currentView === 'timeline') {
      $('cardGrid').hidden = true;
      $('timelineView').hidden = false;
      renderTimeline();
    } else {
      $('cardGrid').hidden = false;
      $('timelineView').hidden = true;
      renderCards();
    }
  }

  // ---------- 渲染：收藏 ----------
  function renderFavs() {
    $('favCount').textContent = favs.length;
    var list = favs.map(function (id) {
      return allItems.find(function (it) { return it.id === id; });
    }).filter(Boolean);
    list = sortItems(list);
    if (!list.length) {
      $('favList').innerHTML = '<div class="fav-empty">还没有收藏，点击卡片上的 ☆ 收藏感兴趣的活动<br><br><button class="btn btn-primary btn-sm" id="favBrowse">去逛逛 →</button></div>';
      return;
    }
    $('favList').innerHTML = list.map(function (item) {
      var st = getState(item);
      return '<div class="fav-item" data-id="' + item.id + '">' +
        '<h4>' + esc(item.title) + '</h4>' +
        '<div class="fav-meta"><span>' + esc(item.timeText || item.deadlineText || '') + '</span>' +
        '<span>' + deadlineChip(item, st) + '</span></div></div>';
    }).join('');
  }

  // ---------- 详情 ----------
  function openDetail(id) {
    var item = allItems.find(function (it) { return it.id === id; });
    if (!item) return;
    var st = getState(item);
    var html = '<div class="detail-head"><div class="card-badges">' +
      '<span class="badge badge-type">' + esc(item.type) + '</span>' +
      '<span class="badge badge-source-' + item.source + '">' + esc(item.sourceLabel) + '</span>' +
      (st.isToday && !st.ended ? '<span class="badge badge-today">今天进行</span>' : '') +
      (st.ended ? '<span class="badge badge-ended">已结束</span>' : '') +
      '</div><h2>' + esc(item.title) + '</h2></div>';

    html += '<div class="detail-section"><dl class="detail-kv">';
    if (item.timeText) html += '<dt>时间</dt><dd>' + esc(item.timeText) + '</dd>';
    if (item.location) html += '<dt>地点</dt><dd>' + esc(item.location) + '</dd>';
    if (item.audience) html += '<dt>面向对象</dt><dd>' + esc(item.audience) + '</dd>';
    if (item.deadlineText) html += '<dt>报名</dt><dd>' + esc(item.deadlineText) + '</dd>';
    if (item.tags && item.tags.length) html += '<dt>标签</dt><dd>' + item.tags.map(esc).join(' · ') + '</dd>';
    html += '</dl></div>';

    html += '<div class="detail-section"><h3>详细信息</h3><p>' + esc(item.desc) + '</p></div>';

    // 风险提示（核心创新点之一）
    if (item.risk) {
      html += '<div class="risk-box"><h4>⚠️ ' + esc(item.risk.title) + '</h4><ul>' +
        item.risk.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') +
        '</ul></div>';
    }

    // 更新与关联
    if (item.updates && item.updates.length) {
      item.updates.forEach(function (u) {
        html += '<div class="notice-box update-box">📢 ' + esc(u.note) +
          ' <a data-goto="' + u.fromId + '">查看原始通知 →</a></div>';
      });
    }
    if (item.relatesTo) {
      var target = allItems.find(function (it) { return it.id === item.relatesTo; });
      if (target) {
        html += '<div class="notice-box update-box">🔗 本条是对「<a data-goto="' + target.id + '">' + esc(target.title) + '</a>」的补充/更新，请以本条内容为最新信息。</div>';
      }
    }
    // 不确定信息提示
    (item.notices || []).forEach(function (n) {
      html += '<div class="notice-box">💡 ' + esc(n) + '</div>';
    });
    if (item.pending) {
      html += '<div class="notice-box update-box">📝 本条由同学自主发布，内容未经平台核实，参与前请自行判断。</div>';
    }

    var starred = favs.indexOf(item.id) !== -1;
    html += '<div class="detail-actions">' +
      '<button class="btn btn-primary" data-star="' + item.id + '">' + (starred ? '★ 已收藏，点击取消' : '☆ 收藏 / 想参加') + '</button>' +
      '<button class="btn btn-ghost" id="detailBack">返回列表</button></div>';

    $('detailBody').innerHTML = html;
    $('detailMask').hidden = false;

    var back = $('detailBack');
    if (back) back.onclick = closeDetail;
  }
  function closeDetail() { $('detailMask').hidden = true; }

  // ---------- 收藏操作 ----------
  function toggleFav(id) {
    var i = favs.indexOf(id);
    if (i === -1) { favs.push(id); toast('已收藏，可在右上角「我的收藏」查看'); }
    else { favs.splice(i, 1); toast('已取消收藏'); }
    saveJSON(FAV_KEY, favs);
    renderFavs();
    renderMain();
    if (!$('detailMask').hidden) openDetail(id);
  }

  // ---------- 发布 ----------
  function openPublish() { $('publishMask').hidden = false; }
  function closePublish() { $('publishMask').hidden = true; }

  function handlePublish(e) {
    e.preventDefault();
    var fd = new FormData(e.target);
    var post = {
      id: Date.now(),
      title: String(fd.get('title')).trim(),
      type: String(fd.get('type')),
      source: 'student',
      sourceLabel: '学生发布',
      timeText: String(fd.get('timeText')).trim(),
      timeStart: null,
      timeEnd: null,
      deadline: null,
      deadlineText: String(fd.get('deadlineText') || '').trim(),
      location: String(fd.get('location')).trim(),
      audience: String(fd.get('audience')).trim(),
      desc: String(fd.get('desc')).trim(),
      tags: [],
      freshman: false,
      updates: [],
      notices: [],
      risk: null,
      pending: true
    };
    if (!post.title || !post.desc || !post.timeText) { toast('请填写完整的标题、时间和介绍'); return; }
    userPosts.push(post);
    saveJSON(POST_KEY, userPosts);
    allItems = window.ACTIVITIES.concat(userPosts);
    e.target.reset();
    closePublish();
    renderAlerts(); renderMain(); renderFavs();
    toast('发布成功，已进入活动列表（标记为待核实）');
    openDetail(post.id);
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('searchInput').addEventListener('input', function () {
      filters.keyword = this.value.trim();
      renderMain();
    });
    $('typeChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      filters.type = chip.dataset.type;
      renderChips();
      renderMain();
    });
    $('freshmanOnly').addEventListener('change', function () { filters.freshmanOnly = this.checked; renderMain(); });
    $('openOnly').addEventListener('change', function () { filters.openOnly = this.checked; renderMain(); });
    $('hideRisky').addEventListener('change', function () { filters.hideRisky = this.checked; renderMain(); });

    // 视图切换
    document.querySelectorAll('.vs-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentView = btn.dataset.view;
        document.querySelectorAll('.vs-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
        renderMain();
      });
    });

    // 复制我的日程
    $('copyAgenda').addEventListener('click', function () {
      var list = favs.map(function (id) {
        return allItems.find(function (it) { return it.id === id; });
      }).filter(Boolean);
      if (!list.length) { toast('先收藏几个活动，再来复制日程吧'); return; }
      list.sort(function (a, b) {
        var ta = parseTime(a.timeStart) || parseTime(a.deadline) || new Date(8640000000000000);
        var tb = parseTime(b.timeStart) || parseTime(b.deadline) || new Date(8640000000000000);
        return ta - tb;
      });
      var lines = list.map(function (item) {
        var t = parseTime(item.timeStart);
        var when = t ? fmtDateTime(t) : (item.timeText || '时间待定');
        return '· ' + when + '  ' + item.title + (item.location ? '（' + item.location + '）' : '');
      });
      copyText('📅 我的校园日程（来自校园机会雷达）\n' + lines.join('\n'), '日程已复制，可以粘贴到备忘录/日历');
    });

    document.body.addEventListener('click', function (e) {
      var star = e.target.closest('[data-star]');
      if (star) { e.stopPropagation(); toggleFav(Number(star.dataset.star)); return; }
      var gotoLink = e.target.closest('[data-goto]');
      if (gotoLink) { openDetail(Number(gotoLink.dataset.goto)); return; }
      if (e.target.closest('#favBrowse')) {
        $('favDrawer').hidden = true; $('favMask').hidden = true;
        return;
      }
      var card = e.target.closest('.card, .fav-item, .alert-item, .tl-row');
      if (card) { closeDetail(); openDetail(Number(card.dataset.id)); }
    });

    // Esc 关闭所有浮层
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      closeDetail();
      closePublish();
      $('favDrawer').hidden = true;
      $('favMask').hidden = true;
    });

    // 回到顶部
    var backTop = $('backTop');
    window.addEventListener('scroll', function () {
      backTop.hidden = window.scrollY < 400;
    }, { passive: true });
    backTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // 发布内容风险关键词自检（把「信息质量」思路延伸到发布端）
    var RISK_WORDS = ['加微信', '微信', '日结', '兼职', '押金', '缴费', '刷单', '返利', '代购', '私信'];
    $('publishForm').addEventListener('input', function () {
      var els = $('publishForm').elements;
      var text = String(els.namedItem('title').value) + ' ' + String(els.namedItem('desc').value);
      var hit = RISK_WORDS.some(function (w) { return text.indexOf(w) !== -1; });
      $('riskWarn').hidden = !hit;
    });

    $('detailClose').addEventListener('click', closeDetail);
    $('detailMask').addEventListener('click', function (e) { if (e.target === this) closeDetail(); });

    $('publishBtn').addEventListener('click', openPublish);
    $('publishClose').addEventListener('click', closePublish);
    $('publishMask').addEventListener('click', function (e) { if (e.target === this) closePublish(); });
    $('publishForm').addEventListener('submit', handlePublish);

    $('favToggle').addEventListener('click', function () { $('favDrawer').hidden = false; $('favMask').hidden = false; });
    $('favClose').addEventListener('click', function () { $('favDrawer').hidden = true; $('favMask').hidden = true; });
    $('favMask').addEventListener('click', function () { $('favDrawer').hidden = true; $('favMask').hidden = true; });
  }

  // ---------- 初始化 ----------
  function init() {
    $('dateBadge').textContent = '📆 ' + (NOW.getMonth() + 1) + '月' + NOW.getDate() + '日 周六 · 校园信息一览';
    renderChips();
    renderAlerts();
    renderMain();
    renderFavs();
    bindEvents();
  }

  init();
})();
