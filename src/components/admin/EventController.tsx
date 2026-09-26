import React, { useState } from 'react';
import { Play, Pause, Square, RotateCcw, AlertCircle, CheckCircle2, ShieldAlert, Sparkles, Radio, Layers } from 'lucide-react';
import { EventInfo } from '../../types/index.js';

interface EventControllerProps {
  event: EventInfo;
  onAction: (action: 'START' | 'START_NOW' | 'PAUSE' | 'RESUME' | 'END' | 'RESET') => Promise<void>;
  onPrepareNextEvent?: (customName?: string) => Promise<void>;
  isLoading: boolean;
}

export const EventController: React.FC<EventControllerProps> = ({
  event,
  onAction,
  onPrepareNextEvent,
  isLoading,
}) => {
  const [showStartConfirm, setShowStartConfirm] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showPrepareNextModal, setShowPrepareNextModal] = useState(false);
  const [customEventName, setCustomEventName] = useState('');

  const getStatusBadge = () => {
    switch (event.status) {
      case 'LIVE':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-xs font-mono font-bold">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            LIVE
          </span>
        );
      case 'COUNTDOWN':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-xs font-mono font-bold animate-pulse">
            <Radio className="w-3.5 h-3.5 animate-spin" />
            COUNTDOWN (0{event.countdown_remaining_seconds ?? 5}s)
          </span>
        );
      case 'PAUSED':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40 text-xs font-mono font-bold">
            <Pause className="w-3.5 h-3.5" />
            PAUSED
          </span>
        );
      case 'ENDED':
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-rose-500/20 text-rose-400 border border-rose-500/40 text-xs font-mono font-bold">
            <CheckCircle2 className="w-3.5 h-3.5" />
            ENDED
          </span>
        );
      default: // WAITING
        return (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded bg-slate-800 text-amber-300 border border-amber-500/30 text-xs font-mono font-bold">
            <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
            WAITING
          </span>
        );
    }
  };

  const handleStartConfirm = async () => {
    setShowStartConfirm(false);
    await onAction('START_NOW');
  };

  const handlePrepareNextConfirm = async () => {
    if (onPrepareNextEvent) {
      await onPrepareNextEvent(customEventName.trim() || undefined);
      setShowPrepareNextModal(false);
      setCustomEventName('');
    }
  };

  return (
    <>
      {/* START CONFIRMATION MODAL */}
      {showStartConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-950/85 backdrop-blur-md">
          <div className="w-full max-w-md bg-navy-900 border border-cyan-500/50 rounded-xl p-6 shadow-2xl text-center">
            <div className="p-3.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 w-fit mx-auto mb-4">
              <Sparkles className="w-8 h-8 text-cyan-400" />
            </div>

            <h3 className="text-xl font-display font-extrabold text-white mb-2">
              START CLUE QUEST?
            </h3>

            <div className="bg-navy-950/90 rounded-lg p-4 border border-slate-800 text-xs font-mono text-slate-300 space-y-2 mb-6 text-left">
              <p className="flex items-center gap-2 text-emerald-400 font-bold">
                ✓ 20 questions are validated and ready.
              </p>
              <p className="flex items-center gap-2 text-cyan-300">
                ✓ 40 participant slots configured.
              </p>
              <p className="text-slate-400 pt-1">
                Once started, all connected participants will receive the synchronized 5-second countdown broadcast.
              </p>
            </div>

            <p className="text-xs font-mono text-white mb-6 uppercase tracking-wide font-bold">
              Are you ready to begin?
            </p>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setShowStartConfirm(false)}
                className="px-5 py-2.5 rounded text-xs font-mono text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 transition"
              >
                CANCEL
              </button>
              <button
                onClick={handleStartConfirm}
                disabled={isLoading}
                className="px-6 py-2.5 rounded font-mono font-extrabold text-xs uppercase tracking-wider bg-cyan-500 hover:bg-cyan-400 text-navy-950 shadow-cyan-glow flex items-center gap-2 transition"
              >
                <Play className="w-4 h-4 fill-current" />
                {isLoading ? 'STARTING...' : 'START NOW'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PREPARE NEXT EVENT CONFIRMATION MODAL */}
      {showPrepareNextModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-950/85 backdrop-blur-md">
          <div className="w-full max-w-lg bg-navy-900 border border-indigo-500/50 rounded-xl p-6 shadow-2xl text-center">
            <div className="p-3.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 w-fit mx-auto mb-4">
              <Layers className="w-8 h-8 text-indigo-400" />
            </div>

            <h3 className="text-xl font-display font-extrabold text-white mb-2 tracking-wide">
              PREPARE NEXT EVENT?
            </h3>

            <p className="text-xs text-slate-300 font-sans mb-4">
              This creates a completely new tournament event cycle while keeping all historical data safe.
            </p>

            <div className="bg-navy-950/90 rounded-lg p-4 border border-slate-800 text-xs font-mono text-slate-300 space-y-2 mb-5 text-left">
              <p className="flex items-center gap-2 text-indigo-300 font-bold">
                ✓ A new event will be created in WAITING status.
              </p>
              <p className="flex items-center gap-2 text-emerald-400 font-bold">
                ✓ All 40 participant slots will be cleared for fresh registration.
              </p>
              <p className="flex items-center gap-2 text-cyan-300">
                ✓ Previous event game sessions and answer history will NOT be deleted.
              </p>
              <p className="flex items-center gap-2 text-slate-300">
                ✓ Questions and clues will NOT be deleted.
              </p>
              <p className="flex items-center gap-2 text-slate-300">
                ✓ Admin accounts will NOT be affected.
              </p>
              <p className="flex items-center gap-2 text-slate-400">
                ✓ Existing participant accounts/slots remain available for reuse.
              </p>
            </div>

            <div className="text-left mb-6">
              <label className="block text-[11px] font-mono text-slate-400 uppercase tracking-wider mb-1.5 font-semibold">
                EVENT NAME (OPTIONAL)
              </label>
              <input
                type="text"
                value={customEventName}
                onChange={(e) => setCustomEventName(e.target.value)}
                placeholder={`e.g. ${event.name} - Round 2`}
                className="w-full bg-navy-950 border border-slate-700 focus:border-indigo-400 rounded px-3 py-2 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
              <p className="text-[10px] text-slate-500 font-sans mt-1">
                Leave blank to auto-generate sequential event title.
              </p>
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowPrepareNextModal(false);
                  setCustomEventName('');
                }}
                disabled={isLoading}
                className="px-5 py-2.5 rounded text-xs font-mono text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 transition"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={handlePrepareNextConfirm}
                disabled={isLoading}
                className="px-6 py-2.5 rounded font-mono font-extrabold text-xs uppercase tracking-wider bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 flex items-center gap-2 transition"
              >
                <Layers className="w-4 h-4" />
                {isLoading ? 'PREPARING NEXT EVENT...' : 'CONFIRM & PREPARE NEXT EVENT'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="tech-card rounded-lg p-5 border border-cyan-500/30 mb-8">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          {/* Left: Info */}
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-xl font-display font-extrabold text-white tracking-wide">
                EVENT CONTROL
              </h2>
              {getStatusBadge()}
            </div>
            <p className="text-xs text-slate-400 font-mono">
              EVENT: {event.name} • MAX PARTICIPANTS: {event.max_players} • COORDINATOR AUTHORITATIVE
            </p>
          </div>

          {/* Right: Actions */}
          <div className="flex flex-wrap items-center gap-2.5">
            {event.status === 'WAITING' && (
              <button
                onClick={() => setShowStartConfirm(true)}
                disabled={isLoading}
                className="px-6 py-3 rounded font-mono font-extrabold text-xs uppercase tracking-wider bg-cyan-500 hover:bg-cyan-400 text-navy-950 transition shadow-cyan-glow flex items-center gap-2 border border-cyan-300"
              >
                <Play className="w-4 h-4 fill-current" />
                {isLoading ? 'STARTING...' : 'START NOW'}
              </button>
            )}

            {event.status === 'COUNTDOWN' && (
              <div className="flex items-center gap-2 bg-navy-950 border border-cyan-500/40 px-4 py-2 rounded text-xs font-mono text-cyan-300">
                <Radio className="w-4 h-4 animate-spin text-cyan-400" />
                <span>BROADCASTING COUNTDOWN (0{event.countdown_remaining_seconds ?? 5}s)</span>
              </div>
            )}

            {event.status === 'LIVE' && (
              <>
                <button
                  onClick={() => onAction('PAUSE')}
                  disabled={isLoading}
                  className="px-4 py-2.5 rounded font-mono font-bold text-xs uppercase tracking-wider bg-amber-500 hover:bg-amber-400 text-navy-950 transition flex items-center gap-2"
                >
                  <Pause className="w-4 h-4 fill-current" />
                  PAUSE
                </button>
                <button
                  onClick={() => onAction('END')}
                  disabled={isLoading}
                  className="px-4 py-2.5 rounded font-mono font-bold text-xs uppercase tracking-wider bg-rose-600 hover:bg-rose-500 text-white transition flex items-center gap-2"
                >
                  <Square className="w-4 h-4 fill-current" />
                  END EVENT
                </button>
              </>
            )}

            {event.status === 'PAUSED' && (
              <>
                <button
                  onClick={() => onAction('RESUME')}
                  disabled={isLoading}
                  className="px-4 py-2.5 rounded font-mono font-bold text-xs uppercase tracking-wider bg-emerald-500 hover:bg-emerald-400 text-navy-950 transition flex items-center gap-2"
                >
                  <Play className="w-4 h-4 fill-current" />
                  RESUME
                </button>
                <button
                  onClick={() => onAction('END')}
                  disabled={isLoading}
                  className="px-4 py-2.5 rounded font-mono font-bold text-xs uppercase tracking-wider bg-rose-600 hover:bg-rose-500 text-white transition flex items-center gap-2"
                >
                  <Square className="w-4 h-4 fill-current" />
                  END EVENT
                </button>
              </>
            )}

            {/* PREPARE NEXT EVENT BUTTON (Distinct styling & safe new event cycle) */}
            <button
              onClick={() => setShowPrepareNextModal(true)}
              disabled={isLoading}
              className="px-4 py-2.5 rounded font-mono font-bold text-xs uppercase tracking-wider bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 hover:border-indigo-400 transition flex items-center gap-2 shadow-sm"
              title="Prepare a brand new event round while preserving all past event history"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              PREPARE NEXT EVENT
            </button>

            {(event.status === 'ENDED' || event.status === 'LIVE' || event.status === 'PAUSED') && (
              confirmReset ? (
                <div className="flex items-center gap-1.5 bg-rose-950/80 border border-rose-500/50 p-1 rounded">
                  <span className="text-[10px] font-mono text-rose-300 px-2">Reset sessions to WAITING?</span>
                  <button
                    onClick={() => {
                      onAction('RESET');
                      setConfirmReset(false);
                    }}
                    className="px-2.5 py-1 text-[10px] font-mono font-bold bg-rose-600 text-white rounded hover:bg-rose-500"
                  >
                    CONFIRM RESET
                  </button>
                  <button
                    onClick={() => setConfirmReset(false)}
                    className="px-2 py-1 text-[10px] font-mono text-slate-400 hover:text-white"
                  >
                    CANCEL
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmReset(true)}
                  disabled={isLoading}
                  className="px-3.5 py-2.5 rounded font-mono text-xs text-slate-400 hover:text-white bg-slate-900 border border-slate-700/60 hover:border-slate-500 transition flex items-center gap-1.5"
                  title="Reset tournament sessions to WAITING state"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  RESET
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </>
  );
};

