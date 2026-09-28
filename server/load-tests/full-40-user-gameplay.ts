/**
 * ============================================================================
 * CLUE QUEST — FULL 40-USER E2E GAMEPLAY LOAD SIMULATION
 * ============================================================================
 * 
 * DESTRUCTIVE GAMEPLAY SIMULATION TEST SCRIPT.
 * 
 * Simulates 40 distinct concurrent participants playing the complete 20-question
 * Clue Quest game from start to finish against a LOCAL server:
 * - 40 independent logins & JWTs
 * - 40 initial game-state fetches
 * - 20 questions per participant (Q01 -> Q20)
 * - 3 reveal-clue API calls per question (Clue 1 is already active; calls for C2:75pt, C3:50pt, C4:25pt)
 *   => 40 participants * 20 questions * 3 calls = 2,400 reveal-clue API calls
 * - 1 answer submission per question (800 submissions)
 * - 1 next-question call per question (800 next-question calls)
 * - 1 final results verification per participant (40 results calls)
 * => Total Expected API Requests: 4,120
 * 
 * SAFETY GATES:
 * - Blocked from running against production (https://clue-quest.onrender.com)
 *   by default unless explicit ALLOW_PRODUCTION_GAMEPLAY_TEST=true is set.
 * - Isolated in server/load-tests/ and must NEVER be imported by production code.
 * ============================================================================
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { performance } from 'perf_hooks';
import { SEED_QUESTIONS } from '../db/seed.ts';
import { initDb, db } from '../db/client.ts';
import { seedDatabase } from '../db/seed.ts';
import { authRouter } from '../routes/authRoutes.ts';
import { gameRouter } from '../routes/gameRoutes.ts';
import { eventRouter } from '../routes/eventRoutes.ts';
import { adminRouter } from '../routes/adminRoutes.ts';
import { config } from '../config.ts';

// Target and Configuration
const DEFAULT_PORT = config.port || 3001;
const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const BASE_URL = process.env.CQ_TEST_BASE_URL || DEFAULT_BASE_URL;
const PARTICIPANT_PASSWORD = process.env.CQ_PARTICIPANT_PASSWORD || 'VSBece2026!';
const ADMIN_PASSWORD = process.env.CQ_ADMIN_PASSWORD || 'VSBadmin2026!';
const PARTICIPANT_COUNT = 40;
const QUESTIONS_PER_PARTICIPANT = 20;
const REVEALS_PER_QUESTION = 3; // Clue 1 is active on question start; calls for C2, C3, C4
const PARTICIPANTS = Array.from({ length: PARTICIPANT_COUNT }, (_, i) => `CQ${String(i + 1).padStart(3, '0')}`);

// Question answer lookup map from official seed data
const QUESTION_ANSWERS = new Map<number, string>();
for (const q of SEED_QUESTIONS) {
  QUESTION_ANSWERS.set(q.question_number, q.answer);
}

// Interfaces
interface RequestMetric {
  endpoint: string;
  method: string;
  player_code: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  errorCategory?: '401' | '403' | '409' | '429' | '5xx' | 'timeout' | 'connection' | 'other';
  errorDetails?: string;
}

interface ParticipantWorkerResult {
  player_code: string;
  completed: boolean;
  final_score: number;
  questions_answered: number;
  clue_reveal_api_calls: number;
  next_question_api_calls: number;
  durationMs: number;
  errors: string[];
}

interface SimulationSummary {
  targetBaseUrl: string;
  participantCount: number;
  questionsPerParticipant: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  expectedCounts: {
    logins: number;
    initialStateCalls: number;
    clueRevealApiCalls: number;
    answerSubmissions: number;
    nextQuestionCalls: number;
    resultsCalls: number;
    totalExpected: number;
  };
  actualCounts: {
    logins: number;
    initialStateCalls: number;
    clueRevealApiCalls: number;
    answerSubmissions: number;
    nextQuestionCalls: number;
    resultsCalls: number;
  };
  failureBreakdown: {
    '401': number;
    '403': number;
    '409': number;
    '429': number;
    '5xx': number;
    timeout: number;
    connection: number;
    other: number;
  };
  latency: {
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  timing: {
    totalWallClockMs: number;
    avgParticipantDurationMs: number;
    fastestParticipantMs: number;
    slowestParticipantMs: number;
  };
  integrity: {
    distinctParticipantsCompleted: number;
    allParticipantsSucceeded: boolean;
    crossUserLeakageDetected: boolean;
    allQuestionsExercised: boolean;
    allCluesExercised: boolean;
    correctTotalScoreEarned: boolean;
  };
}

class MetricsCollector {
  private metrics: RequestMetric[] = [];

  record(metric: RequestMetric) {
    this.metrics.push(metric);
  }

  getAll(): RequestMetric[] {
    return this.metrics;
  }

  computeSummary(
    totalWallClockMs: number,
    workerResults: ParticipantWorkerResult[],
    crossUserLeakage: boolean
  ): SimulationSummary {
    const latencies = this.metrics.map(m => m.latencyMs).sort((a, b) => a - b);
    const successful = this.metrics.filter(m => m.ok).length;
    const failed = this.metrics.filter(m => !m.ok).length;

    const failureBreakdown = {
      '401': this.metrics.filter(m => m.errorCategory === '401').length,
      '403': this.metrics.filter(m => m.errorCategory === '403').length,
      '409': this.metrics.filter(m => m.errorCategory === '409').length,
      '429': this.metrics.filter(m => m.errorCategory === '429').length,
      '5xx': this.metrics.filter(m => m.errorCategory === '5xx').length,
      timeout: this.metrics.filter(m => m.errorCategory === 'timeout').length,
      connection: this.metrics.filter(m => m.errorCategory === 'connection').length,
      other: this.metrics.filter(m => m.errorCategory === 'other').length,
    };

    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.50)] : 0;
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;
    const p99 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)] : 0;
    const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

    const participantDurations = workerResults.map(r => r.durationMs);
    const completedWorkers = workerResults.filter(r => r.completed);

    const actualClueReveals = workerResults.reduce((acc, r) => acc + r.clue_reveal_api_calls, 0);
    const actualAnswersSubmitted = workerResults.reduce((acc, r) => acc + r.questions_answered, 0);
    const actualQuestionAdvances = workerResults.reduce((acc, r) => acc + r.next_question_api_calls, 0);

    const loginsCount = this.metrics.filter(m => m.endpoint === '/api/auth/login' && m.player_code !== 'admin').length;
    const stateCount = this.metrics.filter(m => m.endpoint === '/api/game/state').length;
    const resultsCount = this.metrics.filter(m => m.endpoint === '/api/game/results').length;

    const expectedTotal =
      PARTICIPANT_COUNT + // Logins (40)
      PARTICIPANT_COUNT + // Initial State (40)
      PARTICIPANT_COUNT * QUESTIONS_PER_PARTICIPANT * REVEALS_PER_QUESTION + // Reveals (2,400)
      PARTICIPANT_COUNT * QUESTIONS_PER_PARTICIPANT + // Answers (800)
      PARTICIPANT_COUNT * QUESTIONS_PER_PARTICIPANT + // Next question (800)
      PARTICIPANT_COUNT; // Results (40)

    const allScores500 = completedWorkers.every(r => r.final_score === 500);

    return {
      targetBaseUrl: BASE_URL,
      participantCount: PARTICIPANTS.length,
      questionsPerParticipant: QUESTIONS_PER_PARTICIPANT,
      totalRequests: this.metrics.length,
      successfulRequests: successful,
      failedRequests: failed,
      expectedCounts: {
        logins: PARTICIPANT_COUNT,
        initialStateCalls: PARTICIPANT_COUNT,
        clueRevealApiCalls: PARTICIPANT_COUNT * QUESTIONS_PER_PARTICIPANT * REVEALS_PER_QUESTION, // 2,400
        answerSubmissions: PARTICIPANT_COUNT * QUESTIONS_PER_PARTICIPANT, // 800
        nextQuestionCalls: PARTICIPANT_COUNT * QUESTIONS_PER_PARTICIPANT, // 800
        resultsCalls: PARTICIPANT_COUNT, // 40
        totalExpected: expectedTotal, // 4,120
      },
      actualCounts: {
        logins: loginsCount,
        initialStateCalls: stateCount,
        clueRevealApiCalls: actualClueReveals,
        answerSubmissions: actualAnswersSubmitted,
        nextQuestionCalls: actualQuestionAdvances,
        resultsCalls: resultsCount,
      },
      failureBreakdown,
      latency: {
        minMs: latencies.length > 0 ? Math.round(latencies[0]) : 0,
        maxMs: latencies.length > 0 ? Math.round(latencies[latencies.length - 1]) : 0,
        avgMs: avg,
        p50Ms: Math.round(p50),
        p95Ms: Math.round(p95),
        p99Ms: Math.round(p99),
      },
      timing: {
        totalWallClockMs: Math.round(totalWallClockMs),
        avgParticipantDurationMs: participantDurations.length > 0 ? Math.round(participantDurations.reduce((a, b) => a + b, 0) / participantDurations.length) : 0,
        fastestParticipantMs: participantDurations.length > 0 ? Math.round(Math.min(...participantDurations)) : 0,
        slowestParticipantMs: participantDurations.length > 0 ? Math.round(Math.max(...participantDurations)) : 0,
      },
      integrity: {
        distinctParticipantsCompleted: completedWorkers.length,
        allParticipantsSucceeded: completedWorkers.length === PARTICIPANTS.length && failed === 0,
        crossUserLeakageDetected: crossUserLeakage,
        allQuestionsExercised: actualAnswersSubmitted === PARTICIPANTS.length * QUESTIONS_PER_PARTICIPANT,
        allCluesExercised: actualClueReveals === PARTICIPANTS.length * QUESTIONS_PER_PARTICIPANT * REVEALS_PER_QUESTION,
        correctTotalScoreEarned: allScores500,
      },
    };
  }
}

function categorizeError(status?: number, err?: any): '401' | '403' | '409' | '429' | '5xx' | 'timeout' | 'connection' | 'other' {
  if (status === 401) return '401';
  if (status === 403) return '403';
  if (status === 409) return '409';
  if (status === 429) return '429';
  if (status && status >= 500 && status < 600) return '5xx';
  if (err) {
    const msg = String(err.message || err);
    if (msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('AbortError')) return 'timeout';
    if (msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('socket') || msg.includes('fetch failed')) return 'connection';
  }
  return 'other';
}

async function sendRequest(
  collector: MetricsCollector,
  playerCode: string,
  endpoint: string,
  options: RequestInit = {},
  timeoutMs = 15000
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const url = `${BASE_URL}${endpoint}`;
  const method = options.method || 'GET';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const latencyMs = performance.now() - start;
    clearTimeout(timeoutId);

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    const ok = res.ok;
    const errorCategory = ok ? undefined : categorizeError(res.status);
    const errorDetails = ok ? undefined : `HTTP ${res.status}: ${JSON.stringify(data)}`;

    collector.record({
      endpoint,
      method,
      player_code: playerCode,
      status: res.status,
      latencyMs,
      ok,
      errorCategory,
      errorDetails,
    });

    return {
      ok,
      status: res.status,
      data,
      error: errorDetails,
    };
  } catch (err: any) {
    const latencyMs = performance.now() - start;
    clearTimeout(timeoutId);
    const errorCategory = categorizeError(0, err);
    const errorDetails = err?.message || String(err);

    collector.record({
      endpoint,
      method,
      player_code: playerCode,
      status: 0,
      latencyMs,
      ok: false,
      errorCategory,
      errorDetails,
    });

    return {
      ok: false,
      status: 0,
      data: null,
      error: errorDetails,
    };
  }
}

/**
 * Ensures the local test server is active and event is in LIVE state.
 */
