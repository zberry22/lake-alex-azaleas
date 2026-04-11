require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'azaleas2026';

// ---------------------------------------------------------------------------
// JSON file database
// ---------------------------------------------------------------------------
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'pool.json');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { teams: [], nextId: 1 };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Leaderboard fetching & parsing
// ---------------------------------------------------------------------------
let cache = { data: null, timestamp: 0, source: null };
const CACHE_TTL = 60 * 1000;

async function fetchLeaderboard() {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache;
  }

  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    if (res.ok) {
      const json = await res.json();
      const players = parseESPN(json);
      if (players.length > 0) {
        cache = { data: players, timestamp: Date.now(), source: 'ESPN' };
        return cache;
      }
    }
  } catch (err) {
    console.warn('ESPN fetch failed:', err.message);
  }

  try {
    const year = new Date().getFullYear();
    const res = await fetch(
      `https://www.masters.com/en_US/scores/feeds/${year}/scores.json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
    );
    if (res.ok) {
      const json = await res.json();
      const players = parseMasters(json);
      if (players.length > 0) {
        cache = { data: players, timestamp: Date.now(), source: 'Masters.com' };
        return cache;
      }
    }
  } catch (err) {
    console.warn('Masters.com fetch failed:', err.message);
  }

  return cache;
}

function parseToPar(str) {
  if (!str || str === 'E' || str === 'even') return 0;
  const n = parseInt(String(str).replace('+', ''));
  return isNaN(n) ? 0 : n;
}

function parseESPN(data) {
  try {
    const events = data.events || [];
    const event =
      events.find(e =>
        (e.name || '').toLowerCase().includes('masters') ||
        (e.shortName || '').toLowerCase().includes('masters')
      ) || events[0];

    if (!event) return [];

    const competition = (event.competitions || [])[0];
    if (!competition) return [];

    return (competition.competitors || []).map(c => {
      const linescores = c.linescores || [];

      const rounds = linescores.map(ls => {
        const dv = ls.displayValue;
        if (!dv || dv === '--' || dv === '') return null;
        return parseToPar(dv);
      });

      while (rounds.length < 4) rounds.push(null);

      const statusDesc = (c.status?.type?.description || '').toLowerCase();
      const isCut = statusDesc.includes('cut');
      const isWD  = statusDesc.includes('withdrawn') || statusDesc.includes('wd');

      const scoreToParStat = (c.statistics || []).find(s => s.name === 'scoreToPar');
      const toParStr = scoreToParStat?.displayValue || c.score?.displayValue || 'E';

      return {
        name:     c.athlete?.displayName || 'Unknown',
        espnId:   c.athlete?.id || String(c.id),
        position: c.status?.position?.displayName || '-',
        rounds,
        toParStr,
        thru:     c.status?.thru != null ? String(c.status.thru) : 'F',
        status:   isCut ? 'CUT' : isWD ? 'WD' : 'ACTIVE',
      };
    });
  } catch (err) {
    console.error('ESPN parse error:', err);
    return [];
  }
}

function parseMasters(data) {
  try {
    const raw = data?.data?.player || data?.player || [];
    return raw.map(p => {
      const rounds = [p.r1, p.r2, p.r3, p.r4].map(r => {
        if (!r || r === '--' || r === 'CUT' || r === 'WD' || r === 'MDF') return null;
        const n = Number(r);
        return isNaN(n) ? null : n - 72;
      });
      const statusCode = (p.status || '').toUpperCase();
      return {
        name:     `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.player || 'Unknown',
        espnId:   String(p.player_id || p.id || ''),
        position: p.pos || '-',
        rounds,
        toParStr: p.topar || p.to_par || p.tot || 'E',
        thru:     p.thru || 'F',
        status:   statusCode === 'C' || p.pos === 'CUT' ? 'CUT'
                : statusCode === 'W' ? 'WD'
                : 'ACTIVE',
      };
    });
  } catch (err) {
    console.error('Masters.com parse error:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Standings calculation — best 2 scores per round
// ---------------------------------------------------------------------------
function normalise(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function findPlayer(name, playerMap) {
  const key = normalise(name);
  if (playerMap[key]) return playerMap[key];
  const lastName = key.split(' ').pop();
  for (const [k, v] of Object.entries(playerMap)) {
    if (k.endsWith(lastName)) return v;
  }
  return null;
}

function formatToPar(val) {
  if (val == null) return '-';
  if (val === 0) return 'E';
  return val > 0 ? `+${val}` : String(val);
}

function calculateStandings(teams, players) {
  const playerMap = {};
  for (const p of players) {
    playerMap[normalise(p.name)] = p;
  }

  const results = teams.map(team => {
    const golferNames = [team.golfer1, team.golfer2, team.golfer3, team.golfer4];
    const golferData  = golferNames.map(n => findPlayer(n, playerMap));

    // DQ check: team needs at least 2 golfers who are not CUT or WD
    const activeCount = golferData.filter(g => g && g.status === 'ACTIVE').length;
    const isDisqualified = activeCount < 2;

    // For each round, take the best 2 to-par scores from the team
    const roundBests = [0, 1, 2, 3].map(ri => {
      const scored = golferData
        .filter(Boolean)
        .filter(g => g.status === 'ACTIVE')
        .map(g => ({ name: g.name, score: g.rounds[ri] }))
        .filter(s => s.score !== null && s.score !== undefined)
        .sort((a, b) => a.score - b.score); // ascending: lowest (best) first

      if (scored.length === 0) return null;

      const top2 = scored.slice(0, 2);
      const sum  = top2.reduce((acc, s) => acc + s.score, 0);
      return { sum, contributors: top2 };
    });

    const validRounds  = roundBests.filter(r => r !== null);
    const totalToPar   = validRounds.reduce((acc, r) => acc + r.sum, 0);
    const roundsPlayed = validRounds.length;

    return {
      id:        team.id,
      ownerName: team.owner_name,
      golfers: golferNames.map((name, i) => {
        const g = golferData[i];
        return {
          name,
          found:    !!g,
          status:   g?.status   || 'UNKNOWN',
          position: g?.position || '-',
          rounds:   g?.rounds   || [],
          toParStr: g?.toParStr || '-',
          thru:     g?.thru     || '',
        };
      }),
      roundBests,
      totalToPar,
      roundsPlayed,
      toParLabel:     roundsPlayed === 0 ? '-' : formatToPar(totalToPar),
      isDisqualified,
      activeCount,
    };
  });

  // Sort: non-DQ teams by totalToPar, then DQ teams at the bottom
  const active = results.filter(r => !r.isDisqualified);
  const dq     = results.filter(r => r.isDisqualified);

  active.sort((a, b) => {
    if (a.roundsPlayed === 0 && b.roundsPlayed === 0) return 0;
    if (a.roundsPlayed === 0) return 1;
    if (b.roundsPlayed === 0) return -1;
    return a.totalToPar - b.totalToPar;
  });

  // Assign positions for active teams
  let pos = 1;
  for (let i = 0; i < active.length; i++) {
    if (i > 0 && active[i].totalToPar !== active[i - 1].totalToPar) pos = i + 1;
    active[i].position = active[i].roundsPlayed === 0 ? '-' : pos;
  }

  // DQ teams all get last position label
  dq.forEach(t => { t.position = 'DQ'; });

  return [...active, ...dq];
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/leaderboard', async (req, res) => {
  const c = await fetchLeaderboard();
  res.json({ players: c.data || [], source: c.source, lastUpdated: c.timestamp });
});

app.get('/api/standings', async (req, res) => {
  const { teams } = readDB();
  const c = await fetchLeaderboard();
  const standings = calculateStandings(teams, c.data || []);
  res.json({
    standings,
    source:      c.source,
    lastUpdated: c.timestamp,
    playerCount: (c.data || []).length,
  });
});

app.get('/api/teams', (req, res) => {
  const { teams } = readDB();
  res.json([...teams].sort((a, b) => a.owner_name.localeCompare(b.owner_name)));
});

app.post('/api/teams', requireAdmin, (req, res) => {
  const { owner_name, golfer1, golfer2, golfer3, golfer4 } = req.body;
  if (!owner_name || !golfer1 || !golfer2 || !golfer3 || !golfer4) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  const db = readDB();
  const nameTaken = db.teams.some(t => t.owner_name.toLowerCase() === owner_name.trim().toLowerCase());
  if (nameTaken) return res.status(409).json({ error: 'A team with that name already exists.' });
  const team = {
    id: db.nextId++,
    owner_name: owner_name.trim(),
    golfer1: golfer1.trim(),
    golfer2: golfer2.trim(),
    golfer3: golfer3.trim(),
    golfer4: golfer4.trim(),
    created_at: new Date().toISOString(),
  };
  db.teams.push(team);
  writeDB(db);
  res.json({ id: team.id });
});

app.put('/api/teams/:id', requireAdmin, (req, res) => {
  const { owner_name, golfer1, golfer2, golfer3, golfer4 } = req.body;
  const id = parseInt(req.params.id);
  const db = readDB();
  const idx = db.teams.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Team not found.' });
  db.teams[idx] = { ...db.teams[idx], owner_name: owner_name.trim(), golfer1: golfer1.trim(), golfer2: golfer2.trim(), golfer3: golfer3.trim(), golfer4: golfer4.trim() };
  writeDB(db);
  res.json({ success: true });
});

app.delete('/api/teams/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  db.teams = db.teams.filter(t => t.id !== id);
  writeDB(db);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Lake Alex Azaleas running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
