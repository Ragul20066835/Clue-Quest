import { db } from '../db/client.js';
import { logEventAction } from './auditService.js';

export interface CachedEvent {
  id: string;
  name: string;
  status: 'WAITING' | 'COUNTDOWN' | 'LIVE' | 'PAUSED' | 'ENDED';
  max_players: number;
  countdown_started_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CachedClue {
  id: string;
  question_id: string;
  level: number;
  clue_text: string;
  points: number;
}

export interface CachedQuestion {
  id: string;
  question_number: number;
  question_text: string;
  answer: string;
  accepted_aliases: string[];
  category: string;
  is_active: boolean;
  clues: CachedClue[];
}

// Process-local in-memory cache stores
let cachedActiveEvent: CachedEvent | null = null;
let cachedQuestions: CachedQuestion[] | null = null;
let cachedQuestionsByNumber: Map<number, CachedQuestion> = new Map();
let cachedQuestionsById: Map<string, CachedQuestion> = new Map();

/* =========================================================================
   ACTIVE EVENT CACHE
   ========================================================================= */

/**
 * Invalidate the cached active event. Subsequent calls will fetch from database.
 */
export function invalidateActiveEventCache(): void {
  cachedActiveEvent = null;
}

/**
 * Explicitly update the active event in memory (e.g. after status change or creation).
 */
export function setActiveEventCache(event: CachedEvent | null): void {
  cachedActiveEvent = event ? { ...event } : null;
}

/**
 * Check and advance countdown if 5 seconds elapsed.
 * Atomically updates PostgreSQL and local cache.
 */
export async function checkAndAdvanceCountdownCached(event: CachedEvent): Promise<CachedEvent> {
  if (event.status === 'COUNTDOWN' && event.countdown_started_at) {
    const elapsedMs = Date.now() - new Date(event.countdown_started_at).getTime();
    const elapsedSeconds = elapsedMs / 1000;

    if (elapsedSeconds >= 5) {
      const now = new Date().toISOString();
      await db.query(
        "UPDATE events SET status = 'LIVE', started_at = $1 WHERE id = $2",
        [now, event.id]
      );
      event.status = 'LIVE';
      event.started_at = now;
      setActiveEventCache(event);
      await logEventAction('EVENT_TRANSITION_LIVE', null, event.id, { elapsed_seconds: elapsedSeconds });
    }
  }
  return event;
}

/**
 * Get active/latest event from cache when available, falling back to database query.
 */
export async function getActiveEventCached(): Promise<CachedEvent | null> {
  try {
    if (cachedActiveEvent) {
      // Check countdown transition on cached event
      return await checkAndAdvanceCountdownCached(cachedActiveEvent);
    }

    // Cache miss: query authoritative database
    const res = await db.query('SELECT * FROM events ORDER BY created_at DESC LIMIT 1');
    if (res.rows.length === 0) {
      cachedActiveEvent = null;
      return null;
    }

    let event: CachedEvent = res.rows[0];
    event = await checkAndAdvanceCountdownCached(event);
    setActiveEventCache(event);
    return event;
  } catch (err) {
    console.warn('⚠️ Active event cache lookup warning, falling back to direct query:', err);
    // Fallback directly to DB query
    const res = await db.query('SELECT * FROM events ORDER BY created_at DESC LIMIT 1');
    return res.rows.length > 0 ? res.rows[0] : null;
  }
}

/* =========================================================================
   QUESTION & CLUE BANK CACHE
   ========================================================================= */

/**
 * Invalidate the question and clue bank cache.
 */
export function invalidateQuestionBankCache(): void {
  cachedQuestions = null;
  cachedQuestionsByNumber.clear();
  cachedQuestionsById.clear();
}

/**
 * Load and cache all active questions and their associated clues into memory.
 */
export async function loadQuestionBankCache(): Promise<CachedQuestion[]> {
  try {
    const qRes = await db.query(
      'SELECT id, question_number, question_text, answer, accepted_aliases, category, is_active FROM questions WHERE is_active = true ORDER BY question_number ASC'
    );
    const questionsRows = qRes.rows;

    const cluesRes = await db.query(
      'SELECT id, question_id, level, clue_text, points FROM clues ORDER BY level ASC'
    );
    const cluesRows = cluesRes.rows;

    // Group clues by question_id
    const cluesByQuestionId = new Map<string, CachedClue[]>();
    for (const clue of cluesRows) {
      const qId = clue.question_id;
      if (!cluesByQuestionId.has(qId)) {
        cluesByQuestionId.set(qId, []);
      }
      cluesByQuestionId.get(qId)!.push({
        id: clue.id,
        question_id: clue.question_id,
        level: Number(clue.level),
        clue_text: clue.clue_text,
        points: Number(clue.points),
      });
    }

    const questionList: CachedQuestion[] = [];
    const byNumber = new Map<number, CachedQuestion>();
    const byId = new Map<string, CachedQuestion>();

    for (const q of questionsRows) {
      let aliases: string[] = [];
      if (Array.isArray(q.accepted_aliases)) {
        aliases = q.accepted_aliases;
      } else if (typeof q.accepted_aliases === 'string') {
        try {
          aliases = JSON.parse(q.accepted_aliases);
        } catch {
          aliases = [q.accepted_aliases];
        }
      }

      const qClues = (cluesByQuestionId.get(q.id) || []).sort((a, b) => a.level - b.level);

      const cachedQ: CachedQuestion = {
        id: q.id,
        question_number: Number(q.question_number),
        question_text: q.question_text,
        answer: String(q.answer).toUpperCase(),
        accepted_aliases: aliases,
        category: q.category || 'Electronics',
        is_active: Boolean(q.is_active),
        clues: qClues,
      };

      questionList.push(cachedQ);
      byNumber.set(cachedQ.question_number, cachedQ);
      byId.set(cachedQ.id, cachedQ);
    }

    cachedQuestions = questionList;
    cachedQuestionsByNumber = byNumber;
    cachedQuestionsById = byId;

    return questionList;
  } catch (err) {
    console.warn('⚠️ Failed to populate question bank cache, fallback to empty:', err);
    return [];
  }
}

/**
 * Get all cached active questions, loading from database on initial call or cache miss.
 */
export async function getQuestionBankCached(): Promise<CachedQuestion[]> {
  if (cachedQuestions) {
    return cachedQuestions;
  }
  return loadQuestionBankCache();
}

/**
 * Retrieve a specific question and its clues by question number from cache.
 */
export async function getQuestionByNumberCached(questionNumber: number): Promise<CachedQuestion | null> {
  if (!cachedQuestions) {
    await loadQuestionBankCache();
  }
  return cachedQuestionsByNumber.get(questionNumber) || null;
}

/**
 * Retrieve a specific question and its clues by question ID from cache.
 */
export async function getQuestionByIdCached(questionId: string): Promise<CachedQuestion | null> {
  if (!cachedQuestions) {
    await loadQuestionBankCache();
  }
  return cachedQuestionsById.get(questionId) || null;
}

/* =========================================================================
   AUTH USER CACHE (Bounded 15s TTL for Hot Path Verification)
   ========================================================================= */

export interface CachedAuthUser {
  id: string;
  player_code: string;
  display_name: string;
  team_name: string | null;
  role: 'PLAYER' | 'ADMIN';
  is_active: boolean;
  cachedAt: number;
}

const AUTH_USER_CACHE_TTL_MS = 15000; // 15-second bounded TTL
const authUsersCache = new Map<string, CachedAuthUser>();

/**
 * Invalidate cached auth user(s).
 * Pass specific userId to invalidate a single user, or omit to invalidate all users.
 */
export function invalidateAuthUserCache(userId?: string): void {
  if (userId) {
    authUsersCache.delete(userId);
  } else {
    authUsersCache.clear();
  }
}

/**
 * Explicitly cache or update an authenticated user.
 */
export function setAuthUserCache(user: Omit<CachedAuthUser, 'cachedAt'>): void {
  authUsersCache.set(user.id, {
    ...user,
    cachedAt: Date.now(),
  });
}

/**
 * Get authenticated user from memory cache if fresh, otherwise query PostgreSQL.
 */
export async function getAuthUserCached(userId: string): Promise<CachedAuthUser | null> {
  const now = Date.now();
  const cached = authUsersCache.get(userId);

  if (cached && now - cached.cachedAt < AUTH_USER_CACHE_TTL_MS) {
    return cached;
  }

  try {
    const res = await db.query(
      'SELECT id, player_code, display_name, team_name, role, is_active FROM users WHERE id = $1',
      [userId]
    );

    if (res.rows.length === 0) {
      authUsersCache.delete(userId);
      return null;
    }

    const row = res.rows[0];
    const user: CachedAuthUser = {
      id: row.id,
      player_code: row.player_code,
      display_name: row.display_name,
      team_name: row.team_name || null,
      role: row.role,
      is_active: Boolean(row.is_active),
      cachedAt: now,
    };

    authUsersCache.set(userId, user);
    return user;
  } catch (err) {
    console.warn(`⚠️ Auth user DB lookup failed for ${userId}:`, err);
    return null;
  }
}

/**
 * Invalidate all server-side caches (used during full resets / tests / seeds).
 */
export function invalidateAllCaches(): void {
  invalidateActiveEventCache();
  invalidateQuestionBankCache();
  invalidateAuthUserCache();
}

/**
 * Inspection helper for testing cache hit/miss behavior (internal/test use only).
 */
export function getCacheInspectionState(): {
  hasActiveEventCache: boolean;
  activeEventId: string | null;
  activeEventStatus: string | null;
  hasQuestionBankCache: boolean;
  questionCount: number;
  authUserCount: number;
} {
  return {
    hasActiveEventCache: cachedActiveEvent !== null,
    activeEventId: cachedActiveEvent?.id || null,
    activeEventStatus: cachedActiveEvent?.status || null,
    hasQuestionBankCache: cachedQuestions !== null,
    questionCount: cachedQuestions?.length || 0,
    authUserCount: authUsersCache.size,
  };
}
