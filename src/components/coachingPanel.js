/**
 * coachingPanel.js — the Coaching page (rewritten 2026-10).
 *
 * Organised around "am I improving, game to game?", Solo/Duo only:
 *
 *   1. Rank header     rank + LP and W-L over the last 10 games
 *   2. Last game       one game vs. your previous 20, with ‹ › to step back
 *   3. Habit board     one ticket per habit in Slipping / Needs work /
 *                      Improving / On track (worst to best), moved by your last
 *                      10 games vs. the 10 before; click one for its detail (#61)
 *   4. Trends          each Analytics area, last 10 vs. the 10 before
 *   5. Details         outcome evidence (collapsed)
 *
 * Data: the same rows the Analytics page uses (window.matchesData, remakes
 * excluded), and every number comes from the Analytics engine via
 * coachingProgress.js — so this page can never disagree with the cards.
 *
 * Exposes: window.renderCoachingPanel()
 */

(function () {
    'use strict';

    const { getLpReadings } = require('../services/matchService');
    const { loadConfig, updateConfig } = require('../services/config');
    const Engine   = require('./coachingEngine');
    const Progress = require('./coachingProgress');
    const Board    = require('./coachingBoard');
    const { ROLE_NAMES } = require('./roleRanks');
    const { escapeHtml, formatInt } = require('./dom');

    const fmt = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(v))
        ? '—' : Number(v).toFixed(dp);
    const pct = v => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Math.round(v) + '%';
    const signed = v => (v > 0 ? '+' : '') + Math.round(v);
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';

    // Page state survives re-renders so ‹ › and "Details" don't reset.
    const state = { games: [], index: null, lastCount: 0, detailsOpen: false, board: null, moves: {}, openTicket: null };

    window.coachingToggleDetails = function () {
        state.detailsOpen = !state.detailsOpen;
        const el  = document.getElementById('coachDetailsBody');
        const btn = document.getElementById('coachDetailsToggle');
        if (el)  el.classList.toggle('collapsed', !state.detailsOpen);
        if (btn) btn.textContent = state.detailsOpen ? 'Hide' : 'Show';
    };

    window.coachingStep = function (delta) {
        if (!state.games.length) return;
        state.index = Math.max(0, Math.min(state.games.length - 1, state.index + delta));
        const el = document.getElementById('coachReport');
        if (el) el.outerHTML = renderReport();
    };

    window.coachingOpenArea = function (tab) {
        if (typeof window.switchTopTab === 'function') window.switchTopTab('analytics');
        const btn = document.querySelector(`.analytical-tab[data-tab="${CSS.escape(tab)}"]`);
        if (btn) btn.click();
        // Pages scroll in #pageScroll, not the window (#80)
        document.getElementById('pageScroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // ── Helpers ──────────────────────────────────────────────────────────────
    function timeAgo(t) {
        const s = (Date.now() - t) / 1000;
        if (s < 3600)   return `${Math.max(1, Math.round(s / 60))} min ago`;
        if (s < 86400)  return `${Math.round(s / 3600)} h ago`;
        const d = Math.round(s / 86400);
        if (d < 30)     return `${d} day${d === 1 ? '' : 's'} ago`;
        return new Date(t).toLocaleDateString();
    }

    function lpText(v) {
        if (v === null || v === undefined || Number.isNaN(Number(v))) return '';
        return `${v > 0 ? '+' : ''}${Math.round(v)} LP`;
    }

    function sparkline(values) {
        const pts = values.map((v, i) => [i, v]).filter(p => p[1] !== null);
        if (pts.length < 2) return '<div class="coach-spark coach-spark--empty"></div>';
        const W = 160, H = 36, P = 3;
        const ys = pts.map(p => p[1]);
        let lo = Math.min(...ys), hi = Math.max(...ys);
        if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
        const x = i => P + (i / (values.length - 1)) * (W - 2 * P);
        const y = v => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
        const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
        // Neutral colour on purpose: the line covers ~30 games while the
        // Improving/Slipping label compares 10 vs 10. Two judgements that can
        // disagree just confuse — the label is the verdict, the line is shape.
        const last = pts[pts.length - 1][1];
        const [lx, ly] = [x(pts[pts.length - 1][0]), y(last)];
        return `<svg class="coach-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
                  <path d="${d}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.6"/></svg>`;
    }

    // ── 1. Rank header ───────────────────────────────────────────────────────
    function renderHeader(games, reading, roleLabel) {
        const h = Progress.rankHeader(games, window.lpDeltas || {});
        const tier = reading && reading.tier ? String(reading.tier).toLowerCase() : null;
        const rankLine = reading
            ? `${cap(reading.tier)} ${['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(String(reading.tier).toUpperCase()) ? '' : escapeHtml(reading.rank || '')} · ${reading.lp} LP`
            : 'Solo/Duo';
        const lp = h.lpChange !== null
            ? `<span class="${h.lpChange >= 0 ? 'good' : 'bad'}">${lpText(h.lpChange)}</span>${h.lpTracked < h.games ? ` <span class="coach-dim">(LP known for ${h.lpTracked})</span>` : ''}`
            : '';

        return `
        <div class="coach-rank">
          ${tier ? `<img class="coach-rank-emblem" src="assets/ranks/emblem-${escapeHtml(tier)}.png" alt="">` : ''}
          <div class="coach-rank-info">
            <div class="coach-rank-label">Ranked Solo/Duo · ${escapeHtml(roleLabel)}</div>
            <div class="coach-rank-title">${rankLine}</div>
            <div class="coach-rank-sub">Last ${h.games} games:
              <b class="good">${h.wins}W</b> <b class="bad">${h.losses}L</b>${lp ? ' · ' + lp : ''}
              <span class="coach-dim">· ${formatInt(games.length)} games this season</span></div>
          </div>
          <button class="coach-btn" onclick="window.renderCoachingPanel()">Refresh</button>
        </div>`;
    }

    // ── 2. Last-game report ──────────────────────────────────────────────────
    function renderReport() {
        const r = Progress.lastGameReport(state.games, state.index, window.computeTabStats);
        if (!r) return '<div id="coachReport"></div>';
        const g = r.game;
        const lp = lpText((window.lpDeltas || {})[g.matchId]);
        const role = Engine.ROLE_LABEL[g.teamPosition] || '';
        const isLatest = r.index === r.total - 1;

        const tiles = r.stats.map(s => {
            const arrow = s.verdict === 'better' ? '▲' : s.verdict === 'worse' ? '▼' : s.verdict === 'same' ? '=' : '';
            const word  = s.verdict === 'better' ? 'better' : s.verdict === 'worse' ? 'worse' : s.verdict === 'same' ? 'as usual' : '';
            return `
            <div class="coach-tile ${s.verdict || ''}">
              <div class="coach-tile-label">${escapeHtml(s.label)}</div>
              <div class="coach-tile-value">${escapeHtml(String(s.display))}</div>
              ${s.color ? `<span class="coach-tile-tier" style="background:${escapeHtml(s.color)}" title="${escapeHtml(s.roleBenchmark && role ? `The rank this value would match for a ${role} player` : 'The rank this value would match on average')}">${escapeHtml(cap(s.tier))}</span>` : '<span class="coach-tile-tier coach-tile-tier--none"></span>'}
              <div class="coach-tile-foot">
                <span class="coach-tile-verdict">${arrow} ${word}</span>
                <span class="coach-dim">usual ${escapeHtml(String(s.baselineDisplay))}</span>
              </div>
            </div>`;
        }).join('');

        const summary = r.baselineCount < 5
            ? `<span class="coach-dim">Not enough earlier games to compare with yet.</span>`
            : `<b class="good">${r.better} better</b> than usual · <b class="bad">${r.worse} worse</b> · ${r.same} about the same
               <span class="coach-dim">— compared with your ${r.baselineCount} ${r.baselineByRole && role ? escapeHtml(role) + ' ' : ''}games before it${!r.baselineByRole && role ? ` (too few ${escapeHtml(role)} games, so all roles)` : ''}</span>`;

        return `
        <div class="coach-report" id="coachReport">
          ${role ? `<div class="coach-report-role">${escapeHtml(role)} report <span class="coach-dim">· 4 general stats + 4 that matter most for ${escapeHtml(role)}</span></div>` : ''}
          <div class="coach-report-head">
            <button class="coach-step" onclick="coachingStep(-1)" ${r.index === 0 ? 'disabled' : ''} title="Earlier game" aria-label="Earlier game">‹</button>
            <div class="coach-report-title">
              <div><b>${escapeHtml(g.championName || '')}</b>${role ? ' · ' + escapeHtml(role) : ''}
                · <b class="${g.win ? 'good' : 'bad'}">${g.win ? 'Win' : 'Loss'}</b>
                · ${(g.kills ?? 0)} / ${(g.deaths ?? 0)} / ${(g.assists ?? 0)} <span class="coach-dim">KDA</span>
                ${lp ? ` · <span class="${lp.startsWith('+') ? 'good' : 'bad'}">${lp}</span>` : ''}</div>
              <div class="coach-dim">${isLatest ? 'Your last Solo/Duo game' : `${r.total - 1 - r.index} Solo/Duo game${r.total - 1 - r.index === 1 ? '' : 's'} before your last`} · ${timeAgo(g.gameCreation)}</div>
            </div>
            <button class="coach-step" onclick="coachingStep(1)" ${isLatest ? 'disabled' : ''} title="Later game" aria-label="Later game">›</button>
          </div>
          <div class="coach-report-summary">${summary}</div>
          <div class="coach-tiles">${tiles}</div>
        </div>`;
    }

    // ── 3. Habit board (#61) ─────────────────────────────────────────────────
    const roleName = r => ROLE_NAMES[r] || 'No role';

    window.coachingOpenTicket = function (id) {
        state.openTicket = state.openTicket === id ? null : id;
        const el = document.getElementById('coachBoard');
        if (el && state.board) el.innerHTML = renderBoard(state.board, state.moves);
        const detail = document.getElementById('coachTicketDetail');
        if (detail) detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    window.coachingTicketKey = function (event, id) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); window.coachingOpenTicket(id); }
    };

    function compareText(r, b, long) {
        if (!b) return '';
        const now = r.hit / r.of, then = b.hit / b.of;
        const was = long ? `was ${b.hit} of ${b.of} in the 10 before` : `was ${b.hit}/${b.of}`;
        if (now > then) return `<span class="good">▲ ${was}</span>`;
        if (now < then) return `<span class="bad">▼ ${was}</span>`;
        return `<span class="coach-dim">= ${long ? 'same as the 10 before' : 'same'}</span>`;
    }

    function renderTicket(t, moves) {
        const move = moves[t.id]
            ? `<div class="coach-ticket-moved">${escapeHtml(Board.columnLabel(moves[t.id].from))} → ${escapeHtml(Board.columnLabel(moves[t.id].to))}</div>` : '';
        const open = state.openTicket === t.id;
        return `
          <div class="coach-ticket${open ? ' open' : ''}" role="button" tabindex="0" aria-expanded="${open}"
               onclick="coachingOpenTicket('${escapeHtml(t.id)}')" onkeydown="coachingTicketKey(event, '${escapeHtml(t.id)}')">
            ${move}
            <div class="coach-ticket-title">${escapeHtml(t.label)}</div>
            <div class="coach-ticket-meta"><b>${t.recent.hit}/${t.recent.of}</b> on target ${compareText(t.recent, t.before, false)}</div>
          </div>`;
    }

    function renderBoard(board, moves) {
        if (!board.tickets.length) {
            return `<div class="coach-empty">Play a few more Solo/Duo games: each habit needs ${Board.MIN_GAMES} judged games before it gets a place on the board.</div>`;
        }
        const cols = board.columns.map(c => `
          <div class="coach-col coach-col--${c.id}">
            <div class="coach-col-head" title="${escapeHtml(c.hint)}">${escapeHtml(c.label)} <span>${c.tickets.length}</span></div>
            ${c.tickets.map(t => renderTicket(t, moves)).join('') || '<div class="coach-col-empty">—</div>'}
          </div>`).join('');
        const open = state.openTicket && board.tickets.find(t => t.id === state.openTicket);
        const waiting = board.tooFew.length
            ? `<div class="coach-dim coach-board-note">Not placed yet (fewer than ${Board.MIN_GAMES} games judged): ${board.tooFew.map(t => escapeHtml(t.label)).join(', ')}</div>` : '';
        return `<div class="coach-board">${cols}</div>${waiting}${open ? renderTicketDetail(open) : ''}`;
    }

    function renderTicketDetail(t) {
        const metric = Engine.METRICS.find(m => m.id === t.id);
        const dots = metric ? Board.habitDots(metric, Engine._internal.enrich(state.games)) : [];
        const dp = t.decimals;
        const dotHtml = dots.map(d => {
            const cls = d.met === null ? 'na' : d.met ? 'hit' : 'miss';
            const val = d.value === null || d.value === undefined ? '—' : fmt(d.value, dp);
            const tip = `${d.champion} (${roleName(d.role)}) · ${d.win ? 'Win' : 'Loss'} · ${val} ${t.unit} · ${d.met === null ? 'not judged' : d.met ? 'target hit' : 'target missed'}`;
            return `<span class="coach-dot ${cls}" title="${escapeHtml(tip)}"></span>`;
        }).join('');

        // The target for each role you played in these games
        const targets = [];
        if (!t.binary) {
            const seen = new Set();
            for (const d of dots) {
                if (d.target === null || d.target === undefined || seen.has(d.role)) continue;
                seen.add(d.role);
                targets.push(`${escapeHtml(roleName(d.role))} ${fmt(d.target, dp)}`);
            }
        }
        const stake = (t.wrMet !== null && t.wrMissed !== null)
            ? `<b>Why it matters:</b> in your ${t.sampleSize} Solo/Duo games you won <b class="good">${pct(t.wrMet)}</b> when you hit it
               and <b class="bad">${pct(t.wrMissed)}</b> when you missed it.${t.confident ? '' : ' <span class="coach-dim">The gap is small for the number of games, so treat it as a hint.</span>'}`
            : '';
        const status = Board.COLUMNS.find(c => c.id === t.status);
        const sub = [status ? `${escapeHtml(status.label)}: ${escapeHtml(status.hint)}` : '',
                     targets.length ? `Target: ${targets.join(' · ')} ${escapeHtml(t.unit)}` : ''].filter(Boolean).join(' · ');
        return `
        <div class="coach-focus coach-ticket-detail" id="coachTicketDetail">
          <div class="coach-focus-top">
            <div>
              <div class="coach-focus-title">${escapeHtml(t.label)}</div>
              <div class="coach-focus-sub">${sub}</div>
            </div>
            <button class="coach-btn" onclick="coachingOpenTicket('${escapeHtml(t.id)}')">Close</button>
          </div>
          <div class="coach-rule">
            <div class="coach-rule-label">The rule</div>
            <div class="coach-rule-text">${escapeHtml(t.rule)}</div>
          </div>
          <div class="coach-dots-row">
            <div class="coach-dots" aria-label="Last 10 games, oldest to newest">${dotHtml}</div>
            <div class="coach-dots-text">Hit in <b>${t.recent.hit} of your last ${t.recent.of}</b> games ${compareText(t.recent, t.before, true)}</div>
          </div>
          <div class="coach-dots-legend coach-dim">Last 10 games, oldest → newest · each judged on the target for the role you played ·
            <span class="coach-dot hit"></span> hit <span class="coach-dot miss"></span> missed</div>
          <p class="coach-evidence">${stake}</p>
        </div>`;
    }

    // ── 4. Trends ────────────────────────────────────────────────────────────
    // Which trend cards are switched to "all Solo/Duo games" (saved in config)
    function trendsAll() {
        const v = loadConfig().coachingTrendsAll;
        return Array.isArray(v) ? v : [];
    }

    window.coachingToggleTrendAll = function (event, tab) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        const cfg = loadConfig();
        const set = new Set(Array.isArray(cfg.coachingTrendsAll) ? cfg.coachingTrendsAll : []);
        if (set.has(tab)) set.delete(tab); else set.add(tab);
        cfg.coachingTrendsAll = [...set];
        updateConfig({ coachingTrendsAll: cfg.coachingTrendsAll });
        redrawTrends(cfg.coachingTrendsAll);
    };

    // Master switch: all on unless every card is already on, then all off
    window.coachingToggleAllTrends = function () {
        const cfg = loadConfig();
        const tabs = Progress.AREAS.map(a => a.tab);
        const current = Array.isArray(cfg.coachingTrendsAll) ? cfg.coachingTrendsAll : [];
        const allOn = tabs.every(t => current.includes(t));
        cfg.coachingTrendsAll = allOn ? [] : tabs;
        updateConfig({ coachingTrendsAll: cfg.coachingTrendsAll });
        redrawTrends(cfg.coachingTrendsAll);
    };

    function redrawTrends(allTabs) {
        const el = document.getElementById('coachTrends');
        if (el && state.games.length) {
            el.innerHTML = renderTrends(Progress.areaTrends(state.games, window.computeTabStats, 30, { all: allTabs }));
        }
    }

    window.coachingAreaKey = function (event, tab) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); window.coachingOpenArea(tab); }
    };

    function renderTrends(areas) {
        if (!areas.length) return `<div class="coach-empty">Play at least 10 Solo/Duo games to see trends.</div>`;
        const VERDICT = { improving: 'Improving', steady: 'Steady', slipping: 'Slipping' };
        const onCount = areas.filter(a => a.mode === 'all').length;
        const allOn = onCount === areas.length;
        const master = `
          <div class="coach-trends-bar">
            <label class="coach-switch coach-switch--master"
                   title="${allOn ? 'Switch every card back to your last 10 games' : 'Switch every card to all your Solo/Duo games'}">
              <input type="checkbox" ${allOn ? 'checked' : ''} onchange="coachingToggleAllTrends()">
              <span class="coach-switch-track"><span class="coach-switch-thumb"></span></span>
              <span class="coach-switch-label">${allOn ? 'All cards: all games'
                  : onCount ? `${onCount} of ${areas.length} on all games — flip to set all`
                  : 'All cards: last 10 games'}</span>
            </label>
          </div>`;
        return `${master}<div class="coach-areas">${areas.map(a => {
            const all = a.mode === 'all';
            const tab = escapeHtml(a.tab);
            const caption = all
                ? `${a.sparkWindow}-game average across all ${a.games} Solo/Duo games`
                : `10-game average over your last ${a.spark.length + 9} games`;
            const count = all
                ? `${a.improving} of ${a.total} stats better · ${a.slipping} worse <span title="Your newer half of games vs. your older half">(newer half vs. older half)</span>`
                : `${a.improving} of ${a.total} stats better · ${a.slipping} worse`;
            return `
            <div class="coach-area${all ? ' is-all' : ''}" role="button" tabindex="0"
                 onclick="coachingOpenArea('${tab}')" onkeydown="coachingAreaKey(event, '${tab}')"
                 title="Open ${tab} on the Analytics page">
              <div class="coach-area-head">
                <span class="coach-area-name">${tab}</span>
                <span class="coach-verdict ${a.verdict}">${VERDICT[a.verdict]}</span>
              </div>
              <label class="coach-switch" onclick="event.stopPropagation()" onkeydown="event.stopPropagation()"
                     title="${all ? 'Showing all your Solo/Duo games — switch off for the last 10' : 'Showing your last 10 games — switch on for all Solo/Duo games'}">
                <input type="checkbox" ${all ? 'checked' : ''} onchange="coachingToggleTrendAll(null, '${tab}')">
                <span class="coach-switch-track"><span class="coach-switch-thumb"></span></span>
                <span class="coach-switch-label">${all ? `All ${a.games} games` : 'Last 10 games'}</span>
              </label>
              ${a.lead ? `
              <div class="coach-area-lead">
                <span class="coach-dim">${escapeHtml(a.lead.label)}</span>
                <b${a.lead.color ? ` style="color:${escapeHtml(a.lead.color)}"` : ''}>${escapeHtml(String(a.lead.display))}</b>
              </div>` : ''}
              ${sparkline(a.spark)}
              <div class="coach-spark-caption coach-dim">${caption}</div>
              <div class="coach-area-list">${a.highlights.map(h => `
                <div class="coach-area-row">
                  <span>${escapeHtml(h.label)}</span>
                  <span class="${h.improving ? 'good' : 'bad'}">${escapeHtml(String(h.before))} → ${escapeHtml(String(h.now))} ${h.improving ? '▲' : '▼'}</span>
                </div>`).join('')}
              </div>
              <div class="coach-area-count coach-dim">${count}</div>
            </div>`;
        }).join('')}
          </div>`;
    }

    // ── 5. Details ───────────────────────────────────────────────────────────
    function renderEvidence(reference, n) {
        if (!reference || !reference.length) return '';
        const rows = reference.map(r => `
            <tr><td>${escapeHtml(r.label)}</td>
                <td class="num">${fmt(r.current, r.decimals)}${escapeHtml(r.unit || '')}</td></tr>`).join('');
        return `
          <div class="coach-subhead">Results <span class="coach-dim">— these follow from winning rather than cause it, so they aren't goals</span></div>
          <table class="coach-table">${rows}</table>
          <p class="coach-dim">Averages over your ${n} Solo/Duo games this season.</p>`;
    }

    function renderDetails(result) {
        return `
        <div class="coach-section-label coach-reference-head">
          <span>Details</span>
          <button class="coach-mini-btn" id="coachDetailsToggle" onclick="coachingToggleDetails()">${state.detailsOpen ? 'Hide' : 'Show'}</button>
        </div>
        <div class="coach-details ${state.detailsOpen ? '' : 'collapsed'}" id="coachDetailsBody">
          ${renderEvidence(result.reference, result.sampleSize)}
        </div>`;
    }

    // ── Entry point ──────────────────────────────────────────────────────────
    window.renderCoachingPanel = async function () {
        const container = document.getElementById('coaching-panel-content');
        if (!container) return;

        if (!state.games.length) {
            container.innerHTML = `
                <div class="coaching-loading">
                  <div class="coaching-spinner"></div>
                  <p>Analysing your Solo/Duo games…</p>
                </div>`;
        }

        try {
            const isRemake = typeof window.isRemake === 'function' ? window.isRemake : undefined;
            const games = Progress.soloGames(window.matchesData || [], isRemake);
            if (!games.length) {
                state.games = [];
                container.innerHTML = `<div class="coach-empty">No Solo/Duo games yet — sync your matches, then come back.</div>`;
                return;
            }

            // Rows not yet backfilled need their match JSON for some tabs
            if (typeof window.prefetchTabJson === 'function') {
                for (const tab of Progress.tabsNeeded()) {
                    try { await window.prefetchTabJson(tab, games); } catch (e) { console.warn('[Coaching] prefetch', tab, e); }
                }
            }

            // Every visit starts on the most recent Solo/Duo game
            state.index = games.length - 1;
            state.games = games;
            state.lastCount = games.length;

            const result = Engine.analyse(games);

            // Habit board: statuses now, and which tickets moved since last visit
            const board = Board.buildBoard(games, Engine, result.allInputs);
            const cfg = loadConfig();
            state.moves = Board.movesSince(cfg.coachingBoardStatus, board.tickets);
            state.board = board;
            if (state.openTicket && !board.tickets.some(t => t.id === state.openTicket)) state.openTicket = null;
            // pinning is gone (#61): drop the old coachingFocus key
            updateConfig({ coachingBoardStatus: Board.statusMap(board.tickets) }, { remove: ['coachingFocus'] });

            let reading = null;
            try {
                const readings = await getLpReadings('solo');
                reading = readings && readings.length ? readings[readings.length - 1] : null;
            } catch { /* LP history is optional */ }

            const areas = Progress.areaTrends(games, window.computeTabStats, 30, { all: trendsAll() });

            // Wide windows: two columns, habits on the right (polish.css .coach-layout)
            container.innerHTML = `
              <div class="coach-layout">
                <section class="coach-slot-rank">${renderHeader(games, reading, result.roleLabel)}</section>

                <section class="coach-slot-report">
                  <div class="coach-section-label">Game by game</div>
                  ${renderReport()}
                </section>

                <aside class="coach-slot-habits">
                  <div class="coach-section-label">Your habits <span class="coach-dim">— worst to best, last 10 games vs. the 10 before · click one for details</span></div>
                  <div id="coachBoard">${renderBoard(board, state.moves)}</div>
                </aside>

                <section class="coach-slot-trends">
                  <div class="coach-section-label">Trends <span class="coach-dim">— last 10 games vs. the 10 before, or flip a switch for all your Solo/Duo games · click one to open it in Analytics</span></div>
                  <div id="coachTrends">${renderTrends(areas)}</div>
                </section>

                <section class="coach-slot-details">${renderDetails(result)}</section>
              </div>`;
        } catch (err) {
            container.innerHTML = `<div class="coach-empty error">Error: ${escapeHtml(err.message)}</div>`;
            console.error('[CoachingPanel]', err);
        }
    };

    window.refreshCoachingPanel = window.renderCoachingPanel;
})();
