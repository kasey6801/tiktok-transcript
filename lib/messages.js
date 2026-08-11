// Message-type constants and the job-state enum shared by every context.
// All runtime messages carry target: "background" | "offscreen"; listeners
// ignore messages addressed elsewhere.

export const MSG = {
  TRANSCRIBE_START: "transcribe:start",
  JOB_CURRENT: "job:current",
  HISTORY_LIST: "history:list",
  TRANSCRIPT_GET: "transcript:get",
  TRANSCRIPT_CLEAR: "transcript:clear",
  HISTORY_CLEAR_ALL: "history:clearAll",
  HISTORY_RESTORE_ALL: "history:restoreAll",
  ASR_RUN: "asr:run",
  ASR_PROGRESS: "asr:progress",
  ASR_DONE: "asr:done",
  ASR_ERROR: "asr:error",
};

export const STATE = {
  QUEUED: "queued",
  FETCHING: "fetching",
  PARSING_CAPTIONS: "parsing_captions",
  DOWNLOADING_AUDIO: "downloading_audio",
  LOADING_MODEL: "loading_model",
  TRANSCRIBING: "transcribing",
  DONE: "done",
  ERROR: "error",
  NO_SPEECH: "no_speech",
};

export const TERMINAL_STATES = new Set([STATE.DONE, STATE.ERROR, STATE.NO_SPEECH]);
