import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { GameStateResponse } from '../types/index.js';
import { request, ApiError } from '../utils/api.js';
import { useAuth } from './AuthContext.js';

export interface PollingScheduleConfig {
  waitingMs: number;
  countdownMs: number;
  liveMs: number;
  pausedMs: number;
  hiddenMs: number;
}

export const POLLING_SCHEDULE: PollingScheduleConfig = {
  waitingMs: 3000,    // 3s while WAITING in lobby
  countdownMs: 1000,  // 1s during 5s sync COUNTDOWN
  liveMs: 4000,       // 4s during LIVE 20-minute gameplay
  pausedMs: 3000,     // 3s while event is PAUSED
  hiddenMs: 10000,    // 10s when participant tab is HIDDEN in background
};

/**
 * Pure helper function to compute the exact polling interval for the current game state.
 * Returns null when continuous polling should be stopped (e.g. COMPLETED or ENDED).
 */
export function getPollingInterval(
  eventStatus?: string | null,
  sessionStatus?: string | null,
  isTabHidden: boolean = false
): number | null {
  // If participant finished quest or event has concluded, stop continuous polling
  if (sessionStatus === 'COMPLETED' || eventStatus === 'ENDED') {
    return null;
  }

  // When tab is hidden in the background, poll at conservative 10s rate
  if (isTabHidden) {
    return POLLING_SCHEDULE.hiddenMs;
  }

  // Active foreground intervals by authoritative state
  switch (eventStatus) {
    case 'COUNTDOWN':
      return POLLING_SCHEDULE.countdownMs;
    case 'LIVE':
      return POLLING_SCHEDULE.liveMs;
    case 'PAUSED':
      return POLLING_SCHEDULE.pausedMs;
    case 'WAITING':
    default:
      return POLLING_SCHEDULE.waitingMs;
  }
}

interface GameContextType {
  gameState: GameStateResponse | null;
  loading: boolean;
  isReconnecting: boolean;
  countdown: number | null;
  error: string | null;
  isTabHidden: boolean;
  fetchGameState: () => Promise<void>;
  revealClue: (requestedLevel?: number) => Promise<void>;
  submitAnswer: (answer: string) => Promise<{
    is_correct: boolean;
    earned_points: number;
    total_score: number;
    correct_answer: string;
    user_answer: string;
  }>;
  nextQuestion: () => Promise<boolean>; // returns true if game completed
  clearError: () => void;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

export const GameProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [gameState, setGameState] = useState<GameStateResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTabHidden, setIsTabHidden] = useState<boolean>(() => {
    return typeof document !== 'undefined' ? document.hidden : false;
  });

  // Guard flag to prevent overlapping / concurrent /api/game/state requests
  const isFetchingRef = useRef<boolean>(false);

  const fetchGameState = useCallback(async () => {
    if (!user || user.role !== 'PLAYER') {
      setLoading(false);
      return;
    }

    // Overlapping request protection: skip if an in-flight fetch is currently active
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    try {
      const data = await request<GameStateResponse>('/game/state');

      // Server Authoritative Countdown Handling
      if (data.event.status === 'COUNTDOWN' && data.event.countdown_started_at) {
        const elapsedMs = Date.now() - new Date(data.event.countdown_started_at).getTime();
        const elapsedSec = elapsedMs / 1000;
        const remaining = Math.max(0, Math.ceil(5 - elapsedSec));
        setCountdown(remaining);
      } else if (data.event.status === 'LIVE') {
        setCountdown((prev) => {
          if (prev !== null && prev > 0) {
            setTimeout(() => setCountdown(null), 800);
            return 0;
          }
          return null;
        });
      } else {
        setCountdown(null);
      }

      setGameState(data);
      setIsReconnecting(false);
      setError(null);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 0) {
        setIsReconnecting(true);
      } else {
        setError(err.message || 'Unable to synchronize game state');
      }
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
    }
  }, [user]);

  // 1. Initial State Fetch on Mount / User Change
  useEffect(() => {
    if (user && user.role === 'PLAYER') {
      fetchGameState();
    }
  }, [user, fetchGameState]);

  // 2. Page Visibility Listener (Browser Page Visibility API)
  useEffect(() => {
    const handleVisibilityChange = () => {
      const hidden = typeof document !== 'undefined' ? document.hidden : false;
      setIsTabHidden(hidden);
      if (!hidden && user && user.role === 'PLAYER') {
        // Tab restored to active foreground: immediately fetch fresh game state
        fetchGameState();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }
  }, [user, fetchGameState]);

  // 3. Dynamic State-Aware Polling Scheduler (Single Loop with Cleanup)
  useEffect(() => {
    if (!user || user.role !== 'PLAYER') return;

    const eventStatus = gameState?.event?.status || 'WAITING';
    const sessionStatus = gameState?.session?.status;
    const intervalMs = getPollingInterval(eventStatus, sessionStatus, isTabHidden);

    if (intervalMs === null) {
      // Completed or ended: no continuous polling interval scheduled
      return;
    }

    const intervalId = setInterval(() => {
      fetchGameState();
    }, intervalMs);

    return () => {
      clearInterval(intervalId);
    };
  }, [user, gameState?.event?.status, gameState?.session?.status, isTabHidden, fetchGameState]);

  const revealClue = async (requestedLevel?: number) => {
    if (!gameState) return;
    try {
      setError(null);
      const updated = await request<GameStateResponse>('/game/reveal-clue', {
        method: 'POST',
        body: JSON.stringify({ requested_level: requestedLevel }),
      });
      // State updated directly from action response (0 extra network fetches)
      setGameState(updated);
    } catch (err: any) {
      setError(err.message || 'Could not reveal clue');
      throw err;
    }
  };

  const submitAnswer = async (answer: string) => {
    try {
      setError(null);
      const result = await request<{
        is_correct: boolean;
        earned_points: number;
        total_score: number;
        correct_answer: string;
        user_answer: string;
      }>('/game/submit-answer', {
        method: 'POST',
        body: JSON.stringify({ answer: answer.trim().toUpperCase() }),
      });

      // Synchronize latest state immediately after submission (exactly 1 refresh)
      await fetchGameState();
      return result;
    } catch (err: any) {
      setError(err.message || 'Could not submit answer');
      throw err;
    }
  };

  const nextQuestion = async (): Promise<boolean> => {
    try {
      setError(null);
      const res = await request<{ is_complete: boolean } & GameStateResponse>('/game/next-question', {
        method: 'POST',
      });
      // State updated directly from action response (0 extra network fetches)
      setGameState(res);
      return res.is_complete || false;
    } catch (err: any) {
      setError(err.message || 'Could not advance to next question');
      throw err;
    }
  };

  const clearError = () => setError(null);

  return (
    <GameContext.Provider
      value={{
        gameState,
        loading,
        isReconnecting,
        countdown,
        error,
        isTabHidden,
        fetchGameState,
        revealClue,
        submitAnswer,
        nextQuestion,
        clearError,
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return context;
};