let serverInstance: any = null;

async function ensureLocalServerAndLiveEvent(): Promise<void> {
  // Check if server is already reachable
  let isReachable = false;
  try {
    const healthCheck = await fetch(`${BASE_URL}/api/health`);
    if (healthCheck.ok) {
      isReachable = true;
    }
  } catch {
    isReachable = false;
  }

  // If not reachable and on local address, start in-process test server
  if (!isReachable && (BASE_URL.includes('127.0.0.1') || BASE_URL.includes('localhost'))) {
    console.log('📦 Starting in-process local test server on port ' + DEFAULT_PORT + '...');
    const app = express();
    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());

    await initDb();
    await seedDatabase();

    app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        service: 'CLUE QUEST Local Test Server',
        time: new Date().toISOString(),
      });
    });

    app.use('/api/auth', authRouter);
    app.use('/api/game', gameRouter);
    app.use('/api/event', eventRouter);
    app.use('/api/admin', adminRouter);

    await new Promise<void>((resolve) => {
      serverInstance = app.listen(DEFAULT_PORT, '127.0.0.1', () => {
        resolve();
      });
    });
    console.log('✅ Local test server running at ' + BASE_URL);
  }

  // Ensure Event is in LIVE state
  console.log('🔍 Checking local event status...');
  const eventStatusRes = await fetch(`${BASE_URL}/api/event/status`);
  const eventStatusData = (await eventStatusRes.json()) as any;
  const currentStatus = eventStatusData?.event?.status;

  if (currentStatus !== 'LIVE') {
    console.log(`⚡ Transitioning local event from ${currentStatus || 'UNKNOWN'} to LIVE via admin control...`);
    // Login as Admin
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_code: 'admin', password: ADMIN_PASSWORD }),
    });
    const adminLoginData = (await adminLoginRes.json()) as any;
    const adminToken = adminLoginData?.token;
    if (!adminToken) {
      throw new Error('Failed to authenticate as admin for local event activation');
    }

    if (currentStatus === 'ENDED' || currentStatus === 'PAUSED' || currentStatus === 'COMPLETED') {
      await fetch(`${BASE_URL}/api/admin/event/control`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'RESET' }),
      });
    }

    // Start event immediately to LIVE
    const startRes = await fetch(`${BASE_URL}/api/admin/event/control`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'START_NOW' }),
    });

    if (!startRes.ok) {
      const startErr = await startRes.json();
      throw new Error(`Failed to start event to LIVE state: ${JSON.stringify(startErr)}`);
    }
    console.log('⏳ Synchronized countdown triggered. Waiting 5.5s for automatic transition to LIVE...');
    await new Promise((resolve) => setTimeout(resolve, 5500));

    // Confirm LIVE state
    const postStartStatusRes = await fetch(`${BASE_URL}/api/event/status`);
    const postStartStatusData = (await postStartStatusRes.json()) as any;
    if (postStartStatusData?.event?.status !== 'LIVE') {
      throw new Error(`Event status is still ${postStartStatusData?.event?.status}, expected LIVE`);
    }
    console.log('✅ Local event successfully transitioned to LIVE state.');
  } else {
    console.log('✅ Local event is already LIVE.');
  }
}

