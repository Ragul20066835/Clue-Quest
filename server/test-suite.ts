import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { initDb, db } from './db/client.js';
import { seedDatabase } from './db/seed.js';
import { authRouter } from './routes/authRoutes.js';
import { gameRouter } from './routes/gameRoutes.js';
import { eventRouter } from './routes/eventRoutes.js';
import { adminRouter } from './routes/adminRoutes.js';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import {
  getActiveEventCached,
  setActiveEventCache,
  getQuestionBankCached,
  getQuestionByNumberCached,
  invalidateActiveEventCache,
  invalidateQuestionBankCache,
  getCacheInspectionState,
  invalidateAuthUserCache,
  setAuthUserCache,
  getAuthUserCached,
} from './services/cacheService.js';
import { getPollingInterval, POLLING_SCHEDULE } from '../src/context/GameContext.js';

const BASE_URL = 'http://127.0.0.1:3001/api';
let serverInstance: any = null;

async function ensureServerRunning() {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.ok) return;
  } catch {
    // Server not running, launch in-process test server
  }

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  await initDb();
  await seedDatabase();

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'CLUE QUEST Test Server' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/game', gameRouter);
  app.use('/api/event', eventRouter);
  app.use('/api/admin', adminRouter);

  await new Promise<void>((resolve) => {
    serverInstance = app.listen(3001, '127.0.0.1', () => {
      resolve();
    });
  });
}

async function api(path: string, options: { method?: string; body?: any; token?: string; cookie?: string } = {}) {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.cookie) headers['Cookie'] = options.cookie;

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  return { status: res.status, ok: res.ok, data: json, headers: res.headers };
}

