#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
// Configuration
// ============================================================

const LEETCODE_USERNAME = process.env.LEETCODE_USERNAME || process.argv[2] || 'AryannnnnnShrivastva';
const OUTPUT_SNAKE_PATH = process.env.OUTPUT_SNAKE_PATH || path.join(__dirname, '..', 'dist', 'leetcode-snake.svg');
const OUTPUT_STATS_PATH = process.env.OUTPUT_STATS_PATH || path.join(__dirname, '..', 'dist', 'leetcode-stats.svg');

// Theme settings (Blue/purple palette)
const PALETTE = {
  background: '#0d1117',
  empty: '#161b22',
  cellBorder: '#1b1f230a',
  snakeHead: '#818cf8', // Indigo
  snakeBody: '#60a5fa', // Blue
  levels: [
    '#161b22',  // Level 0: empty
    '#4a3a8a',  // Level 1: light purple
    '#6c5ce7',  // Level 2: medium purple
    '#845ef7',  // Level 3: bright purple
    '#a78bfa',  // Level 4: vivid lavender
  ]
};

const CELL_SIZE = 11;
const CELL_GAP = 2;
const CELL_PITCH = CELL_SIZE + CELL_GAP;
const GRID_COLS = 52;
const GRID_ROWS = 7;
const SNAKE_LENGTH = 5;
const ANIMATION_DURATION_MS = 20000; // 20 seconds total duration for level-by-level eating
const PADDING = { left: 16, top: 32, right: 16, bottom: 24 };

// ============================================================
// LeetCode GraphQL API Fetch
// ============================================================