/**
 * Worker representing one participant executing the full gameplay lifecycle.
 */
async function runParticipantWorker(
  playerCode: string,
  collector: MetricsCollector,
  crossUserLeakageRef: { detected: boolean }
): Promise<ParticipantWorkerResult> {
  const workerStart = performance.now();
  const errors: string[] = [];
  let clueRevealApiCalls = 0;
  let nextQuestionApiCalls = 0;
  let questionsAnswered = 0;
  let currentScore = 0;

  try {
    // 1. Login
    const loginRes = await sendRequest(collector, playerCode, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_code: playerCode, password: PARTICIPANT_PASSWORD }),
    });

    if (!loginRes.ok || !loginRes.data?.token) {
      throw new Error(`Login failed: ${loginRes.error || 'No token received'}`);
    }

    const token = loginRes.data.token;
    const user = loginRes.data.user;
    if (user?.player_code !== playerCode) {
      crossUserLeakageRef.detected = true;
      throw new Error(`Login identity mismatch: Expected ${playerCode}, received ${user?.player_code}`);
    }

    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 2. Initial Game State
    const stateRes = await sendRequest(collector, playerCode, '/api/game/state', {
      headers: authHeaders,
    });

    if (!stateRes.ok || !stateRes.data?.event) {
      throw new Error(`Initial state fetch failed: ${stateRes.error}`);
    }

    const event = stateRes.data.event;
    if (event.status !== 'LIVE') {
      throw new Error(`Cannot play: Event status is ${event.status}, expected LIVE`);
    }

    let latestSession = stateRes.data.session;

    // 3. Play Question 1 through Question 20
    for (let qNum = 1; qNum <= QUESTIONS_PER_PARTICIPANT; qNum++) {
      // Verify session is on current question (from initial state or previous next-question response)
      if (latestSession && latestSession.current_question !== qNum) {
        throw new Error(`Q${qNum} sequence error: Expected question ${qNum}, found ${latestSession.current_question}`);
      }

      // Clue 1 is already active by default (100 points, current_clue_level = 1)
      // Reveal Clue 2 (75 points)
      const c2Res = await sendRequest(collector, playerCode, '/api/game/reveal-clue', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ requested_level: 2 }),
      });
      if (!c2Res.ok || c2Res.data?.session?.current_clue_level !== 2 || c2Res.data?.session?.current_question_value !== 75) {
        throw new Error(`Q${qNum} Clue 2 reveal failed: ${c2Res.error}`);
      }
      clueRevealApiCalls++;

      // Reveal Clue 3 (50 points)
      const c3Res = await sendRequest(collector, playerCode, '/api/game/reveal-clue', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ requested_level: 3 }),
      });
      if (!c3Res.ok || c3Res.data?.session?.current_clue_level !== 3 || c3Res.data?.session?.current_question_value !== 50) {
        throw new Error(`Q${qNum} Clue 3 reveal failed: ${c3Res.error}`);
      }
      clueRevealApiCalls++;

      // Reveal Clue 4 (25 points)
      const c4Res = await sendRequest(collector, playerCode, '/api/game/reveal-clue', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ requested_level: 4 }),
      });
      if (!c4Res.ok || c4Res.data?.session?.current_clue_level !== 4 || c4Res.data?.session?.current_question_value !== 25) {
        throw new Error(`Q${qNum} Clue 4 reveal failed: ${c4Res.error}`);
      }
      clueRevealApiCalls++;

      // Submit correct answer
      const correctAnswer = QUESTION_ANSWERS.get(qNum);
      if (!correctAnswer) {
        throw new Error(`Q${qNum} answer not found in seed bank`);
      }

      const answerRes = await sendRequest(collector, playerCode, '/api/game/submit-answer', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ answer: correctAnswer }),
      });

      if (!answerRes.ok || !answerRes.data?.is_correct || answerRes.data?.earned_points !== 25) {
        throw new Error(`Q${qNum} answer submission failed: ${answerRes.error || 'Incorrect answer/points response'}`);
      }

      currentScore = answerRes.data.total_score;
      questionsAnswered++;

      // Advance to next question
      const advanceRes = await sendRequest(collector, playerCode, '/api/game/next-question', {
        method: 'POST',
        headers: authHeaders,
      });

      if (!advanceRes.ok) {
        throw new Error(`Q${qNum} next-question advancement failed: ${advanceRes.error}`);
      }
      nextQuestionApiCalls++;

      latestSession = advanceRes.data?.session;

      if (qNum === QUESTIONS_PER_PARTICIPANT) {
        if (!advanceRes.data?.is_complete && advanceRes.data?.session?.status !== 'COMPLETED') {
          throw new Error('Final question advance did not mark game COMPLETED');
        }
      } else {
        if (latestSession?.current_question !== qNum + 1) {
          throw new Error(`Advancement mismatch: Expected question ${qNum + 1}, got ${latestSession?.current_question}`);
        }
      }
    }

    // 4. Verify Final Results Summary
    const resultsRes = await sendRequest(collector, playerCode, '/api/game/results', {
      headers: authHeaders,
    });

    if (!resultsRes.ok || resultsRes.data?.player?.player_code !== playerCode) {
      if (resultsRes.data?.player?.player_code && resultsRes.data.player.player_code !== playerCode) {
        crossUserLeakageRef.detected = true;
      }
      throw new Error(`Final results fetch failed: ${resultsRes.error}`);
    }

    const durationMs = performance.now() - workerStart;
    return {
      player_code: playerCode,
      completed: questionsAnswered === QUESTIONS_PER_PARTICIPANT && clueRevealApiCalls === QUESTIONS_PER_PARTICIPANT * REVEALS_PER_QUESTION && currentScore === 500,
      final_score: currentScore,
      questions_answered: questionsAnswered,
      clue_reveal_api_calls: clueRevealApiCalls,
      next_question_api_calls: nextQuestionApiCalls,
      durationMs,
      errors,
    };
  } catch (err: any) {
    const durationMs = performance.now() - workerStart;
    errors.push(err.message || String(err));
    return {
      player_code: playerCode,
      completed: false,
      final_score: currentScore,
      questions_answered: questionsAnswered,
      clue_reveal_api_calls: clueRevealApiCalls,
      next_question_api_calls: nextQuestionApiCalls,
      durationMs,
      errors,
    };
  }
}