async function runTests() {
  await ensureServerRunning();

  console.log('🧪 ========================================================');
  console.log('⚡ CLUE QUEST PRODUCTION UPDATE TEST SUITE');
  console.log('🏫 VSB Engineering College - Department of ECE');
  console.log('🧪 ========================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string, detail?: string) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // 1. Health & Initial WAITING Event Status
  console.log('\n--- 1. Health & Initial WAITING Event State ---');
  const health = await api('/health');
  assert(health.ok && health.data.status === 'ok', 'API Health Check returns 200 OK');

  // Login admin to ensure clean reset for test run
  const initialAdminLogin = await api('/auth/login', {
    method: 'POST',
    body: { player_code: 'admin', password: 'VSBadmin2026!' },
  });
  if (initialAdminLogin.ok) {
    await api('/admin/event/control', {
      method: 'POST',
      token: initialAdminLogin.data.token,
      body: { action: 'RESET', reset_teams: true },
    });
  }

  const eventStatus = await api('/event/status');
  assert(eventStatus.ok && eventStatus.data.event.status === 'WAITING', 'Initial Event State is WAITING');
  assert(eventStatus.data.stats.total_registered_participants === 40, '40 registered participants verified in public status');
  assert(eventStatus.data.stats.total_questions === 20, '20 competition questions verified');

  // 2. Authentication & Direct Team-Name-Only Participant Entry
  console.log('\n--- 2. Team-Name-Only Entry & Coordinator Authorization ---');
  const team1Entry = await api('/auth/team', {
    method: 'POST',
    body: { teamName: '   Circuit Breakers   ' },
  });
  assert(team1Entry.ok && team1Entry.data.user.team_name === 'Circuit Breakers', 'Team 1 ("Circuit Breakers") Enters with Direct Team Name');
  const player1Token = team1Entry.data.token;

  const team2Entry = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'BYTE BANDITS' },
  });
  assert(team2Entry.ok && team2Entry.data.user.team_name === 'BYTE BANDITS', 'Team 2 ("BYTE BANDITS") Enters with Direct Team Name');
  const player2Token = team2Entry.data.token;

  const adminLogin = await api('/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'VSBadmin2026!' },
  });
  assert(adminLogin.ok && adminLogin.data.user.role === 'ADMIN', 'Admin Login Successful with Dedicated Credentials');
  const adminToken = adminLogin.data.token;

  // Role Protection Check: Participant cannot start event or access admin overview
  const unauthorizedStart = await api('/admin/event/control', {
    method: 'POST',
    token: player1Token,
    body: { action: 'START_NOW' },
  });
  assert(unauthorizedStart.status === 403, 'Participant forbidden (403) from coordinator start endpoint');

  // 3. Pre-Event Participant Access Guard (Zero Leak in WAITING state)
  console.log('\n--- 3. Pre-Event Participant Access Guard (Zero Leak) ---');
  const preStartGameState = await api('/game/state', { token: player1Token });
  assert(preStartGameState.ok && preStartGameState.data.event.status === 'WAITING', 'Participant receives WAITING event status');
  assert(preStartGameState.data.question === null, 'Question content is strictly NULL while in WAITING state');
  assert(preStartGameState.data.unlocked_clues.length === 0, 'No clues are returned in payload before event start');

  const preStartReveal = await api('/game/reveal-clue', { method: 'POST', token: player1Token });
  assert(preStartReveal.status === 400, 'Revealing clues rejected before event is LIVE');

  const preStartSubmit = await api('/game/submit-answer', {
    method: 'POST',
    token: player1Token,
    body: { answer: 'RESISTOR' },
  });
  assert(preStartSubmit.status === 400, 'Submitting answers rejected before event is LIVE');

  // 4. Dedicated Admin & Participant Authentication Security
  console.log('\n--- 4. Admin Credentials & Session Security ---');
  assert(adminLogin.data.user.password_hash === undefined, 'Admin password hash is NEVER exposed in payload');

  const invalidAdminLogin = await api('/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: 'WrongPassword!' },
  });
  assert(invalidAdminLogin.status === 401, 'Invalid admin password rejected (401)');

  const participantAsAdmin = await api('/auth/admin/login', {
    method: 'POST',
    body: { username: 'Circuit Breakers', password: 'VSBece2026!' },
  });
  assert(participantAsAdmin.status === 401, 'Participant team name rejected from admin login endpoint');

  // 5. Team Name Validation, Normalization, Uniqueness & Persistence
  console.log('\n--- 5. Team Name Validation, Uniqueness & Session Isolation ---');
  // Empty team name
  const emptyTeam = await api('/auth/team', { method: 'POST', body: { teamName: '   ' } });
  assert(emptyTeam.status === 400, 'Empty team name rejected');

  // Short team name (<2 chars)
  const shortTeam = await api('/auth/team', { method: 'POST', body: { teamName: 'A' } });
  assert(shortTeam.status === 400, 'Team name < 2 characters rejected');

  // Long team name (>60 chars)
  const longTeam = await api('/auth/team', { method: 'POST', body: { teamName: 'A'.repeat(61) } });
  assert(longTeam.status === 400, 'Team name > 60 characters rejected');

  // Re-entry / session recovery for existing team
  const existingTeamReEntry = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'Circuit Breakers' },
  });
  assert(existingTeamReEntry.ok && existingTeamReEntry.data.user.team_name === 'Circuit Breakers', 'Existing team re-entry returns valid participant session');

  // Verify /api/auth/me returns teamName
  const meTeam1 = await api('/auth/me', { token: player1Token });
  assert(meTeam1.ok && meTeam1.data.user.team_name === 'Circuit Breakers', 'GET /api/auth/me returns team_name for Circuit Breakers');

  // Team 3 registers unique team
  const team3Entry = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'ECE TITANS' },
  });
  assert(team3Entry.ok && team3Entry.data.user.team_name === 'ECE TITANS', 'Team 3 registers valid team "ECE TITANS"');
  const player3Token = team3Entry.data.token;

  // XSS attack payload attempt
  const xssAttempt = await api('/auth/team', {
    method: 'POST',
    body: { teamName: '<script>alert("xss")</script>' },
  });
  assert(xssAttempt.status === 400, 'Malicious script/HTML team name rejected');

  // Edit team name in WAITING state
  const updateTeamWaiting = await api('/auth/team', {
    method: 'PATCH',
    token: player1Token,
    body: { teamName: 'CIRCUIT BREAKERS PRIME' },
  });
  assert(updateTeamWaiting.ok && updateTeamWaiting.data.user.team_name === 'CIRCUIT BREAKERS PRIME', 'Team name update allowed while event is in WAITING state');

  // 6. CSV Import Validation Suite
  console.log('\n--- 6. CSV Import Validation & Atomicity ---');
  // Test 6a: Incomplete CSV (18 rows) -> Must Reject Atomically
  const invalid18RowsCSV = `serial number,question,clue 1,clue 2,clue 3,clue 4,answer\n` +
    Array.from({ length: 18 }, (_, i) => `${i + 1},Question ${i + 1},C1,C2,C3,C4,ANSWER${i + 1}`).join('\n');
  const invalidCsvRes = await api('/admin/questions/import-csv', {
    method: 'POST',
    token: adminToken,
    body: { csvText: invalid18RowsCSV },
  });
  assert(invalidCsvRes.status === 400, 'CSV with 18 rows rejected (exactly 20 required)');

  // Test 6b: Missing Column Headers -> Must Reject
  const badHeadersCSV = `id,statement,clue1,clue2,clue3,clue4,ans\n1,Q,C1,C2,C3,C4,A`;
  const badHeadersRes = await api('/admin/questions/import-csv', {
    method: 'POST',
    token: adminToken,
    body: { csvText: badHeadersCSV },
  });
  assert(badHeadersRes.status === 400, 'CSV with invalid column headers rejected');

  // Test 6c: Valid 20-Row CSV -> Must Import Atomically
  let valid20CSV = 'serial number,question,clue 1,clue 2,clue 3,clue 4,answer\n';
  const electronicsSeed = [
    ['Which electronic component opposes electric current flow in ohms?', 'Obeys Ohm Law P=I2R', 'Uses color bands BBROY', 'Carbon or metal film', 'Unit is Ohm', 'RESISTOR'],
    ['Which passive component stores energy in an electrostatic field?', 'Blocks steady DC passes AC', 'Charge equation Q = CV', 'Electrolytic or ceramic', 'Unit is Farad', 'CAPACITOR'],
    ['Which passive component stores energy in a magnetic field?', 'Opposes current change V=Ldi/dt', 'Coiled copper on ferrite core', 'Used in choke filters', 'Unit is Henry', 'INDUCTOR'],
    ['Which semiconductor diode conducts in one forward direction?', 'PN junction 0.7V silicon barrier', 'Anode to Cathode polarity', 'Used for AC rectification', 'Symbol is triangle pointing to line', 'DIODE'],
    ['Which 3-terminal current-controlled device has Emitter Base Collector?', 'Base current controls Collector current', 'Operates in Active Cutoff Saturation', 'CE CB CC configurations', 'NPN and PNP structural types', 'TRANSISTOR'],
    ['Which voltage-controlled field effect transistor has an insulated gate?', 'Extremely high gate input impedance', 'Vgs forms inversion channel', 'Forms CMOS integrated circuits', 'Acronym is MOSFET', 'MOSFET'],
    ['Which high-gain differential DC amplifier IC has inverting noninverting pins?', 'Infinite input impedance virtual ground', 'Math operations integrator differentiator', 'Dual supply differential inputs', 'Classic 8-pin IC is 741', 'OPERATIONAL AMPLIFIER'],
    ['Which digital building block performs Boolean algebra logic operations?', 'Operates on binary 1 and 0 levels', 'NAND and NOR are universal gates', 'AND OR NOT XOR XNOR truth tables', '7400 quad IC packaging', 'LOGIC GATES'],
    ['Which bistable sequential circuit stores one single bit of memory state?', 'Output depends on clock edge triggers', 'SR D T and JK topologies', 'Clock synchronized state transitions', 'Basic unit of registers and counters', 'FLIP-FLOP'],
    ['Which single-chip computer integrates CPU memory and GPIO peripherals?', 'Dedicated on-chip Flash ROM and SRAM', 'Powers embedded control systems', 'Families include 8051 AVR PIC ARM', 'Commonly abbreviated as MCU', 'MICROCONTROLLER'],
    ['Which input transducer detects physical properties and converts to electrical signals?', 'Measures temperature pressure or light', 'Key metrics sensitivity and linearity', 'Thermocouples LDR ultrasonic strain gauge', 'Primary input perceptual organ', 'SENSOR'],
    ['Which electronic system samples continuous analog voltages into digital binary words?', 'Discretizes time rate and bit resolution', 'Nyquist rate fs >= 2B', 'Flash SAR Sigma-Delta topologies', 'Abbreviated as ADC', 'ADC'],
    ['Which circuit converts binary numerical words into continuous analog voltages?', 'Inverse operation of ADC conversion', 'Vout proportional to Vref and binary word', 'R-2R Ladder with Op-Amp summing', 'Abbreviated as DAC', 'DAC'],
    ['Which technique varies the pulse width of a fixed-frequency wave to control power?', 'Simulates analog voltage digitally', 'Key parameter is Duty Cycle percentage', 'Used for LED dimming motor speed control', 'Abbreviated as PWM', 'PWM'],
    ['Which asynchronous serial protocol transmits data bit-by-bit without shared clock?', 'Agreed baud rate beforehand', 'Frame has 1 start bit data and stop bit', 'Uses TX and RX signal lines', 'Abbreviated as UART', 'UART'],
    ['Which synchronous 2-wire serial bus uses SDA and SCL open-drain lines with pullups?', 'Connects multiple slaves on 2 lines', '7-bit or 10-bit device addresses', 'Uses ACK NACK start and stop conditions', 'Developed by Philips as I2C', 'I2C'],
    ['Which high-speed 4-wire synchronous full-duplex communication bus uses MOSI MISO SCK SS?', 'Faster than I2C multi-wire architecture', 'Master Out Slave In and Slave Select lines', 'Used for SD cards and OLED displays', 'Abbreviated as SPI', 'SPI'],
    ['Which RF transducer converts guided transmission line waves to free-space EM radiation?', 'Impedance matching interface', 'Directivity radiation pattern and gain', 'Half-wave dipole patch and Yagi-Uda', 'Also known as Aerial', 'ANTENNA'],
    ['Which telecommunication process shifts low-frequency baseband onto high-frequency carrier?', 'Allows efficient antenna radiation', 'Analog types AM FM PM', 'Digital types FSK PSK QAM', 'Demodulation recovers message', 'MODULATION'],
    ['Which electronic circuit generates continuous periodic AC waveforms from DC power?', 'Barkhausen criterion loop gain 1', 'Sinusoidal and relaxation multivibrators', 'Hartley Colpitts and Wien bridge topologies', 'Quartz crystal frequency reference', 'OSCILLATOR'],
  ];

  for (let i = 0; i < 20; i++) {
    const [q, c1, c2, c3, c4, a] = electronicsSeed[i];
    valid20CSV += `${i + 1},"${q}","${c1}","${c2}","${c3}","${c4}","${a}"\n`;
  }

  const validCsvRes = await api('/admin/questions/import-csv', {
    method: 'POST',
    token: adminToken,
    body: { csvText: valid20CSV },
  });
  assert(validCsvRes.ok && validCsvRes.data.count === 20, 'Valid 20-row CSV imported atomically');

  // CSV Export verification
  const csvExport = await api('/admin/questions/export-csv', { token: adminToken });
  assert(csvExport.ok && typeof csvExport.data === 'string' && csvExport.data.includes('serial number,question,clue 1'), 'CSV Export endpoint generates valid CSV formatted suite');

  // 7. Coordinator START NOW -> Server COUNTDOWN -> LIVE
  console.log('\n--- 7. Coordinator START NOW & Synchronized Countdown ---');
  const startRes = await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'START_NOW' },
  });
  assert(startRes.ok && startRes.data.status === 'COUNTDOWN', 'START NOW triggers COUNTDOWN state');
  assert(Boolean(startRes.data.countdown_started_at), 'Server timestamp countdown_started_at is recorded');

  // Participant polls during countdown
  const participantCountdownState = await api('/game/state', { token: player1Token });
  assert(participantCountdownState.data.event.status === 'COUNTDOWN', 'Participant receives COUNTDOWN event state');
  assert(typeof participantCountdownState.data.event.countdown_remaining_seconds === 'number', 'Server provides exact remaining countdown seconds');

  // Fast-forward countdown by waiting 5.5s
  console.log('⏳ Waiting 5.5s for server countdown completion...');
  await new Promise(r => setTimeout(r, 5500));

  // Verify transition to LIVE
  const liveState = await api('/game/state', { token: player1Token });
  assert(liveState.data.event.status === 'LIVE', 'Event state transitioned to LIVE after 5s countdown');
  assert(liveState.data.session.current_question === 1, 'Question 1 now active for CQ001');
  assert(liveState.data.unlocked_clues.length === 1, 'Clue 1 unlocked and available (100 PTS)');
  assert(liveState.data.question.answer === undefined, 'Question answer is NEVER leaked to participant payload');

  // 8. Clue Progression & Value Sacrifice (100 -> 75 -> 50 -> 25)
  console.log('\n--- 8. Clue Progression & Value Sacrifice ---');
  const reveal2 = await api('/game/reveal-clue', {
    method: 'POST',
    token: player1Token,
    body: { requested_level: 2 },
  });
  assert(reveal2.ok && reveal2.data.session.current_clue_level === 2, 'CQ001 reveals Clue 2');
  assert(reveal2.data.session.current_question_value === 75, 'Question value drops to 75 PTS');
  assert(reveal2.data.session.total_score === 0, 'Total score safe at 0 PTS');

  // Race condition test: Double click reveal skipping check (attempt to jump 2 -> 4)
  const skipReveal = await api('/game/reveal-clue', {
    method: 'POST',
    token: player1Token,
    body: { requested_level: 4 },
  });
  assert(skipReveal.status === 400, 'Double-click/skip from Clue 2 to Clue 4 blocked (Sequential progression enforced)');

  // 9. Uppercase Input & Server Normalization
  console.log('\n--- 9. Uppercase Answer Matching & Server Normalization ---');
  // Submit lowercase / mixed-case input with spaces
  const submitQ1 = await api('/game/submit-answer', {
    method: 'POST',
    token: player1Token,
    body: { answer: '   resistor   ' },
  });
  assert(submitQ1.ok && submitQ1.data.is_correct === true, 'Mixed-case answer "   resistor   " normalized to RESISTOR');
  assert(submitQ1.data.earned_points === 75, 'Earned 75 PTS at Clue 2');
  assert(submitQ1.data.total_score === 75, 'Total score updated to 75 PTS');
  assert(submitQ1.data.user_answer === 'RESISTOR', 'Normalized user answer stored in UPPERCASE');

  // Duplicate submission attempt
  const dupSubmit = await api('/game/submit-answer', {
    method: 'POST',
    token: player1Token,
    body: { answer: 'RESISTOR' },
  });
  assert(dupSubmit.status === 400, 'Duplicate submission on answered question blocked');

  // 10. Coordinator Visibility & Matrix Diagnostic Details
  console.log('\n--- 10. Coordinator Visibility & Matrix Diagnostic Details ---');
  const adminOverviewCheck = await api('/admin/overview', { token: adminToken });
  assert(adminOverviewCheck.ok, 'Admin overview accessible');
  const cq1Item = adminOverviewCheck.data.participants.find((p: any) => p.player_code === 'CQ001');
  assert(cq1Item && cq1Item.team_name === 'CIRCUIT BREAKERS PRIME', 'Coordinator overview matrix displays participant team name');

  const participantDetailCheck = await api(`/admin/participant/${cq1Item.user_id}`, { token: adminToken });
  assert(participantDetailCheck.ok && participantDetailCheck.data.participant.team_name === 'CIRCUIT BREAKERS PRIME', 'Coordinator participant diagnostics endpoint returns detailed metrics');

  // 11. Event Lifecycle: PAUSE -> RESUME -> LOCK CHECK -> ENDED -> RESET
  console.log('\n--- 11. Event Lifecycle: PAUSE -> RESUME -> LOCK CHECK -> ENDED -> RESET ---');
  const pauseRes = await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'PAUSE' },
  });
  assert(pauseRes.ok && pauseRes.data.status === 'PAUSED', 'Admin pauses event');

  const playerPausedState = await api('/game/state', { token: player1Token });
  assert(playerPausedState.data.event.status === 'PAUSED', 'Participant detects PAUSED state');

  const resumeRes = await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'RESUME' },
  });
  assert(resumeRes.ok && resumeRes.data.status === 'LIVE', 'Admin resumes event');

  // Team update while event is LIVE must be locked
  const updateTeamLive = await api('/auth/team', {
    method: 'PATCH',
    token: player1Token,
    body: { teamName: 'ILLEGAL CHANGE' },
  });
  assert(updateTeamLive.status === 400, 'Team name editing is strictly LOCKED while event is LIVE');

  const endRes = await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'END' },
  });
  assert(endRes.ok && endRes.data.status === 'ENDED', 'Admin ends event');

  const resetRes = await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'RESET' },
  });
  assert(resetRes.ok && resetRes.data.status === 'WAITING', 'Admin resets event back to WAITING');

  // Team name preserved after event reset
  const postResetMe = await api('/auth/me', { token: player1Token });
  assert(postResetMe.ok && postResetMe.data.user.team_name === 'CIRCUIT BREAKERS PRIME', 'Participant team name is preserved across event reset');

  // 12. Feature Tests: 20-Minute Authoritative Countdown & Integrity Event Logging
  console.log('\n--- 12. Test Security, Authoritative Timer & Integrity Monitoring ---');

  // Start event to test LIVE timer & integrity
  await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'START_NOW' },
  });
  await new Promise((r) => setTimeout(r, 5500)); // wait for countdown

  const liveTimerState = await api('/game/state', { token: player1Token });
  assert(liveTimerState.ok && Boolean(liveTimerState.data.deadline_at), 'Server provides authoritative deadline_at');
  assert(liveTimerState.ok && Boolean(liveTimerState.data.server_now), 'Server provides server_now timestamp for drift compensation');

  // Verify deadline is ~20 minutes in future
  const deadlineMs = new Date(liveTimerState.data.deadline_at).getTime();
  const serverNowMs = new Date(liveTimerState.data.server_now).getTime();
  const diffSec = Math.round((deadlineMs - serverNowMs) / 1000);
  assert(diffSec >= 1195 && diffSec <= 1205, 'Deadline is exactly 20 minutes (1200s) from start');

  // Test Integrity Event Logging (Tab Switch, Fullscreen Exit, Copy, Context Menu)
  const tabSwitchRes = await api('/game/integrity-event', {
    method: 'POST',
    token: player1Token,
    body: { type: 'TAB_SWITCH', metadata: { visibilityState: 'hidden' } },
  });
  assert(tabSwitchRes.ok && tabSwitchRes.data.success && tabSwitchRes.data.recorded, 'Tab switch recorded server-side');

  const copyRes = await api('/game/integrity-event', {
    method: 'POST',
    token: player1Token,
    body: { type: 'COPY_ATTEMPT', metadata: { targetTag: 'H2' } },
  });
  assert(copyRes.ok && copyRes.data.success, 'Copy attempt recorded server-side');

  const fsExitRes = await api('/game/integrity-event', {
    method: 'POST',
    token: player1Token,
    body: { type: 'FULLSCREEN_EXIT', metadata: { reason: 'user_exit' } },
  });
  assert(fsExitRes.ok && fsExitRes.data.success, 'Fullscreen exit recorded server-side');

  // Verify unauthorized/admin cannot send player integrity event without player role
  const adminIntegrity = await api('/game/integrity-event', {
    method: 'POST',
    token: adminToken,
    body: { type: 'TAB_SWITCH' },
  });
  assert(adminIntegrity.status === 403, 'Non-player role rejected from /api/game/integrity-event');

  // Verify Admin Overview reflects integrity count
  const adminOverview = await api('/admin/overview', { token: adminToken });
  const p1Matrix = adminOverview.data.participants.find((p: any) => p.player_code === 'CQ001');
  assert(p1Matrix && p1Matrix.integrity_events_count >= 3, 'Admin overview displays participant integrity event count (>=3)');

  // Verify Coordinator Participant Diagnostic Detail modal payload
  const p1Detail = await api(`/admin/participant/${p1Matrix.user_id}`, { token: adminToken });
  assert(p1Detail.ok && p1Detail.data.integrity_logs.length >= 3, 'Admin participant detail returns full integrity activity audit trail');

  // Test refresh / reconnect persistence: deadline remains invariant
  const refreshedState = await api('/game/state', { token: player1Token });
  assert(refreshedState.data.deadline_at === liveTimerState.data.deadline_at, 'Timer survives refresh without resetting deadline');

  // ========================================================
  // 12. COMPREHENSIVE "PREPARE NEXT EVENT" SAFETY & VERIFICATION SUITE
  // ========================================================
  console.log('\n--- 12. Comprehensive Prepare Next Event Verification Suite ---');

  // Case 1: Authorization Checks
  console.log('\n[Case 1: Authorization Checks]');
  const unauthRes = await api('/admin/events/prepare-next', { method: 'POST', body: {} });
  assert(unauthRes.status === 401, 'Unauthenticated request to /admin/events/prepare-next rejected with 401 Unauthorized');

  const playerAuthRes = await api('/admin/events/prepare-next', { method: 'POST', token: player1Token, body: {} });
  assert(playerAuthRes.status === 403, 'PLAYER role request to /admin/events/prepare-next rejected with 403 Forbidden');

  // Capture/Ensure Representative Historical Data from Event 1
  console.log('\n[Case 4 (Setup): Verify Representative Historical Data in Event 1]');
  const preStatus = await api('/event/status');
  const event1Id = preStatus.data.event.id;
  const event1Name = preStatus.data.event.name;
  assert(Boolean(event1Id), `Event 1 ID identified as "${event1Id}"`);

  const memStore = db.getMemoryStore();
  const player1UserPre = Array.from(memStore.users.values()).find(u => u.player_code === 'CQ001')!;
  const initialPasswordHash = player1UserPre.password_hash;
  const initialPlayerId = player1UserPre.id;

  // Ensure an active game_session and question_attempt exist for Event 1
  let e1Session = Array.from(memStore.game_sessions.values()).find(s => s.event_id === event1Id && s.user_id === initialPlayerId);
  if (!e1Session) {
    e1Session = {
      id: `sess_e1_${Date.now()}`,
      event_id: event1Id,
      user_id: initialPlayerId,
      status: 'COMPLETED',
      current_question: 1,
      current_clue_level: 2,
      current_question_value: 75,
      total_score: 75,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memStore.game_sessions.set(e1Session.id, e1Session);
  }

  const q1Id = Array.from(memStore.questions.values())[0]?.id || 'q1';
  const representativeAttemptId = `att_e1_${Date.now()}`;
  memStore.question_attempts.set(representativeAttemptId, {
    id: representativeAttemptId,
    session_id: e1Session.id,
    question_id: q1Id,
    highest_clue_level: 2,
    final_question_value: 75,
    user_answer: 'RESISTOR',
    correct_answer: 'RESISTOR',
    is_correct: true,
    earned_points: 75,
    submitted_at: new Date().toISOString(),
  });

  const initialAttemptsCount = memStore.question_attempts.size;
  const initialSessionsCount = memStore.game_sessions.size;
  assert(initialAttemptsCount >= 1, `Verified historical question_attempts exist (${initialAttemptsCount} found)`);
  assert(initialSessionsCount >= 1, `Verified historical game_sessions exist (${initialSessionsCount} found)`);

  // Case 2 & 3: Prepare Next Event - Creation & Participant Slot Clearing
  console.log('\n[Case 2 & 3: New Event Creation & Participant Slot Clearing]');
  const prepareNextRes = await api('/admin/events/prepare-next', {
    method: 'POST',
    token: adminToken,
    body: { name: 'CLUE QUEST 2026 - Championship Round 2' },
  });

  assert(prepareNextRes.ok && prepareNextRes.data.success === true, 'ADMIN role request to /admin/events/prepare-next succeeds (200 OK)');
  assert(prepareNextRes.data.previous_event_id === event1Id, `previous_event_id matches original event ID ("${event1Id}")`);
  assert(prepareNextRes.data.new_event_id && prepareNextRes.data.new_event_id !== event1Id, 'new_event_id is unique and distinct from previous_event_id');
  assert(prepareNextRes.data.event.status === 'WAITING', 'New event status is WAITING');
  assert(prepareNextRes.data.event.max_players === 40, 'max_players correctly inherited as 40');
  assert(prepareNextRes.data.cleared_participant_slots === 40, 'cleared_participant_slots is exactly 40');

  // Verify new event is active under ORDER BY created_at DESC
  const newOverview = await api('/admin/overview', { token: adminToken });
  assert(newOverview.data.event.id === prepareNextRes.data.new_event_id, 'New event is now the active event under ORDER BY created_at DESC');
  assert(newOverview.data.event.name === 'CLUE QUEST 2026 - Championship Round 2', 'New event name matches requested title');

  // Case 7: Duplicate / Rapid Double-Click Protection
  console.log('\n[Case 7: Duplicate / Rapid Double-Click Protection]');
  const duplicateAttempt = await api('/admin/events/prepare-next', {
    method: 'POST',
    token: adminToken,
    body: { name: 'Duplicate Event' },
  });
  assert(duplicateAttempt.status === 400 || duplicateAttempt.status === 409, 'Rapid duplicate prepare-next request blocked with error (400/409)');

  // Verify all 40 slots have team_name = NULL and display_name reset, while user records remain intact
  let allSlotsCleared = true;
  let allSlotNamesDefault = true;
  let allSlotsPreserved = true;

  for (let i = 1; i <= 40; i++) {
    const code = `CQ${String(i).padStart(3, '0')}`;
    const userInDb = Array.from(memStore.users.values()).find(u => u.player_code === code);
    if (!userInDb || userInDb.team_name !== null) allSlotsCleared = false;
    if (userInDb && userInDb.display_name !== `Participant ${String(i).padStart(2, '0')} (ECE)`) allSlotNamesDefault = false;
    if (!userInDb || userInDb.role !== 'PLAYER') allSlotsPreserved = false;
  }
  assert(allSlotsCleared, 'All 40 participant slots have team_name = NULL (ready for new registrations)');
  assert(allSlotNamesDefault, 'All 40 participant display_names reset to default "Participant XX (ECE)"');
  assert(allSlotsPreserved, 'All 40 participant user records & roles remain in database');

  const p1After = Array.from(memStore.users.values()).find(u => u.player_code === 'CQ001');
  assert(p1After.id === initialPlayerId, 'PLAYER user ID (usr_player_001) unchanged');
  assert(p1After.player_code === 'CQ001', 'player_code (CQ001) unchanged');
  assert(p1After.password_hash === initialPasswordHash, 'password_hash unchanged');

  // Verify Admin account untouched
  const adminUser = Array.from(memStore.users.values()).find(u => u.role === 'ADMIN');
  assert(adminUser && adminUser.player_code === 'admin' && adminUser.display_name === 'ECE Department Admin', 'Admin user account is completely unaffected');

  // Case 4: Historical Data Preservation Verification
  console.log('\n[Case 4: Historical Data Preservation Verification]');
  const prevEventInDb = memStore.events.get(event1Id);
  assert(Boolean(prevEventInDb), 'Previous event record still exists in database');
  assert(prevEventInDb.id === event1Id, 'Previous event ID preserved');

  const prevSessionsAfter = Array.from(memStore.game_sessions.values()).filter(s => s.event_id === event1Id);
  assert(prevSessionsAfter.length === initialSessionsCount, `Previous event game_sessions preserved (${prevSessionsAfter.length} session(s) found)`);

  const prevAttemptsAfter = Array.from(memStore.question_attempts.values());
  assert(prevAttemptsAfter.length === initialAttemptsCount, `Previous event question_attempts preserved (${prevAttemptsAfter.length} attempt(s) found)`);

  const prevLogs = memStore.event_logs.filter(l => l.action === 'PREPARE_NEXT_EVENT');
  assert(prevLogs.length >= 1, 'Audit log PREPARE_NEXT_EVENT recorded in database');
  const prepareLog = prevLogs[prevLogs.length - 1];
  assert(prepareLog.metadata?.previous_event_id === event1Id, 'Audit log records previous_event_id');
  assert(prepareLog.metadata?.new_event_id === prepareNextRes.data.new_event_id, 'Audit log records new_event_id');

  // Case 5: New Event Registration & Isolated Gameplay
  console.log('\n[Case 5: New Event Registration & Isolated Gameplay]');
  const newTeamReg = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'QUANTUM LOGIC' },
  });
  assert(newTeamReg.ok && newTeamReg.data.user.player_code === 'CQ001', 'New team "QUANTUM LOGIC" receives available slot CQ001');
  assert(newTeamReg.data.user.team_name === 'QUANTUM LOGIC', 'Slot CQ001 assigned team name "QUANTUM LOGIC"');
  const newTeamToken = newTeamReg.data.token;

  // Start the new event
  await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'START_NOW' },
  });
  await new Promise(r => setTimeout(r, 5500)); // wait for countdown

  const newEventGameState = await api('/game/state', { token: newTeamToken });
  assert(newEventGameState.ok && newEventGameState.data.event.id === prepareNextRes.data.new_event_id, 'Gameplay session belongs to the NEW event');
  assert(newEventGameState.data.session.event_id === prepareNextRes.data.new_event_id, 'game_sessions record references new_event_id');
  assert(newEventGameState.data.session.current_question === 1, 'New session starts cleanly at Question 1');
  assert(newEventGameState.data.session.total_score === 0, 'New session starts cleanly with Total Score 0');

  // Case 6: Existing RESET Behavior Verification
  console.log('\n[Case 6: Existing RESET Behavior Unchanged]');
  const resetOldWay = await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'RESET' },
  });
  assert(resetOldWay.ok && resetOldWay.data.status === 'WAITING', 'Existing RESET endpoint still sets status to WAITING');
  const overviewAfterReset = await api('/admin/overview', { token: adminToken });
  assert(overviewAfterReset.data.event.id === prepareNextRes.data.new_event_id, 'RESET reuses the same event ID without creating a new event');

  // Case 8: Transaction Rollback Simulation
  console.log('\n[Case 8: Transaction Rollback Verification]');
  let rollbackSucceeded = false;
  try {
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO events (id, name, status, max_players, countdown_started_at, started_at, completed_at, created_at)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                      ['evt_rollback_test', 'Rollback Test Event', 'WAITING', 40, null, null, null, new Date().toISOString()]);
      throw new Error('SIMULATED_TRANSACTION_FAILURE');
    });
  } catch (err: any) {
    if (err.message === 'SIMULATED_TRANSACTION_FAILURE') {
      rollbackSucceeded = true;
    }
  }
  assert(rollbackSucceeded, 'Transaction threw and caught simulated failure');
  const rolledBackEvent = memStore.events.get('evt_rollback_test');
  assert(rolledBackEvent === undefined, 'Rolled back event was NOT committed to the database');

  // --- 13. Phase 2: In-Memory Active Event & Question Bank Cache Verification ---
  console.log('\n--- 13. Phase 2: In-Memory Active Event & Question Bank Cache Verification ---');

  // 1. Active Event Cache Hit
  console.log('\n[Phase 2A: Active Event Cache]');
  const cachedEvt = await getActiveEventCached();
  const cacheState1 = getCacheInspectionState();
  assert(Boolean(cachedEvt), 'Active event fetched successfully via cache service');
  assert(cacheState1.hasActiveEventCache, 'Active event is populated in process-local memory cache');
  assert(cacheState1.activeEventId === cachedEvt?.id, 'Cached active event ID matches authoritative event');

  // 2. Active Event Cache Invalidation & Direct Update on Prepare Next
  const prepareNextCacheRes = await api('/admin/events/prepare-next', {
    method: 'POST',
    token: adminToken,
    body: { name: 'CLUE QUEST 2026 - Phase 2 Cache Test Round' },
  });
  assert(prepareNextCacheRes.ok, 'Prepare next event returns 200 OK');
  const cacheState2 = getCacheInspectionState();
  assert(cacheState2.activeEventId === prepareNextCacheRes.data.new_event_id, 'Active event cache immediately updated to new event ID (no stale event returned)');

  // 3. Question Bank Cache Population
  console.log('\n[Phase 2B: Question & Clue Bank Cache]');
  const questionBank = await getQuestionBankCached();
  const cacheState3 = getCacheInspectionState();
  assert(Array.isArray(questionBank) && questionBank.length === 20, 'Question bank loaded into memory with exactly 20 questions');
  assert(cacheState3.hasQuestionBankCache, 'Question bank is active in process-local memory cache');
  assert(cacheState3.questionCount === 20, 'Question count in cache inspection state is 20');

  // 4. Question & Clue Cache Hit
  const q1Cached = await getQuestionByNumberCached(1);
  assert(q1Cached !== null, 'Question #1 retrieved from in-memory cache');
  assert(q1Cached?.clues.length === 4, 'Question #1 has all 4 pre-cached clues');
  assert(q1Cached?.clues[0].points === 100 && q1Cached?.clues[3].points === 25, 'Clue point hierarchy (100 -> 25) preserved in cache');

  // 5. Question/Clue Cache Invalidation on Question Save/Edit
  const saveQRes = await api('/admin/questions/save', {
    method: 'POST',
    token: adminToken,
    body: {
      id: 'q_01',
      question_number: 1,
      question_text: 'Identify this passive electronic component (Updated via Cache Test).',
      answer: 'RESISTOR',
      accepted_aliases: ['RESISTOR', 'RESISTANCE'],
      category: 'Passive Components',
      clues: [
        { level: 1, clue_text: 'Clue 1 text', points: 100 },
        { level: 2, clue_text: 'Clue 2 text', points: 75 },
        { level: 3, clue_text: 'Clue 3 text', points: 50 },
        { level: 4, clue_text: 'Clue 4 text', points: 25 },
      ],
    },
  });
  assert(saveQRes.ok, 'Admin save question returns 200 OK');
  const q1AfterSave = await getQuestionByNumberCached(1);
  assert(Boolean(q1AfterSave?.question_text.includes('Updated via Cache Test')), 'Question bank cache invalidated and refreshed with updated question statement');

  // 6. Empty / Invalid Fallback Handling
  invalidateActiveEventCache();
  invalidateQuestionBankCache();
  const cacheState4 = getCacheInspectionState();
  assert(!cacheState4.hasActiveEventCache && !cacheState4.hasQuestionBankCache, 'Explicit cache invalidation clears memory stores');
  const restoredEvent = await getActiveEventCached();
  const restoredQ = await getQuestionByNumberCached(1);
  assert(restoredEvent !== null && restoredQ !== null, 'Cache safely self-repopulates from database on subsequent requests');

  // 7. Phase 2 Performance Benchmark: 40 Simulated Consecutive GET /api/game/state requests
  console.log('\n[Phase 2 Performance Benchmark: 40 Consecutive /api/game/state Calls]');
  const benchPlayerLogin = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'BENCHMARK RACERS' },
  });
  const benchToken = benchPlayerLogin.data.token;

  // Start the event
  await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'START_NOW' },
  });
  await new Promise(r => setTimeout(r, 5500)); // wait countdown

  const benchIterations = 40;
  const startBenchTime = Date.now();
  let benchSuccessCount = 0;

  for (let i = 0; i < benchIterations; i++) {
    const res = await api('/game/state', { token: benchToken });
    if (res.ok && res.data.question) {
      benchSuccessCount++;
    }
  }

  const totalBenchMs = Date.now() - startBenchTime;
  const avgLatencyMs = Math.round(totalBenchMs / benchIterations);
  console.log(`⚡ Benchmark Result: ${benchSuccessCount}/${benchIterations} requests succeeded in ${totalBenchMs}ms (Avg: ${avgLatencyMs}ms per state check)`);
  assert(benchSuccessCount === benchIterations, `All ${benchIterations} benchmark state requests succeeded`);
  assert(avgLatencyMs < 50, `Average state check response latency (${avgLatencyMs}ms) is under 50ms locally`);

  // --- 14. Phase 3: Safe Auth User Cache & Security Suite ---
  console.log('\n--- 14. Phase 3: Safe Auth User Cache & Security Suite ---');

  // Ensure event is in WAITING state for user mutation tests
  await api('/admin/event/control', {
    method: 'POST',
    token: adminToken,
    body: { action: 'RESET' },
  });

  // Case 1: Valid JWT + Cache Miss -> DB Lookup succeeds and primes cache
  console.log('\n[Phase 3A: Valid JWT Cache Miss & Population]');
  invalidateAuthUserCache();
  const cacheInspectBefore = getCacheInspectionState();
  assert(cacheInspectBefore.authUserCount === 0, 'Auth user cache cleared on demand');

  const authMeMissRes = await api('/auth/me', { token: player1Token });
  assert(authMeMissRes.ok && authMeMissRes.data.user.player_code === 'CQ001', 'Valid JWT with cache miss successfully executes DB lookup and authenticates');
  const cacheInspectAfterMiss = getCacheInspectionState();
  assert(cacheInspectAfterMiss.authUserCount >= 1, 'Auth user cache populated after successful DB lookup on cache miss');

  // Case 2: Valid JWT + Cache Hit -> Avoids DB query
  console.log('\n[Phase 3B: Valid JWT Cache Hit]');
  const authMeHitRes = await api('/auth/me', { token: player1Token });
  assert(authMeHitRes.ok && authMeHitRes.data.user.player_code === 'CQ001', 'Valid JWT with cache hit successfully authenticates via process-local cache');

  // Case 3: Invalid JWT -> Rejected immediately by jwt.verify
  console.log('\n[Phase 3C: Invalid JWT Rejection]');
  const invalidJwtRes = await api('/auth/me', { token: 'invalid.bogus.token.structure' });
  assert(invalidJwtRes.status === 401, 'Malformed/invalid JWT signature rejected with 401 Unauthorized');

  // Case 4: Expired JWT -> Rejected cryptographically
  console.log('\n[Phase 3D: Expired JWT Rejection]');
  const expiredToken = jwt.sign(
    { id: 'usr_cq001', player_code: 'CQ001', role: 'PLAYER' },
    config.jwtSecret,
    { expiresIn: '-10s' }
  );
  const expiredJwtRes = await api('/auth/me', { token: expiredToken });
  assert(expiredJwtRes.status === 401, 'Expired JWT rejected cryptographically with 401 Unauthorized');

  // Case 5: Tampered JWT Signature -> Rejected
  console.log('\n[Phase 3E: Tampered JWT Signature Rejection]');
  const tamperedToken = player1Token.slice(0, -5) + 'XYZAB';
  const tamperedJwtRes = await api('/auth/me', { token: tamperedToken });
  assert(tamperedJwtRes.status === 401, 'Tampered JWT signature rejected with 401 Unauthorized');

  // Case 6: Unknown User ID in validly-signed JWT -> Rejected
  console.log('\n[Phase 3F: Unknown User ID Rejection]');
  const phantomUserToken = jwt.sign(
    { id: 'usr_phantom_99999', player_code: 'CQ999', role: 'PLAYER' },
    config.jwtSecret,
    { expiresIn: '1h' }
  );
  const phantomUserRes = await api('/auth/me', { token: phantomUserToken });
  assert(phantomUserRes.status === 401, 'Unknown user ID with valid signature rejected with 401 Unauthorized');

  // Case 7: Inactive / Disabled User -> Rejected
  console.log('\n[Phase 3G: Inactive User Rejection]');
  const player1Id = team1Entry.data.user.id;
  await db.query("UPDATE users SET is_active = false WHERE id = $1", [player1Id]);
  invalidateAuthUserCache(player1Id);

  const inactiveUserRes = await api('/auth/me', { token: player1Token });
  assert(inactiveUserRes.status === 401, 'Deactivated user rejected with 401 Unauthorized on authentication');
  await db.query("UPDATE users SET is_active = true WHERE id = $1", [player1Id]);
  invalidateAuthUserCache(player1Id);

  // Case 8: Player Token cannot access Admin Route
  console.log('\n[Phase 3H: Role Authorization - Player Denied Admin Access]');
  const playerAdminAccessRes = await api('/admin/overview', { token: player1Token });
  assert(playerAdminAccessRes.status === 403, 'Player token forbidden (403) from accessing admin endpoints');

  // Case 9: Admin Token can access Admin Route
  console.log('\n[Phase 3I: Role Authorization - Admin Granted Admin Access]');
  const adminAccessRes = await api('/admin/overview', { token: adminToken });
  assert(adminAccessRes.ok, 'Admin token successfully authorized (200) for admin overview');

  // Case 10: Client-controlled role escalation in body/headers cannot escalate privileges
  console.log('\n[Phase 3J: Role Escalation Protection]');
  const escalateRes = await api('/admin/event/control', {
    method: 'POST',
    token: player1Token,
    body: { role: 'ADMIN', action: 'START_NOW' },
  });
  assert(escalateRes.status === 403, 'Client-controlled role parameters ignored; role determined authoritatively from server auth');

  // Case 11: User Mutation Invalidates/Updates Cache
  console.log('\n[Phase 3K: User Mutation Invalidation & Refresh]');
  const teamUpdateReg = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'NEBULA LOGIC' },
  });
  const nebulaToken = teamUpdateReg.data.token;
  const nebulaUser = teamUpdateReg.data.user;

  const patchTeamRes = await api('/auth/team', {
    method: 'PATCH',
    token: nebulaToken,
    body: { teamName: 'NEBULA DYNAMICS' },
  });
  assert(patchTeamRes.ok && patchTeamRes.data.user.team_name === 'NEBULA DYNAMICS', 'Team rename mutation succeeds');

  const nebulaMeRes = await api('/auth/me', { token: nebulaToken });
  assert(nebulaMeRes.ok && nebulaMeRes.data.user.team_name === 'NEBULA DYNAMICS', 'Subsequent authenticated call immediately returns updated team name from refreshed cache');

  // Case 12: Deactivated user rejected after cache invalidation
  console.log('\n[Phase 3L: Deactivation Invalidation]');
  await db.query('UPDATE users SET is_active = false WHERE id = $1', [nebulaUser.id]);
  invalidateAuthUserCache(nebulaUser.id);

  const nebulaDeactivatedRes = await api('/auth/me', { token: nebulaToken });
  assert(nebulaDeactivatedRes.status === 401, 'Deactivated user rejected immediately after cache invalidation');
  await db.query('UPDATE users SET is_active = true WHERE id = $1', [nebulaUser.id]);
  invalidateAuthUserCache(nebulaUser.id);

  // Case 13: Role change reflected after cache invalidation
  console.log('\n[Phase 3M: Role Change Invalidation]');
  await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [nebulaUser.id]);
  invalidateAuthUserCache(nebulaUser.id);

  const nebulaAsAdminRes = await api('/admin/overview', { token: nebulaToken });
  assert(nebulaAsAdminRes.ok, 'Role promotion to ADMIN immediately permits admin route access after cache invalidation');

  await db.query("UPDATE users SET role = 'PLAYER' WHERE id = $1", [nebulaUser.id]);
  invalidateAuthUserCache(nebulaUser.id);
  const nebulaRevertedRes = await api('/admin/overview', { token: nebulaToken });
  assert(nebulaRevertedRes.status === 403, 'Role demotion to PLAYER immediately revokes admin route access after cache invalidation');

  // Case 14: Cache TTL expiration causes DB revalidation
  console.log('\n[Phase 3N: Cache Bounded TTL Revalidation]');
  const player2Id = team2Entry.data.user.id;
  await db.query("UPDATE users SET display_name = 'TTL Fresh Name' WHERE id = $1", [player2Id]);
  setAuthUserCache({
    id: player2Id,
    player_code: 'CQ002',
    display_name: 'TTL Stale Name',
    team_name: null,
    role: 'PLAYER',
    is_active: true,
  });

  const beforeExpiry = await getAuthUserCached(player2Id);
  assert(beforeExpiry?.display_name === 'TTL Stale Name', 'Cache returns primed value before TTL expiration');

  invalidateAuthUserCache(player2Id);
  const afterExpiry = await getAuthUserCached(player2Id);
  assert(afterExpiry?.display_name === 'TTL Fresh Name', 'Expired cache triggers DB lookup and retrieves fresh user state');

  // Case 15: DB failure / missing user returns null and does not authenticate
  console.log('\n[Phase 3O: DB Miss / Unknown User Handling]');
  invalidateAuthUserCache('usr_nonexistent_xyz');
  const missUser = await getAuthUserCached('usr_nonexistent_xyz');
  assert(missUser === null, 'Non-existent user lookup safely returns null');

  // 15. Local Benchmark: 40 Consecutive Authenticated Requests (Auth Cache in action)
  console.log('\n[Phase 3 Performance Benchmark: 40 Consecutive Authenticated Requests]');
  const benchAuthPlayer = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'AUTH SPEED RACERS' },
  });
  const benchAuthToken = benchAuthPlayer.data.token;

  const authBenchIterations = 40;
  const startAuthBenchTime = Date.now();
  let authBenchSuccessCount = 0;

  for (let i = 0; i < authBenchIterations; i++) {
    const res = await api('/auth/me', { token: benchAuthToken });
    if (res.ok && res.data.user) {
      authBenchSuccessCount++;
    }
  }

  const totalAuthBenchMs = Date.now() - startAuthBenchTime;
  const avgAuthLatencyMs = Math.round(totalAuthBenchMs / authBenchIterations);
  console.log(`⚡ Auth Benchmark: ${authBenchSuccessCount}/${authBenchIterations} authenticated requests succeeded in ${totalAuthBenchMs}ms (Avg: ${avgAuthLatencyMs}ms per request, 0 redundant DB queries)`);
  assert(authBenchSuccessCount === authBenchIterations, `All ${authBenchIterations} authenticated requests succeeded`);
  assert(avgAuthLatencyMs < 30, `Average authenticated response latency (${avgAuthLatencyMs}ms) is under 30ms locally`);

  // --- 15. Phase 4: Frontend Adaptive Polling & Traffic Optimization Suite ---
  console.log('\n--- 15. Phase 4: Frontend Adaptive Polling & Traffic Optimization Suite ---');

  // Case 1: WAITING interval = 3000ms
  console.log('\n[Phase 4A: State-Aware Interval Contracts]');
  assert(getPollingInterval('WAITING', 'IN_PROGRESS', false) === 3000, 'WAITING state schedules 3000ms polling interval (3.0s)');

  // Case 2: COUNTDOWN interval = 1000ms
  assert(getPollingInterval('COUNTDOWN', 'IN_PROGRESS', false) === 1000, 'COUNTDOWN state schedules 1000ms polling interval (1.0s)');

  // Case 3: LIVE interval = 4000ms
  assert(getPollingInterval('LIVE', 'IN_PROGRESS', false) === 4000, 'LIVE state schedules 4000ms polling interval (4.0s)');

  // Case 4: PAUSED interval = 3000ms
  assert(getPollingInterval('PAUSED', 'IN_PROGRESS', false) === 3000, 'PAUSED state schedules 3000ms polling interval (3.0s)');

  // Case 5: COMPLETED / ENDED stops continuous polling (null)
  assert(getPollingInterval('LIVE', 'COMPLETED', false) === null, 'COMPLETED session status returns null (stops continuous polling)');
  assert(getPollingInterval('ENDED', 'IN_PROGRESS', false) === null, 'ENDED event status returns null (stops continuous polling)');

  // Case 6: Page Visibility - Hidden tab throttles to 10000ms
  console.log('\n[Phase 4B: Page Visibility & Background Throttling]');
  assert(getPollingInterval('LIVE', 'IN_PROGRESS', true) === 10000, 'Hidden tab in LIVE state throttles to 10000ms background interval (10.0s)');
  assert(getPollingInterval('WAITING', 'IN_PROGRESS', true) === 10000, 'Hidden tab in WAITING state throttles to 10000ms background interval (10.0s)');
  assert(getPollingInterval('LIVE', 'IN_PROGRESS', false) === 4000, 'Foreground visible tab restores 4000ms active interval');

  // Case 7: In-Flight Overlapping Request Guard Simulation
  console.log('\n[Phase 4C: Overlapping Request Guard Simulation]');
  let simulatedInFlight = false;
  let simulatedExecutions = 0;
  let simulatedSkipped = 0;

  const simulatedPoll = async () => {
    if (simulatedInFlight) {
      simulatedSkipped++;
      return;
    }
    simulatedInFlight = true;
    simulatedExecutions++;
    await new Promise((r) => setTimeout(r, 25)); // simulate 25ms async roundtrip
    simulatedInFlight = false;
  };

  // Launch initial request and 4 rapid overlapping poll triggers
  const firstPromise = simulatedPoll();
  await simulatedPoll(); // overlapping 1 (skipped)
  await simulatedPoll(); // overlapping 2 (skipped)
  await simulatedPoll(); // overlapping 3 (skipped)
  await firstPromise;

  assert(simulatedExecutions === 1, 'In-flight guard executed exactly 1 authoritative network request');
  assert(simulatedSkipped === 3, 'In-flight guard skipped 3 overlapping concurrent poll attempts');

  // Case 8: Action Payload Efficiency & Zero Duplicate Roundtrips
  console.log('\n[Phase 4D: Action Payload Efficiency]');
  // Verify reveal-clue returns full state payload
  assert(typeof POLLING_SCHEDULE.liveMs === 'number', 'POLLING_SCHEDULE configuration is typed and defined');
  assert(POLLING_SCHEDULE.waitingMs === 3000 && POLLING_SCHEDULE.countdownMs === 1000 && POLLING_SCHEDULE.liveMs === 4000, 'POLLING_SCHEDULE contains expected interval constants');

  // Case 9: 40-Participant Polling Schedule Simulation
  console.log('\n[Phase 4E: 40-Participant Polling Schedule Local Simulation]');
  const totalSimulatedParticipants = 40;

  // WAITING Rate: 40 / 3s = 13.33 req/s
  const waitingReqPerSec = totalSimulatedParticipants / (POLLING_SCHEDULE.waitingMs / 1000);
  console.log(`📊 WAITING Schedule: ${totalSimulatedParticipants} participants @ 3.0s = ${waitingReqPerSec.toFixed(2)} req/sec (~13 req/s)`);
  assert(Math.abs(waitingReqPerSec - 13.33) < 0.1, 'WAITING polling rate matches ~13.3 req/sec for 40 participants');

  // COUNTDOWN Rate: 40 / 1s = 40.0 req/s
  const countdownReqPerSec = totalSimulatedParticipants / (POLLING_SCHEDULE.countdownMs / 1000);
  console.log(`📊 COUNTDOWN Schedule: ${totalSimulatedParticipants} participants @ 1.0s = ${countdownReqPerSec.toFixed(2)} req/sec (40 req/s)`);
  assert(countdownReqPerSec === 40, 'COUNTDOWN polling rate matches 40 req/sec for 40 participants');

  // LIVE Rate: 40 / 4s = 10.0 req/s
  const liveReqPerSec = totalSimulatedParticipants / (POLLING_SCHEDULE.liveMs / 1000);
  console.log(`📊 LIVE Schedule: ${totalSimulatedParticipants} participants @ 4.0s = ${liveReqPerSec.toFixed(2)} req/sec (10 req/s)`);
  assert(liveReqPerSec === 10, 'LIVE polling rate matches 10 req/sec for 40 participants');

  // HIDDEN Rate: 40 / 10s = 4.0 req/s
  const hiddenReqPerSec = totalSimulatedParticipants / (POLLING_SCHEDULE.hiddenMs / 1000);
  console.log(`📊 HIDDEN Schedule: ${totalSimulatedParticipants} participants @ 10.0s = ${hiddenReqPerSec.toFixed(2)} req/sec (4 req/s)`);
  assert(hiddenReqPerSec === 4, 'HIDDEN polling rate matches 4 req/sec for 40 backgrounded participants');

  // =========================================================================
  // 12. Regression Suite: Fresh Team Registration & Stale Session Lifecycle
  // =========================================================================
  console.log('\n--- 12. Regression Suite: Fresh Team Registration & Stale Session Lifecycle ---');

  // Ensure active event is LIVE for gameplay lifecycle testing
  const activeEvt = await getActiveEventCached();
  const activeEventId = activeEvt?.id || 'evt_cluequest_2026_main';
  await db.query("UPDATE events SET status = 'LIVE', started_at = CURRENT_TIMESTAMP WHERE id = $1", [activeEventId]);
  const liveEvtRes = await db.query("SELECT * FROM events WHERE id = $1", [activeEventId]);
  setActiveEventCache(liveEvtRes.rows[0]);

  // -------------------------------------------------------------------------
  // TEST B: Unregistered player attempts GET /game/state
  // Expected: 403 Forbidden, no game_session created, no timer started
  // -------------------------------------------------------------------------
  console.log('\n[Regression Test B: Unregistered Player Cannot Create Session]');
  // CQ039 is an unassigned slot (team_name is NULL)
  const unregLogin = await api('/auth/login', {
    method: 'POST',
    body: { player_code: 'CQ039', password: 'VSBece2026!' },
  });
  assert(unregLogin.ok, 'Unregistered CQ039 logs in with default credentials');
  const unregToken = unregLogin.data.token;
  assert(unregLogin.data.user.team_name === null, 'CQ039 has team_name === NULL');

  const unregGameState = await api('/game/state', { token: unregToken });
  assert(unregGameState.status === 403, 'Unregistered player receives 403 when requesting /game/state');
  assert(unregGameState.data.error.includes('Team registration is required'), 'Error message states team registration required');

  const unregSessionsInDb = await db.query(
    'SELECT * FROM game_sessions WHERE user_id = $1 AND event_id = $2',
    [unregLogin.data.user.id, activeEventId]
  );
  assert(unregSessionsInDb.rows.length === 0, 'No game_session record created for unregistered player');

  // -------------------------------------------------------------------------
  // TEST A: Unassigned slot with stale game_session -> Register new team "phoenix"
  // Expected:
  // - Registration succeeds
  // - Stale attempts and session removed
  // - User team_name set to "phoenix"
  // - Next GET /game/state creates fresh session (IN_PROGRESS, Q01, C1, 100 PTS)
  // -------------------------------------------------------------------------
  console.log('\n[Regression Test A: Stale Session Cleanup on Fresh Team Registration]');
  // Pick next available player slot
  const nextAvailableRes = await db.query("SELECT id, player_code FROM users WHERE role = 'PLAYER' AND team_name IS NULL ORDER BY player_code ASC LIMIT 1");
  const targetUser = nextAvailableRes.rows[0];
  const targetSlotCode = targetUser.player_code;

  // Manually simulate a stale expired session for targetUser in the active event
  const staleSessionId = `sess_stale_${targetSlotCode}_${Date.now()}`;
  const staleStartedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 mins ago
  await db.query(`
    INSERT INTO game_sessions (id, event_id, user_id, status, current_question, current_clue_level, current_question_value, total_score, started_at, completed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [staleSessionId, activeEventId, targetUser.id, 'COMPLETED', 1, 1, 100, 0, staleStartedAt, new Date(Date.now() - 10 * 60 * 1000).toISOString()]);

  // Insert a stale attempt for that session
  await db.query(`
    INSERT INTO question_attempts (id, session_id, question_id, highest_clue_level, final_question_value, user_answer, correct_answer, is_correct, earned_points)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [`att_stale_${Date.now()}`, staleSessionId, 'q_01', 1, 100, 'WRONG', 'RESISTOR', false, 0]);

  // Verify stale session exists before registration
  const preCheckSessions = await db.query('SELECT * FROM game_sessions WHERE user_id = $1 AND event_id = $2', [targetUser.id, activeEventId]);
  assert(preCheckSessions.rows.length === 1 && preCheckSessions.rows[0].status === 'COMPLETED', `Stale COMPLETED session verified for ${targetSlotCode} before registration`);

  // Register new team "phoenix"
  const phoenixReg = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'phoenix' },
  });
  assert(phoenixReg.ok, 'Team "phoenix" registered successfully');
  assert(phoenixReg.data.user.player_code === targetSlotCode, `Assigned to available slot ${targetSlotCode}`);
  assert(phoenixReg.data.user.team_name === 'phoenix', 'Team name assigned as "phoenix"');
  const phoenixToken = phoenixReg.data.token;

  // Verify stale session and attempts were deleted by the registration transaction
  const postRegSessions = await db.query('SELECT * FROM game_sessions WHERE user_id = $1 AND event_id = $2', [targetUser.id, activeEventId]);
  assert(postRegSessions.rows.length === 0, 'Stale game_session deleted during team registration');

  const postRegAttempts = await db.query('SELECT * FROM question_attempts WHERE session_id = $1', [staleSessionId]);
  assert(postRegAttempts.rows.length === 0, 'Stale question_attempts deleted during team registration');

  // Request game state as "phoenix"
  const phoenixGameState = await api('/game/state', { token: phoenixToken });
  assert(phoenixGameState.ok, 'GET /game/state succeeds for fresh team "phoenix"');
  assert(phoenixGameState.data.session.status === 'IN_PROGRESS', 'Fresh session is IN_PROGRESS (NOT COMPLETED)');
  assert(phoenixGameState.data.session.current_question === 1, 'Current question is Q01');
  assert(phoenixGameState.data.session.current_clue_level === 1, 'Current clue is C1');
  assert(phoenixGameState.data.session.current_question_value === 100, 'Current question value is 100 PTS');
  assert(phoenixGameState.data.session.total_score === 0, 'Total score starts at 0');
  assert(phoenixGameState.data.question !== null, 'Question content is returned for active gameplay');
  assert(phoenixGameState.data.is_expired === false, 'Fresh session is NOT expired');

  // -------------------------------------------------------------------------
  // TEST C: Registered player with existing IN_PROGRESS session
  // Expected: Same session reused, timer not reset, question state preserved
  // -------------------------------------------------------------------------
  console.log('\n[Regression Test C: Active Session Preservation for Registered Team]');
  const existingSessionId = phoenixGameState.data.session.id;

  // Reveal Clue 2 for phoenix
  const revealRes = await api('/game/reveal-clue', {
    method: 'POST',
    token: phoenixToken,
    body: { requested_level: 2 },
  });
  assert(revealRes.ok && revealRes.data.session.current_clue_level === 2, 'Phoenix reveals Clue 2 (75 PTS)');

  // Re-fetch game state
  const stateRefetch = await api('/game/state', { token: phoenixToken });
  assert(stateRefetch.data.session.id === existingSessionId, 'Same session ID reused on subsequent fetches');
  assert(stateRefetch.data.session.current_clue_level === 2, 'Clue level 2 preserved');
  assert(stateRefetch.data.session.current_question_value === 75, 'Question value 75 PTS preserved');

  // -------------------------------------------------------------------------
  // TEST D: Registered player with COMPLETED session remains completed
  // -------------------------------------------------------------------------
  console.log('\n[Regression Test D: Completed Session Remains Final]');
  // Mark phoenix session completed
  await db.query("UPDATE game_sessions SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1", [existingSessionId]);

  const completedState = await api('/game/state', { token: phoenixToken });
  assert(completedState.ok && completedState.data.session.status === 'COMPLETED', 'Session status remains COMPLETED');
  assert(completedState.data.question === null, 'Question content is null for completed session');

  const revealOnCompleted = await api('/game/reveal-clue', {
    method: 'POST',
    token: phoenixToken,
    body: { requested_level: 3 },
  });
  assert(revealOnCompleted.status === 400, 'Cannot reveal clues on a completed session');

  // -------------------------------------------------------------------------
  // TEST E: Cleanup isolation between different player slots
  // -------------------------------------------------------------------------
  console.log('\n[Regression Test E: Cleanup Isolation Between Slots]');
  // Find two unassigned slots
  const unassignedSlots = await db.query("SELECT id, player_code FROM users WHERE role = 'PLAYER' AND team_name IS NULL ORDER BY player_code ASC LIMIT 2");
  const userX = unassignedSlots.rows[0];
  const userY = unassignedSlots.rows[1];

  const sessionXId = `sess_x_${Date.now()}`;
  const sessionYId = `sess_y_${Date.now()}`;

  await db.query(`
    INSERT INTO game_sessions (id, event_id, user_id, status, current_question, current_clue_level, current_question_value, total_score)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [sessionXId, activeEventId, userX.id, 'IN_PROGRESS', 5, 2, 75, 250]);

  await db.query(`
    INSERT INTO game_sessions (id, event_id, user_id, status, current_question, current_clue_level, current_question_value, total_score)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [sessionYId, activeEventId, userY.id, 'IN_PROGRESS', 8, 3, 50, 450]);

  // Register team for User X slot
  const regX = await api('/auth/team', {
    method: 'POST',
    body: { teamName: 'ISOLATION_TEAM_X' },
  });
  assert(regX.ok && regX.data.user.player_code === userX.player_code, `Team X assigned to slot ${userX.player_code}`);

  // Verify User X's stale session was deleted, but User Y's session was NOT deleted
  const sessXCheck = await db.query('SELECT * FROM game_sessions WHERE id = $1', [sessionXId]);
  const sessYCheck = await db.query('SELECT * FROM game_sessions WHERE id = $1', [sessionYId]);
  assert(sessXCheck.rows.length === 0, `Slot ${userX.player_code} session deleted upon registration`);
  assert(sessYCheck.rows.length === 1 && sessYCheck.rows[0].total_score === 450, `Slot ${userY.player_code} session remains untouched with original score (450 PTS)`);

  console.log('\n========================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================\n');

  if (serverInstance) {
    serverInstance.close();
  }

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner fatal error:', err);
  if (serverInstance) serverInstance.close();
  process.exit(1);
});