function fetchLeetCodeData(username) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      query: `query getLeetcodeStats($username: String!, $year: Int) {
        matchedUser(username: $username) {
          userCalendar(year: $year) {
            activeYears
            streak
            totalActiveDays
            submissionCalendar
          }
          badges {
            displayName
            creationDate
          }
        }
        userContestRanking(username: $username) {
          attendedContestsCount
          rating
          globalRanking
          topPercentage
        }
      }`,
      variables: { username }
    });

    const req = https.request({
      hostname: 'leetcode.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Referer': `https://leetcode.com/u/${username}/`,
        'Origin': 'https://leetcode.com'
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.data?.matchedUser) {
            reject(new Error(`User "${username}" not found or API error. Response: ${body.slice(0, 300)}`));
            return;
          }
          resolve({
            calendar: data.data.matchedUser.userCalendar,
            badges: data.data.matchedUser.badges,
            contest: data.data.userContestRanking
          });
        } catch (e) {
          reject(new Error(`Failed to parse LeetCode response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('LeetCode API request timed out (30s)'));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// Grid Builder — Convert submission timestamps to 52×7 grid
// ============================================================

function buildContributionGrid(submissionCalendar) {
  const calendar = typeof submissionCalendar === 'string'
    ? JSON.parse(submissionCalendar)
    : submissionCalendar;

  const grid = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0));
  const countsGrid = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0));
  const datesGrid = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(''));

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = today.getUTCDay();
  const gridStart = new Date(today);
  gridStart.setUTCDate(gridStart.getUTCDate() - (51 * 7 + dayOfWeek));

  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const cellDate = new Date(gridStart.getTime() + (c * 7 + r) * 86400000);
      const mName = MONTH_NAMES[cellDate.getUTCMonth()];
      const dNum = cellDate.getUTCDate();
      const yr = cellDate.getUTCFullYear();
      datesGrid[r][c] = `${mName} ${dNum}, ${yr}`;
    }
  }

  for (const [tsStr, count] of Object.entries(calendar)) {
    const date = new Date(parseInt(tsStr) * 1000);
    const diffDays = Math.round((date.getTime() - gridStart.getTime()) / 86400000);

    if (diffDays < 0 || diffDays >= 364) continue;

    const col = Math.floor(diffDays / 7);
    const row = diffDays % 7;

    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) continue;

    countsGrid[row][col] = count;
    grid[row][col] = count >= 10 ? 4 : count >= 7 ? 3 : count >= 4 ? 2 : count >= 1 ? 1 : 0;
  }

  return { grid, countsGrid, datesGrid };
}

// ============================================================
// Pathfinder Simulation (BFS + Greedy Target Selection)
// ============================================================

function bfs(start, target, body, rows, cols) {
  const queue = [[start]];
  const visited = new Set();
  visited.add(`${start.row},${start.col}`);
  const bodySet = new Set(body.map(p => `${p.row},${p.col}`));

  while (queue.length > 0) {
    const path = queue.shift();
    const curr = path[path.length - 1];

    if (curr.row === target.row && curr.col === target.col) {
      return path.slice(1);
    }

    const neighbors = [
      { row: curr.row - 1, col: curr.col },
      { row: curr.row + 1, col: curr.col },
      { row: curr.row, col: curr.col - 1 },
      { row: curr.row, col: curr.col + 1 }
    ];

    for (const neighbor of neighbors) {
      if (neighbor.row >= 0 && neighbor.row < rows && neighbor.col >= 0 && neighbor.col < cols) {
        const key = `${neighbor.row},${neighbor.col}`;
        if (!visited.has(key) && !bodySet.has(key)) {
          visited.add(key);
          queue.push([...path, neighbor]);
        }
      }
    }
  }
  return null;
}

function getFallbackMove(head, body, rows, cols) {
  const neighbors = [
    { row: head.row - 1, col: head.col },
    { row: head.row + 1, col: head.col },
    { row: head.row, col: head.col - 1 },
    { row: head.row, col: head.col + 1 }
  ];
  const bodySet = new Set(body.map(p => `${p.row},${p.col}`));
  for (const n of neighbors) {
    if (n.row >= 0 && n.row < rows && n.col >= 0 && n.col < cols) {
      if (!bodySet.has(`${n.row},${n.col}`)) return n;
    }
  }
  for (const n of neighbors) {
    if (n.row >= 0 && n.row < rows && n.col >= 0 && n.col < cols) return n;
  }
  return head;
}

function runSnakeSimulation(grid) {
  // Group active food cells by contribution level (Level 1 -> 4)
  const levelBuckets = { 1: [], 2: [], 3: [], 4: [] };

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const lvl = grid[r][c];
      if (lvl >= 1 && lvl <= 4) {
        levelBuckets[lvl].push({ row: r, col: c });
      }
    }
  }

  let snake = [];
  for (let i = 0; i < SNAKE_LENGTH; i++) {
    snake.push({ row: 0, col: 0 });
  }

  const history = [snake.map(p => ({...p}))];
  const eatenTicks = {};

  if (grid[0][0] > 0) {
    eatenTicks['0,0'] = 0;
  }

  let steps = 0;
  const maxSteps = 1500;

  // Process level 1 first (lightest), then level 2, level 3, level 4 (darkest)
  for (let targetLevel = 1; targetLevel <= 4; targetLevel++) {
    let currentLevelFood = levelBuckets[targetLevel].filter(
      f => eatenTicks[`${f.row},${f.col}`] === undefined
    );

    while (currentLevelFood.length > 0 && steps < maxSteps) {
      const head = snake[0];

      // Find closest uneaten food in the current contribution level
      let closestFood = null;
      let minDist = Infinity;

      currentLevelFood.forEach(f => {
        const dist = Math.abs(f.row - head.row) + Math.abs(f.col - head.col);
        if (dist < minDist) {
          minDist = dist;
          closestFood = f;
        }
      });

      if (!closestFood) break;

      let pathSteps = bfs(head, closestFood, snake, GRID_ROWS, GRID_COLS);

      if (!pathSteps || pathSteps.length === 0) {
        pathSteps = [getFallbackMove(head, snake, GRID_ROWS, GRID_COLS)];
      }

      for (const nextMove of pathSteps) {
        steps++;
        snake.unshift(nextMove);
        snake.pop();

        history.push(snake.map(p => ({...p})));

        const newHead = snake[0];
        const key = `${newHead.row},${newHead.col}`;
        if (grid[newHead.row] && grid[newHead.row][newHead.col] > 0 && eatenTicks[key] === undefined) {
          eatenTicks[key] = steps;
        }

        currentLevelFood = currentLevelFood.filter(
          f => eatenTicks[`${f.row},${f.col}`] === undefined
        );
        if (currentLevelFood.length === 0) break;
      }
    }
  }

  // Smooth exit off the right edge of the grid after eating all levels
  while (snake[0].col < GRID_COLS + SNAKE_LENGTH && steps < maxSteps) {
    steps++;
    const head = snake[0];
    let nextMove;
    const neighbors = [
      { row: head.row, col: head.col + 1 },
      { row: head.row - 1, col: head.col },
      { row: head.row + 1, col: head.col },
      { row: head.row, col: head.col - 1 }
    ];
    const bodySet = new Set(snake.map(p => `${p.row},${p.col}`));
    nextMove = neighbors.find(n => n.row >= 0 && n.row < GRID_ROWS && !bodySet.has(`${n.row},${n.col}`));
    if (!nextMove) {
      nextMove = { row: head.row, col: head.col + 1 };
    }
    snake.unshift(nextMove);
    snake.pop();

    history.push(snake.map(p => ({...p})));

    const newHead = snake[0];
    const key = `${newHead.row},${newHead.col}`;
    if (grid[newHead.row] && grid[newHead.row][newHead.col] > 0 && eatenTicks[key] === undefined) {
      eatenTicks[key] = steps;
    }
  }

  return { history, eatenTicks };
}

// ============================================================
// SVG Generators
// ============================================================

function toId(r, c) {
  return `c_${r}_${c}`;
}

function generateAnimatedSVG(gridData, history, eatenTicks, username) {
  const { grid, countsGrid, datesGrid } = gridData;
  const totalTicks = history.length;
  const stepPct = 100 / totalTicks;
  
  const contentW = GRID_COLS * CELL_PITCH - CELL_GAP;
  const contentH = GRID_ROWS * CELL_PITCH - CELL_GAP;
  const viewW = contentW + PADDING.left + PADDING.right;
  const viewH = contentH + PADDING.top + PADDING.bottom + 14;
  const progressY = PADDING.top + contentH + 14;

  let css = '';
  css += `:root{--cb:${PALETTE.cellBorder};--csh:${PALETTE.snakeHead};--csb:${PALETTE.snakeBody};`;
  PALETTE.levels.forEach((c, i) => { css += `--c${i}:${c};`; });
  css += '}\n';

  const SNAKE_COLORS = ['#c084fc', '#a855f7', '#9333ea', '#7e22ce', '#6b21a8'];
  const SNAKE_SCALES = [1.25, 0.92, 0.74, 0.54, 0.36];

  css += `.c{shape-rendering:geometricPrecision;stroke-width:1px;stroke:var(--cb);width:${CELL_SIZE}px;height:${CELL_SIZE}px;transform-box:fill-box;transform-origin:center;transition:stroke 0.15s, stroke-width 0.15s}\n`;
  css += `.c:hover{stroke:#a78bfa !important;stroke-width:1.5px;cursor:pointer}\n`;
  css += `.u{transform-origin:0 0;transform:scale(0,1);animation:u0 ${ANIMATION_DURATION_MS}ms linear infinite}\n`;
  css += `.tip{opacity:0;visibility:hidden;pointer-events:none;transition:opacity 0.12s ease-in-out, visibility 0.12s ease-in-out}\n`;

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const initialVal = grid[r][c];
      const initialColor = `var(--c${initialVal})`;
      const id = toId(r, c);
      const foodKey = `${r},${c}`;
      const eatenAt = eatenTicks[foodKey] !== undefined ? eatenTicks[foodKey] : Infinity;

      // Hover rule to show floating tooltip overlay
      css += `#${id}:hover ~ #t_${id}{opacity:1;visibility:visible}\n`;

      const timeline = [];
      let prevColor = null;
      let prevScale = null;

      for (let t = 0; t < totalTicks; t++) {
        const snakeAtTick = history[t];
        const snakeIndex = snakeAtTick.findIndex(p => p.row === r && p.col === c);

        let color, scale;
        if (snakeIndex >= 0 && snakeIndex < SNAKE_LENGTH) {
          color = SNAKE_COLORS[snakeIndex];
          scale = SNAKE_SCALES[snakeIndex];
        } else {
          color = t < eatenAt ? initialColor : 'var(--c0)';
          scale = 1.0;
        }

        if (color !== prevColor || scale !== prevScale) {
          timeline.push({ tick: t, color, scale });
          prevColor = color;
          prevScale = scale;
        }
      }

      if (timeline.length === 1 && initialVal === 0) {
        css += `.c.${id}{fill:var(--c0);transform:scale(1)}\n`;
        continue;
      }

      css += `@keyframes k_${id}{`;
      for (let i = 0; i < timeline.length; i++) {
        const { tick, color, scale } = timeline[i];
        const pct = (tick * stepPct).toFixed(2);
        
        if (i > 0) {
          const prevPct = ((tick - 0.05) * stepPct).toFixed(2);
          const prev = timeline[i - 1];
          css += `${prevPct}%{fill:${prev.color};transform:scale(${prev.scale})}`;
        }
        css += `${pct}%{fill:${color};transform:scale(${scale})}`;
      }
      const last = timeline[timeline.length - 1];
      css += `100%{fill:${last.color};transform:scale(${last.scale})}`;
      css += '}\n';

      css += `.c.${id}{animation:k_${id} ${ANIMATION_DURATION_MS}ms linear infinite}\n`;
    }
  }

  let uKf = '@keyframes u0{';
  const pSteps = 40;
  for (let i = 0; i <= pSteps; i++) {
    const pct = ((i / pSteps) * 100).toFixed(1);
    const scale = (i / pSteps).toFixed(3);
    uKf += `${pct}%{transform:scale(${scale},1)}`;
  }
  uKf += '}\n';
  css += uKf;

  let els = '';
  els += `<rect x="0" y="0" width="${viewW}" height="${viewH}" fill="${PALETTE.background}" rx="6"/>\n`;

  // Render grid cells first
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const id = toId(r, c);
      const x = PADDING.left + c * CELL_PITCH;
      const y = PADDING.top + r * CELL_PITCH;
      const count = (countsGrid && countsGrid[r] && countsGrid[r][c]) || 0;
      const dateStr = (datesGrid && datesGrid[r] && datesGrid[r][c]) || '';
      const countText = count === 0 ? 'No submissions' : count === 1 ? '1 submission' : `${count} submissions`;
      const tooltip = `${countText} on ${dateStr}`;

      els += `<rect id="${id}" class="c ${id}" x="${x}" y="${y}" rx="2" ry="2"><title>${tooltip}</title></rect>\n`;
    }
  }

  els += `<rect class="u" x="${PADDING.left}" y="${progressY}" width="${contentW}" height="5" rx="2.5" fill="var(--csb)" opacity="0.5"/>\n`;

  // Render overlay tooltips at the end (always on top)
  const TIP_W = 165;
  const TIP_H = 24;

  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const id = toId(r, c);
      const cellX = PADDING.left + c * CELL_PITCH;
      const cellY = PADDING.top + r * CELL_PITCH;
      const count = (countsGrid && countsGrid[r] && countsGrid[r][c]) || 0;
      const dateStr = (datesGrid && datesGrid[r] && datesGrid[r][c]) || '';
      const countText = count === 0 ? 'No submissions' : count === 1 ? '1 submission' : `${count} submissions`;
      const tooltipText = `${countText} on ${dateStr}`;

      const rawX = cellX + (CELL_SIZE / 2) - (TIP_W / 2);
      const tipX = Math.max(8, Math.min(viewW - TIP_W - 8, rawX));
      const tipY = r < 3 ? cellY + CELL_SIZE + 6 : cellY - TIP_H - 6;

      els += `<g id="t_${id}" class="tip" transform="translate(${tipX}, ${tipY})">
  <rect width="${TIP_W}" height="${TIP_H}" rx="5" fill="#161b22" stroke="#818cf8" stroke-width="1.2"/>
  <text x="${TIP_W / 2}" y="16" text-anchor="middle" fill="#ffffff" font-size="10.5" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" font-weight="600">${tooltipText}</text>
</g>\n`;
    }
  }

  return `<svg viewBox="0 0 ${viewW} ${viewH}" width="${viewW}" height="${viewH}" xmlns="http://www.w3.org/2000/svg">
<desc>LeetCode Contribution Snake for ${username}</desc>
<style>
${css}</style>
${els}</svg>`;
}

