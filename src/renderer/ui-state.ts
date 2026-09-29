// Pure map from app state to what the transport controls should show. No DOM —
// app.ts applies the descriptor, and the mapping is unit-testable in a plain
// node environment (test/history.test.ts, alongside the history module).

// 'starting' exists so a stop pressed while the session/capture is still coming
// up is honoured instead of silently dropped.
export type State = 'idle' | 'starting' | 'recording' | 'finalizing' | 'answering';

export interface StateUi {
  recordLabel: string;
  dotClass: string;
  statusText: string;
  /**
   * The ask box stays usable while an answer streams (asking aborts the old
   * session), but not while audio capture is in any stage of flight.
   */
  askLocked: boolean;
}

/** `readyText` is caller-supplied because the idle line names the live hotkey. */
export function stateUi(state: State, readyText: string): StateUi {
  const askLocked = state === 'starting' || state === 'recording' || state === 'finalizing';
  switch (state) {
    case 'idle':
      return { recordLabel: 'Record', dotClass: 'dot', statusText: readyText, askLocked };
    case 'starting':
      return { recordLabel: 'Starting…', dotClass: 'dot busy', statusText: 'Opening the microphone feed…', askLocked };
    case 'recording':
      return { recordLabel: 'Stop & Answer', dotClass: 'dot recording', statusText: 'Recording call audio…', askLocked };
    case 'finalizing':
      return { recordLabel: 'Record', dotClass: 'dot busy', statusText: 'Finalizing transcript…', askLocked };
    case 'answering':
      return { recordLabel: 'Record', dotClass: 'dot busy', statusText: 'Generating answer…', askLocked };
  }
}
