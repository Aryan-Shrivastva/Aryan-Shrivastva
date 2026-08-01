#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
// Configuration
// ============================================================

const LEETCODE_USERNAME = process.env.LEETCODE_USERNAME || process.argv[2] || 'AryannnnnnShrivastva';
const OUTPUT_PATH = process.env.OUTPUT_PATH || process.argv[3] || path.join(__dirname, '..', 'dist', 'leetcode-snake.svg');

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
const ANIMATION_DURATION_MS = 60000; // 1 minute animation
const PADDING = { left: 16, top: 32, right: 16, bottom: 24 };

// ============================================================
// LeetCode GraphQL API Fetch
// ============================================================

function fetchLeetCodeData(username) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      query: `query userProfileCalendar($username: String!, $year: Int) {
        matchedUser(username: $username) {
          userCalendar(year: $year) {
            activeYears
            streak
            totalActiveDays
            submissionCalendar
          }
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
          if (!data.data?.matchedUser?.userCalendar) {
            reject(new Error(`User "${username}" not found or API error. Response: ${body.slice(0, 300)}`));
            return;
          }
          resolve(data.data.matchedUser.userCalendar);
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

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = today.getUTCDay();
  const gridStart = new Date(today);
  gridStart.setUTCDate(gridStart.getUTCDate() - (51 * 7 + dayOfWeek));

  for (const [tsStr, count] of Object.entries(calendar)) {
    const date = new Date(parseInt(tsStr) * 1000);
    const diffDays = Math.round((date.getTime() - gridStart.getTime()) / 86400000);

    if (diffDays < 0 || diffDays >= 364) continue;

    const col = Math.floor(diffDays / 7);
    const row = diffDays % 7;

    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) continue;

    grid[row][col] = count >= 10 ? 4 : count >= 7 ? 3 : count >= 4 ? 2 : count >= 1 ? 1 : 0;
  }

  return grid;
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
  // Extract food coordinates
  const food = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (grid[r][c] > 0) {
        food.push({ row: r, col: c });
      }
    }
  }

  // Initial snake: 5 segments starting at (0,0)
  let snake = [];
  for (let i = 0; i < SNAKE_LENGTH; i++) {
    snake.push({ row: 0, col: 0 });
  }

  const remainingFood = [...food];
  const history = [snake.map(p => ({...p}))];
  
  // Track when each food is eaten
  const eatenTicks = {};

  let steps = 0;
  const maxSteps = 1200;

  while (remainingFood.length > 0 && steps < maxSteps) {
    steps++;
    const head = snake[0];

    // Find closest food
    let closestFood = null;
    let minDist = Infinity;
    let closestIdx = -1;

    remainingFood.forEach((f, idx) => {
      const dist = Math.abs(f.row - head.row) + Math.abs(f.col - head.col);
      if (dist < minDist) {
        minDist = dist;
        closestFood = f;
        closestIdx = idx;
      }
    });

    let pathSteps = bfs(head, closestFood, snake, GRID_ROWS, GRID_COLS);

    // If target blocked, find path to any reachable food
    if (!pathSteps) {
      for (let i = 0; i < remainingFood.length; i++) {
        pathSteps = bfs(head, remainingFood[i], snake, GRID_ROWS, GRID_COLS);
        if (pathSteps) {
          closestIdx = i;
          break;
        }
      }
    }

    let nextMove;
    if (pathSteps && pathSteps.length > 0) {
      nextMove = pathSteps[0];
    } else {
      nextMove = getFallbackMove(head, snake, GRID_ROWS, GRID_COLS);
    }

    snake.unshift(nextMove);
    snake.pop();

    history.push(snake.map(p => ({...p})));

    const newHead = snake[0];
    const key = `${newHead.row},${newHead.col}`;
    const eatenIdx = remainingFood.findIndex(f => f.row === newHead.row && f.col === newHead.col);
    if (eatenIdx !== -1) {
      remainingFood.splice(eatenIdx, 1);
      eatenTicks[key] = steps;
    }
  }

  // Crawl off screen to the right
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
  }

  return { history, eatenTicks };
}

// ============================================================
// SVG Generator with Keyframe Animation Timeline
// ============================================================

function toId(r, c) {
  return `c_${r}_${c}`;
}

function generateAnimatedSVG(grid, history, eatenTicks, username) {
  const totalTicks = history.length;
  const stepPct = 100 / totalTicks;
  
  // Dimensions
  const contentW = GRID_COLS * CELL_PITCH - CELL_GAP;
  const contentH = GRID_ROWS * CELL_PITCH - CELL_GAP;
  const viewW = contentW + PADDING.left + PADDING.right;
  const viewH = contentH + PADDING.top + PADDING.bottom + 14;
  const progressY = PADDING.top + contentH + 14;

  let css = '';
  css += `:root{--cb:${PALETTE.cellBorder};--csh:${PALETTE.snakeHead};--csb:${PALETTE.snakeBody};`;
  PALETTE.levels.forEach((c, i) => { css += `--c${i}:${c};`; });
  css += '}\n';

  css += `.c{shape-rendering:geometricPrecision;stroke-width:1px;stroke:var(--cb);width:${CELL_SIZE}px;height:${CELL_SIZE}px}\n`;
  css += `.u{transform-origin:0 0;transform:scale(0,1);animation:u0 ${ANIMATION_DURATION_MS}ms linear infinite}\n`;

  // Generate individual keyframes for cells
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const initialVal = grid[r][c];
      const initialColor = `var(--c${initialVal})`;
      const id = toId(r, c);
      const foodKey = `${r},${c}`;
      const eatenAt = eatenTicks[foodKey] !== undefined ? eatenTicks[foodKey] : Infinity;

      // Build timeline of states
      const timeline = [];
      let prevColor = null;

      for (let t = 0; t < totalTicks; t++) {
        const snakeAtTick = history[t];
        const snakeIndex = snakeAtTick.findIndex(p => p.row === r && p.col === c);

        let color;
        if (snakeIndex === 0) {
          color = 'var(--csh)'; // Snake Head
        } else if (snakeIndex > 0) {
          color = 'var(--csb)'; // Snake Body
        } else {
          color = t < eatenAt ? initialColor : 'var(--c0)'; // Contribution color if not eaten yet, otherwise empty
        }

        if (color !== prevColor) {
          timeline.push({ tick: t, color });
          prevColor = color;
        }
      }

      // If never visited and it's empty, we don't need keyframes
      if (timeline.length === 1 && initialVal === 0) {
        css += `.c.${id}{fill:var(--c0)}\n`;
        continue;
      }

      // Generate keyframe CSS
      css += `@keyframes k_${id}{`;
      for (let i = 0; i < timeline.length; i++) {
        const { tick, color } = timeline[i];
        const pct = (tick * stepPct).toFixed(2);
        
        // Add a flat step transition to prevent interpolation gradients
        if (i > 0) {
          const prevPct = ((tick - 0.05) * stepPct).toFixed(2);
          css += `${prevPct}%{fill:${timeline[i - 1].color}}`;
        }
        css += `${pct}%{fill:${color}}`;
      }
      css += `100%{fill:${timeline[timeline.length - 1].color}}`;
      css += '}\n';

      css += `.c.${id}{animation:k_${id} ${ANIMATION_DURATION_MS}ms linear infinite}\n`;
    }
  }

  // Progress bar animation
  let uKf = '@keyframes u0{';
  const pSteps = 40;
  for (let i = 0; i <= pSteps; i++) {
    const pct = ((i / pSteps) * 100).toFixed(1);
    const scale = (i / pSteps).toFixed(3);
    uKf += `${pct}%{transform:scale(${scale},1)}`;
  }
  uKf += '}\n';
  css += uKf;

  // Build SVG content
  let els = '';
  els += `<rect x="0" y="0" width="${viewW}" height="${viewH}" fill="${PALETTE.background}" rx="6"/>\n`;

  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const id = toId(r, c);
      const x = PADDING.left + c * CELL_PITCH;
      const y = PADDING.top + r * CELL_PITCH;
      els += `<rect class="c ${id}" x="${x}" y="${y}" rx="2" ry="2"/>\n`;
    }
  }

  els += `<rect class="u" x="${PADDING.left}" y="${progressY}" width="${contentW}" height="5" rx="2.5" fill="var(--csb)" opacity="0.5"/>\n`;

  return `<svg viewBox="0 0 ${viewW} ${viewH}" width="${viewW}" height="${viewH}" xmlns="http://www.w3.org/2000/svg">
<desc>LeetCode Contribution Snake for ${username}</desc>
<style>
${css}</style>
${els}</svg>`;
}

// ============================================================
// Main Execution
// ============================================================

async function main() {
  console.log(`\n🐍 LeetCode Snake Generator`);
  console.log(`   Username: ${LEETCODE_USERNAME}`);
  console.log(`   Output:   ${OUTPUT_PATH}\n`);

  console.log('📡 Fetching LeetCode data...');
  let calendarData;
  try {
    calendarData = await fetchLeetCodeData(LEETCODE_USERNAME);
    console.log(`   ✅ Streak: ${calendarData.streak}`);
    console.log(`   ✅ Active days: ${calendarData.totalActiveDays}`);
  } catch (err) {
    console.error(`   ❌ ${err.message}`);
    process.exit(1);
  }

  console.log('\n📊 Building contribution grid...');
  const grid = buildContributionGrid(calendarData.submissionCalendar);
  const activeCells = grid.flat().filter(v => v > 0).length;
  console.log(`   ✅ ${activeCells} active cells out of ${GRID_ROWS * GRID_COLS}`);

  console.log('\n🎮 Running pathfinder simulation...');
  const { history, eatenTicks } = runSnakeSimulation(grid);
  console.log(`   ✅ Snake simulation finished in ${history.length} ticks`);

  console.log('\n🎨 Generating animated SVG...');
  const svg = generateAnimatedSVG(grid, history, eatenTicks, LEETCODE_USERNAME);
  console.log(`   ✅ SVG size: ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`);

  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, svg);
  console.log(`\n✅ Success! Snake SVG → ${OUTPUT_PATH}\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