// Stats Card SVG Generator
function generateStatsSVG(stats) {
  const submissions = stats.submissions || 0;
  const activeDays = stats.activeDays || 0;
  const rating = Math.round(stats.rating || 0);
  const topPercentage = stats.topPercentage !== undefined ? stats.topPercentage : '0.0';
  const badgesCount = stats.badgesCount || 0;
  const recentBadge = stats.recentBadge || 'None';

  return `<svg width="490" height="195" viewBox="0 0 490 195" fill="none" xmlns="http://www.w3.org/2000/svg">
    <style>
      .card-link { cursor: pointer; text-decoration: none; }
      .title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 28px; fill: #a78bfa; text-anchor: middle; }
      .label { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-weight: 600; font-size: 13px; fill: #c9d1d9; text-anchor: middle; }
      .sublabel { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-weight: 400; font-size: 11px; fill: #8b949e; text-anchor: middle; }
      .sublabel-highlight { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 11px; fill: #60a5fa; text-anchor: middle; }
      .rating-val { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-weight: 700; font-size: 19px; fill: #ffffff; text-anchor: middle; }
      .separator { stroke: #30363d; stroke-width: 1; }
    </style>

    <a href="https://leetcode.com/u/AryannnnnnShrivastva/" target="_blank" class="card-link">
      <!-- Background card -->
      <rect width="490" height="195" rx="8" fill="#0d1117" stroke="#1f2937" stroke-width="1.5"/>

      <!-- Left Column (Submissions) -->
      <text x="90" y="95" class="title">${submissions.toLocaleString()}</text>
      <text x="90" y="125" class="label">Total Submissions</text>
      <text x="90" y="148" class="sublabel">Active Days: ${activeDays}</text>

      <!-- Column Separators -->
      <line x1="172" y1="35" x2="172" y2="160" class="separator" stroke-linecap="round" />
      <line x1="318" y1="35" x2="318" y2="160" class="separator" stroke-linecap="round" />

      <!-- Center Column (Contest Rating) -->
      <!-- Progress Ring -->
      <circle cx="245" cy="85" r="28" fill="none" stroke="#223049" stroke-width="4.5"/>
      <circle cx="245" cy="85" r="28" fill="none" stroke="#60a5fa" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="145 30" transform="rotate(-110 245 85)"/>
      
      <!-- Flame Icon -->
      <g transform="translate(237, 44)">
        <path d="M8 0C3 3 1.5 6 1.5 9.5C1.5 13.5 4.5 16 8 16C11.5 16 14.5 13.5 14.5 9.5C14.5 5 11 2 8 0ZM8 13C6.3 13 5 11.7 5 10C5 8.9 5.8 7.4 7.2 6.3C7.6 6 8.4 6 8.8 6.3C10.2 7.4 11 8.9 11 10C11 11.7 9.7 13 8 13Z" fill="#ffb020"/>
      </g>

      <text x="245" y="91" class="rating-val">${rating}</text>
      <text x="245" y="125" class="label">Contest Rating</text>
      <text x="245" y="148" class="sublabel-highlight">Top ${topPercentage}%</text>

      <!-- Right Column (Badges) -->
      <text x="400" y="95" class="title">${badgesCount}</text>
      <text x="400" y="125" class="label">Badges Earned</text>
      <text x="400" y="148" class="sublabel" clip-path="url(#badge-clip)">${recentBadge}</text>
    </a>

    <!-- Clip path to prevent long badge names from overflowing -->
    <clipPath id="badge-clip">
      <rect x="325" y="135" width="150" height="25"/>
    </clipPath>
  </svg>`;
}