/**
 * Main execution harness.
 */
export async function runFullGameplaySimulation(): Promise<SimulationSummary> {
  const isProduction = BASE_URL.includes('onrender.com') || BASE_URL.includes('render.com');
  const allowProdOverride = process.env.ALLOW_PRODUCTION_GAMEPLAY_TEST === 'true';

  console.log('TARGET:            ' + BASE_URL);
  console.log('ENVIRONMENT:       ' + (isProduction ? 'PRODUCTION' : 'LOCAL'));
  console.log('PARTICIPANTS:      ' + PARTICIPANT_COUNT);
  console.log('QUESTIONS:         ' + QUESTIONS_PER_PARTICIPANT);
  console.log('PRODUCTION GUARD:  ' + (isProduction ? 'ARMED' : 'NOT_APPLICABLE_LOCAL'));
  console.log('');

  // SAFETY CHECK: Refuse production runs by default
  if (isProduction && !allowProdOverride) {
    console.error('❌ SAFETY ABORT: Execution against PRODUCTION is BLOCKED by default.');
    console.error('The live production event is currently active and must remain untouched.');
    console.error('To override (FOR AUTHORIZED TESTING ONLY), set ALLOW_PRODUCTION_GAMEPLAY_TEST=true.');
    throw new Error('Production gameplay simulation blocked by safety guard.');
  }

  // Ensure local environment is ready and live
  await ensureLocalServerAndLiveEvent();

  const collector = new MetricsCollector();
  const crossUserLeakageRef = { detected: false };
  const simulationStart = performance.now();

  console.log(`\n🚀 Launching ${PARTICIPANTS.length} concurrent participant workers...`);

  // Launch all 40 participant workers concurrently
  const workerPromises = PARTICIPANTS.map((code) =>
    runParticipantWorker(code, collector, crossUserLeakageRef)
  );

  const workerResults = await Promise.all(workerPromises);
  const totalWallClockMs = performance.now() - simulationStart;

  const summary = collector.computeSummary(totalWallClockMs, workerResults, crossUserLeakageRef.detected);

  console.log('\n===============================================================');
  console.log('SIMULATION COMPLETED — RESULTS SUMMARY');
  console.log('===============================================================');
  console.log(`Total Requests      : ${summary.totalRequests} (Expected: ${summary.expectedCounts.totalExpected})`);
  console.log(`Successful Requests : ${summary.successfulRequests}`);
  console.log(`Failed Requests     : ${summary.failedRequests}`);
  console.log(`Latency Avg / Max   : ${summary.latency.avgMs} ms / ${summary.latency.maxMs} ms`);
  console.log(`Latency p50/p95/p99 : ${summary.latency.p50Ms} ms / ${summary.latency.p95Ms} ms / ${summary.latency.p99Ms} ms`);
  console.log(`Total Wall Clock    : ${summary.timing.totalWallClockMs} ms`);
  console.log(`Avg Worker Duration : ${summary.timing.avgParticipantDurationMs} ms`);
  console.log(`Completed Workers   : ${summary.integrity.distinctParticipantsCompleted} / ${PARTICIPANT_COUNT}`);
  console.log(`All Succeeded       : ${summary.integrity.allParticipantsSucceeded ? 'YES' : 'NO'}`);
  console.log(`Cross-User Leakage  : ${summary.integrity.crossUserLeakageDetected ? 'YES' : 'NO'}`);
  console.log(`Clue Reveal Calls   : ${summary.actualCounts.clueRevealApiCalls} (Expected: ${summary.expectedCounts.clueRevealApiCalls})`);
  console.log(`Answer Submissions  : ${summary.actualCounts.answerSubmissions} (Expected: ${summary.expectedCounts.answerSubmissions})`);
  console.log(`Next Question Calls : ${summary.actualCounts.nextQuestionCalls} (Expected: ${summary.expectedCounts.nextQuestionCalls})`);
  console.log(`Scoring (500/500)   : ${summary.integrity.correctTotalScoreEarned ? 'VERIFIED' : 'FAILED'}`);
  if (workerResults.some(r => r.errors.length > 0)) {
    console.log('\n❌ Worker Errors Sample:');
    for (const r of workerResults.filter(r => r.errors.length > 0).slice(0, 3)) {
      console.log(`  [${r.player_code}]: ${r.errors.join('; ')}`);
    }
  }
  console.log('===============================================================\n');

  if (serverInstance) {
    serverInstance.close();
  }

  return summary;
}

// Standalone execution entry point
if (process.argv[1]?.includes('full-40-user-gameplay')) {
  runFullGameplaySimulation().catch((err) => {
    console.error('Fatal simulation error:', err.message);
    if (serverInstance) {
      serverInstance.close();
    }
    process.exit(1);
  });
}
