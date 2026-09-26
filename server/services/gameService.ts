import { db } from '../db/client.js';
import { logEventAction } from './auditService.js';

export const CLUE_POINT_VALUES: Record<number, number> = {
  1: 100,
  2: 75,
  3: 50,
  4: 25,
};

export function normalizeAnswer(input: string): string {
  if (!input) return '';

  return input
    .trim()
    .toUpperCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isAnswerMatch(
  userAnswer: string,
  correctAnswer: string,
  aliases: string[] = []
): boolean {
  const normUser = normalizeAnswer(userAnswer);

  if (!normUser) return false;

  const normCorrect = normalizeAnswer(correctAnswer);

  if (normUser === normCorrect) {
    return true;
  }

  for (const alias of aliases) {
    if (normUser === normalizeAnswer(alias)) {
      return true;
    }
  }

  // Singular / plural support
  if (
    normUser === normCorrect + 'S' ||
    normUser + 'S' === normCorrect
  ) {
    return true;
  }

  return false;
}


/* =========================================================
   GAME TIMER
   ========================================================= */

export const TEST_DURATION_SECONDS = 20 * 60;


/* =========================================================
   SESSION
   ========================================================= */

export async function getOrCreateGameSession(
  userId: string,
  eventId: string
) {
  const existing = await db.query(
    `
      SELECT *
      FROM game_sessions
      WHERE user_id = $1
        AND event_id = $2
      LIMIT 1
    `,
    [userId, eventId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const sessionId =
    `sess_${userId.replace('usr_', '')}_${Date.now()}`;

  const insertRes = await db.query(
    `
      INSERT INTO game_sessions (
        id,
        event_id,
        user_id,
        status,
        current_question,
        current_clue_level,
        current_question_value,
        total_score
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8
      )
      RETURNING *
    `,
    [
      sessionId,
      eventId,
      userId,
      'IN_PROGRESS',
      1,
      1,
      100,
      0,
    ]
  );

  const session = insertRes.rows[0];

  await logEventAction(
    'GAME_START',
    userId,
    eventId,
    {
      session_id: sessionId,
    }
  );

  return session;
}


/* =========================================================
   SESSION + PARTICIPANT TIMER
   ========================================================= */

async function getSessionWithDeadline(
  userId: string,
  eventId: string
) {
  const session =
    await getOrCreateGameSession(
      userId,
      eventId
    );

  let deadlineAt: string | null = null;
  let isExpired = false;

  if (session?.started_at) {
    const startedTime =
      new Date(
        session.started_at
      ).getTime();

    const deadlineTime =
      startedTime +
      TEST_DURATION_SECONDS * 1000;

    deadlineAt =
      new Date(
        deadlineTime
      ).toISOString();

    isExpired =
      Date.now() >= deadlineTime;
  }

  return {
    session,
    deadlineAt,
    isExpired,
  };
}


/* =========================================================
   INTEGRITY EVENT
   ========================================================= */

export async function recordIntegrityEvent(
  userId: string,
  eventId: string,
  type: string,
  metadata: Record<string, any> = {}
) {
  await logEventAction(
    'INTEGRITY_EVENT',
    userId,
    eventId,
    {
      type,
      ...metadata,
      recorded_at:
        new Date().toISOString(),
    }
  );
}


/* =========================================================
   FAST CURRENT GAME STATE
   =========================================================
   
   One SQL query gets:
   - current question
   - unlocked clues
   - existing attempt

   This avoids multiple sequential DB round trips.
   ========================================================= */

async function getCurrentQuestionState(
  session: any
) {
  const result = await db.query(
    `
      SELECT
        q.id,
        q.question_number,
        q.question_text,
        q.category,
        q.is_active,

        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', c.id,
                'level', c.level,
                'clue_text', c.clue_text,
                'points', c.points
              )
              ORDER BY c.level ASC
            )
            FROM clues c
            WHERE c.question_id = q.id
              AND c.level <= $2
          ),
          '[]'::json
        ) AS unlocked_clues,

        (
          SELECT row_to_json(qa)
          FROM question_attempts qa
          WHERE qa.session_id = $3
            AND qa.question_id = q.id
          LIMIT 1
        ) AS attempt

      FROM questions q

      WHERE q.question_number = $1
        AND q.is_active = true

      LIMIT 1
    `,
    [
      session.current_question,
      session.current_clue_level,
      session.id,
    ]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}


/* =========================================================
   PLAYER GAME STATE
   ========================================================= */

export async function getPlayerGameState(
  userId: string,
  eventId: string,
  eventStatus: string = 'LIVE'
) {
  const {
    session,
    deadlineAt,
    isExpired,
  } =
    await getSessionWithDeadline(
      userId,
      eventId
    );

  const serverNow =
    new Date().toISOString();


  /*
   * Do not expose questions before event is LIVE.
   */
  if (
    eventStatus !== 'LIVE' &&
    eventStatus !== 'PAUSED'
  ) {
    return {
      session,
      question: null,
      unlocked_clues: [],
      already_attempted: null,
      total_questions: 20,
      deadline_at: deadlineAt,
      server_now: serverNow,
      is_expired: isExpired,
    };
  }


  /*
   * Participant's own 20-minute timer expired.
   */
  if (
    isExpired &&
    session.status !== 'COMPLETED'
  ) {
    await db.query(
      `
        UPDATE game_sessions
        SET
          status = 'COMPLETED',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [session.id]
    );

    session.status = 'COMPLETED';

    await logEventAction(
      'TEST_EXPIRED_COMPLETED',
      userId,
      eventId,
      {
        session_id: session.id,
        score:
          session.total_score || 0,
      }
    );
  }


  /*
   * Do not continue for completed session.
   */
  if (
    session.status === 'COMPLETED'
  ) {
    return {
      session,
      question: null,
      unlocked_clues: [],
      already_attempted: null,
      total_questions: 20,
      deadline_at: deadlineAt,
      server_now: serverNow,
      is_expired: isExpired,
    };
  }


  /*
   * One query:
   * question + clues + attempt
   */
  const current =
    await getCurrentQuestionState(
      session
    );


  /*
   * No active question.
   */
  if (!current) {
    if (
      session.status !== 'COMPLETED'
    ) {
      await db.query(
        `
          UPDATE game_sessions
          SET
            status = 'COMPLETED',
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        [session.id]
      );

      session.status =
        'COMPLETED';
    }

    return {
      session,
      question: null,
      unlocked_clues: [],
      already_attempted: null,
      total_questions: 20,
      deadline_at: deadlineAt,
      server_now: serverNow,
      is_expired: isExpired,
    };
  }


  /*
   * Expired.
   */
  if (isExpired) {
    return {
      session,
      question: null,
      unlocked_clues: [],
      already_attempted: null,
      total_questions: 20,
      deadline_at: deadlineAt,
      server_now: serverNow,
      is_expired: true,
    };
  }


  const question = {
    id: current.id,
    question_number:
      current.question_number,
    question_text:
      current.question_text,
    category:
      current.category,
    is_active:
      current.is_active,
  };


  return {
    session,
    question,
    unlocked_clues:
      current.unlocked_clues || [],
    already_attempted:
      current.attempt || null,
    total_questions: 20,
    deadline_at: deadlineAt,
    server_now: serverNow,
    is_expired: false,
  };
}


/* =========================================================
   DEADLINE CHECK
   ========================================================= */

export async function checkEventDeadline(
  userId: string,
  eventId: string
) {
  const {
    deadlineAt,
    isExpired,
  } =
    await getSessionWithDeadline(
      userId,
      eventId
    );

  return {
    isExpired,
    deadlineAt,
  };
}


/* =========================================================
   REVEAL NEXT CLUE
   ========================================================= */

export async function revealNextClue(
  userId: string,
  eventId: string,
  requestedLevel?: number
) {
  /*
   * IMPORTANT:
   * Get session + timer only ONCE.
   */
  const {
    session,
    isExpired,
  } =
    await getSessionWithDeadline(
      userId,
      eventId
    );


  if (isExpired) {
    throw new Error(
      'TEST_EXPIRED: The 20-minute competition duration has elapsed.'
    );
  }


  if (
    session.status === 'COMPLETED'
  ) {
    throw new Error(
      'Game session already completed'
    );
  }


  if (
    session.current_clue_level >= 4
  ) {
    throw new Error(
      'Maximum clues already revealed (Level 4 / 25 points)'
    );
  }


  const nextLevel =
    session.current_clue_level + 1;


  /*
   * Prevent skipping clue levels.
   */
  if (
    requestedLevel &&
    requestedLevel !== nextLevel
  ) {
    throw new Error(
      `Sequential clue progression only. Current is Clue ${session.current_clue_level}. Next must be Clue ${nextLevel}.`
    );
  }


  /*
   * Get current question.
   */
  const qRes = await db.query(
    `
      SELECT id
      FROM questions
      WHERE question_number = $1
        AND is_active = true
      LIMIT 1
    `,
    [session.current_question]
  );


  if (
    qRes.rows.length === 0
  ) {
    throw new Error(
      'Question not found'
    );
  }


  const questionId =
    qRes.rows[0].id;


  /*
   * Check existing attempt.
   */
  const attemptRes =
    await db.query(
      `
        SELECT id
        FROM question_attempts
        WHERE session_id = $1
          AND question_id = $2
        LIMIT 1
      `,
      [
        session.id,
        questionId,
      ]
    );


  if (
    attemptRes.rows.length > 0
  ) {
    throw new Error(
      'Question has already been answered. Cannot reveal additional clues.'
    );
  }


  const nextValue =
    CLUE_POINT_VALUES[nextLevel];


  /*
   * Update session.
   */
  await db.query(
    `
      UPDATE game_sessions
      SET
        current_clue_level = $1,
        current_question_value = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `,
    [
      nextLevel,
      nextValue,
      session.id,
    ]
  );


  session.current_clue_level =
    nextLevel;

  session.current_question_value =
    nextValue;


  /*
   * Audit.
   */
  await logEventAction(
    'CLUE_REVEALED',
    userId,
    eventId,
    {
      session_id: session.id,
      question_number:
        session.current_question,
      new_level: nextLevel,
      new_value: nextValue,
    }
  );


  /*
   * Return fresh state.
   */
  return getPlayerGameState(
    userId,
    eventId,
    'LIVE'
  );
}


/* =========================================================
   SUBMIT ANSWER
   ========================================================= */

export async function submitQuestionAnswer(
  userId: string,
  eventId: string,
  rawUserAnswer: string
) {
  /*
   * Session + timer only once.
   */
  const {
    session,
    isExpired,
  } =
    await getSessionWithDeadline(
      userId,
      eventId
    );


  if (isExpired) {
    throw new Error(
      'TEST_EXPIRED: The 20-minute competition duration has elapsed.'
    );
  }


  if (
    session.status === 'COMPLETED'
  ) {
    throw new Error(
      'Game session is already completed'
    );
  }


  /*
   * Get current question.
   */
  const qRes = await db.query(
    `
      SELECT *
      FROM questions
      WHERE question_number = $1
        AND is_active = true
      LIMIT 1
    `,
    [session.current_question]
  );


  if (
    qRes.rows.length === 0
  ) {
    throw new Error(
      'Active question not found'
    );
  }


  const question =
    qRes.rows[0];


  /*
   * Duplicate submission check.
   */
  const existingAttempt =
    await db.query(
      `
        SELECT id
        FROM question_attempts
        WHERE session_id = $1
          AND question_id = $2
        LIMIT 1
      `,
      [
        session.id,
        question.id,
      ]
    );


  if (
    existingAttempt.rows.length > 0
  ) {
    throw new Error(
      'This question has already been answered for this session. Duplicate submissions prevented.'
    );
  }


  const normalizedInput =
    normalizeAnswer(
      rawUserAnswer
    );


  if (!normalizedInput) {
    throw new Error(
      'Please enter a valid answer.'
    );
  }


  const aliases =
    Array.isArray(
      question.accepted_aliases
    )
      ? question.accepted_aliases
      : (
        typeof question.accepted_aliases ===
          'string'
          ? JSON.parse(
            question.accepted_aliases
          )
          : []
      );


  const isCorrect =
    isAnswerMatch(
      normalizedInput,
      question.answer,
      aliases
    );


  const earnedPoints =
    isCorrect
      ? session.current_question_value
      : 0;


  const attemptId =
    `att_${session.id}_q${question.question_number}_${Date.now()}`;


  /*
   * Insert answer.
   */
  await db.query(
    `
      INSERT INTO question_attempts (
        id,
        session_id,
        question_id,
        highest_clue_level,
        final_question_value,
        user_answer,
        correct_answer,
        is_correct,
        earned_points
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9
      )
    `,
    [
      attemptId,
      session.id,
      question.id,
      session.current_clue_level,
      session.current_question_value,
      normalizedInput,
      question.answer.toUpperCase(),
      isCorrect,
      earnedPoints,
    ]
  );


  /*
   * Update score.
   */
  const newTotal =
    (session.total_score || 0) +
    earnedPoints;


  await db.query(
    `
      UPDATE game_sessions
      SET
        total_score = total_score + $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `,
    [
      earnedPoints,
      session.id,
    ]
  );


  session.total_score =
    newTotal;


  /*
   * Audit.
   */
  await logEventAction(
    'ANSWER_SUBMITTED',
    userId,
    eventId,
    {
      session_id: session.id,
      question_number:
        session.current_question,
      clue_level:
        session.current_clue_level,
      question_value:
        session.current_question_value,
      is_correct:
        isCorrect,
      earned_points:
        earnedPoints,
      new_total_score:
        newTotal,
    }
  );


  return {
    is_correct: isCorrect,
    earned_points: earnedPoints,
    total_score: newTotal,
    correct_answer:
      question.answer.toUpperCase(),
    user_answer:
      normalizedInput,
    question_number:
      session.current_question,
  };
}


/* =========================================================
   NEXT QUESTION
   ========================================================= */

export async function advanceToNextQuestion(
  userId: string,
  eventId: string
) {
  /*
   * Session + timer only once.
   */
  const {
    session,
    isExpired,
  } =
    await getSessionWithDeadline(
      userId,
      eventId
    );


  if (isExpired) {
    throw new Error(
      'TEST_EXPIRED: The 20-minute competition duration has elapsed.'
    );
  }


  if (
    session.status === 'COMPLETED'
  ) {
    return {
      session,
      is_complete: true,
    };
  }


  /*
   * Get current question ID.
   */
  const qRes = await db.query(
    `
      SELECT id
      FROM questions
      WHERE question_number = $1
        AND is_active = true
      LIMIT 1
    `,
    [session.current_question]
  );


  /*
   * Ensure answer exists.
   */
  if (
    qRes.rows.length > 0
  ) {
    const attempt =
      await db.query(
        `
          SELECT id
          FROM question_attempts
          WHERE session_id = $1
            AND question_id = $2
          LIMIT 1
        `,
        [
          session.id,
          qRes.rows[0].id,
        ]
      );


    if (
      attempt.rows.length === 0
    ) {
      throw new Error(
        'Cannot advance without submitting an answer for the current question.'
      );
    }
  }


  const nextQuestionNum =
    session.current_question + 1;


  /*
   * Finish after Q20.
   */
  if (
    nextQuestionNum > 20
  ) {
    await db.query(
      `
        UPDATE game_sessions
        SET
          status = 'COMPLETED',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [session.id]
    );


    session.status =
      'COMPLETED';


    await logEventAction(
      'GAME_COMPLETED',
      userId,
      eventId,
      {
        session_id: session.id,
        final_score:
          session.total_score,
      }
    );


    return {
      session,
      is_complete: true,
    };
  }


  /*
   * Move to next question.
   */
  await db.query(
    `
      UPDATE game_sessions
      SET
        current_question = $1,
        current_clue_level = 1,
        current_question_value = 100,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `,
    [
      nextQuestionNum,
      session.id,
    ]
  );


  session.current_question =
    nextQuestionNum;

  session.current_clue_level =
    1;

  session.current_question_value =
    100;


  await logEventAction(
    'QUESTION_COMPLETED',
    userId,
    eventId,
    {
      session_id: session.id,
      next_question:
        nextQuestionNum,
    }
  );


  return {
    session,
    is_complete: false,
  };
}


/* =========================================================
   RESULTS
   ========================================================= */

export async function getGameResultsSummary(
  userId: string,
  eventId: string
) {
  const session =
    await getOrCreateGameSession(
      userId,
      eventId
    );


  const attemptsRes =
    await db.query(
      `
        SELECT
          qa.*,
          q.question_number,
          q.question_text,
          q.category
        FROM question_attempts qa
        JOIN questions q
          ON qa.question_id = q.id
        WHERE qa.session_id = $1
        ORDER BY q.question_number ASC
      `,
      [session.id]
    );


  const attempts =
    attemptsRes.rows;


  let correctCount = 0;
  let incorrectCount = 0;
  let totalCluesUsed = 0;

  let count100 = 0;
  let count75 = 0;
  let count50 = 0;
  let count25 = 0;


  for (const a of attempts) {
    totalCluesUsed +=
      a.highest_clue_level;


    if (a.is_correct) {
      correctCount++;


      if (
        a.earned_points === 100
      ) {
        count100++;
      } else if (
        a.earned_points === 75
      ) {
        count75++;
      } else if (
        a.earned_points === 50
      ) {
        count50++;
      } else if (
        a.earned_points === 25
      ) {
        count25++;
      }
    } else {
      incorrectCount++;
    }
  }


  return {
    session,
    total_score:
      session.total_score,
    max_possible_score: 2000,
    total_questions:
      attempts.length,
    correct_count:
      correctCount,
    incorrect_count:
      incorrectCount,
    clues_used:
      totalCluesUsed,
    answers_100_pt:
      count100,
    answers_75_pt:
      count75,
    answers_50_pt:
      count50,
    answers_25_pt:
      count25,
    attempts,
  };
}