// ============================================================
// Main Execution
// ============================================================

async function main() {
  console.log(`\n🐍 LeetCode Snake & Stats Generator`);
  console.log(`   Username: ${LEETCODE_USERNAME}`);
  console.log(`   Snake Out: ${OUTPUT_SNAKE_PATH}`);
  console.log(`   Stats Out: ${OUTPUT_STATS_PATH}\n`);

  console.log('📡 Fetching LeetCode data...');
  let res;
  try {
    res = await fetchLeetCodeData(LEETCODE_USERNAME);
  } catch (err) {
    console.error(`   ❌ ${err.message}`);
    process.exit(1);
  }

  const calendarData = res.calendar;
  const badgesData = res.badges || [];
  const contestData = res.contest || {};

  // Sum up all submissions in the calendar
  let totalSubmissions = 0;
  try {
    const calendar = JSON.parse(calendarData.submissionCalendar);
    totalSubmissions = Object.values(calendar).reduce((sum, count) => sum + count, 0);
  } catch (e) {
    console.warn('   ⚠️ Could not compute total submissions');
  }

  // Get most recent badge
  let recentBadgeName = 'None';
  if (badgesData.length > 0) {
    // Sort badges by creationDate descending if possible, or take the first one
    const sorted = [...badgesData].sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate));
    recentBadgeName = sorted[0].displayName;
  }

  console.log(`   ✅ Total Submissions (past year): ${totalSubmissions}`);
  console.log(`   ✅ Active days: ${calendarData.totalActiveDays}`);
  console.log(`   ✅ Contest Rating: ${contestData.rating ? Math.round(contestData.rating) : 'N/A'}`);
  console.log(`   ✅ Top Percentile: ${contestData.topPercentage !== undefined ? contestData.topPercentage + '%' : 'N/A'}`);
  console.log(`   ✅ Badges count: ${badgesData.length} (Recent: ${recentBadgeName})`);

  // 1. Generate Snake Game SVG
  console.log('\n📊 Building contribution grid...');
  const { grid, countsGrid, datesGrid } = buildContributionGrid(calendarData.submissionCalendar);
  const activeCells = grid.flat().filter(v => v > 0).length;
  console.log(`   ✅ ${activeCells} active cells out of ${GRID_ROWS * GRID_COLS}`);

  console.log('\n🎮 Running pathfinder simulation...');
  const { history, eatenTicks } = runSnakeSimulation(grid);
  console.log(`   ✅ Snake simulation finished in ${history.length} ticks`);

  console.log('\n🎨 Generating animated Snake SVG...');
  const snakeSvg = generateAnimatedSVG({ grid, countsGrid, datesGrid }, history, eatenTicks, LEETCODE_USERNAME);
  console.log(`   ✅ Snake SVG size: ${(Buffer.byteLength(snakeSvg) / 1024).toFixed(1)} KB`);

  // 2. Generate Stats SVG
  console.log('\n🎨 Generating Stats Card SVG...');
  const statsSvg = generateStatsSVG({
    submissions: totalSubmissions,
    activeDays: calendarData.totalActiveDays,
    rating: contestData.rating,
    topPercentage: contestData.topPercentage,
    badgesCount: badgesData.length,
    recentBadge: recentBadgeName
  });
  console.log(`   ✅ Stats SVG size: ${(Buffer.byteLength(statsSvg) / 1024).toFixed(1)} KB`);

  // Write SVGs to output directories
  const snakeDir = path.dirname(OUTPUT_SNAKE_PATH);
  if (!fs.existsSync(snakeDir)) fs.mkdirSync(snakeDir, { recursive: true });
  fs.writeFileSync(OUTPUT_SNAKE_PATH, snakeSvg);
  console.log(`   💾 Snake SVG saved to ${OUTPUT_SNAKE_PATH}`);

  const statsDir = path.dirname(OUTPUT_STATS_PATH);
  if (!fs.existsSync(statsDir)) fs.mkdirSync(statsDir, { recursive: true });
  fs.writeFileSync(OUTPUT_STATS_PATH, statsSvg);
  console.log(`   💾 Stats SVG saved to ${OUTPUT_STATS_PATH}`);

  console.log(`\n✅ Success! All SVGs generated successfully.\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
