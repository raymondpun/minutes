export type MeetingStatus =
  | 'setup'
  | 'recording'
  | 'transcribing'
  | 'identifying'
  | 'awaiting_speakers'
  | 'drafting'
  | 'complete'
  | 'failed';

export interface MeetingMeta {
  id: string;
  /** e.g. "Board Meeting", "Finance Committee" -- drives the minutes heading. */
  title: string;
  /** e.g. "Board of Directors", "Management Committee". */
  body: string;
  location: string;
  /** ISO date of the meeting. */
  date: string;
  /** Local start time as HH:mm, captured when recording begins. */
  startedAt?: string;
  endedAt?: string;
  chair?: string;
  secretary?: string;
  /** Names known up front, e.g. from a calendar invite. Helps speaker mapping. */
  expectedAttendees: string[];
  apologies: string[];
  agenda: string[];
  status: MeetingStatus;
  /** Human-readable note about what the pipeline is doing right now. */
  progress?: string;
  error?: string;
  durationSeconds?: number;
  createdAt: string;
}

/** One line of the verbatim transcript. Cantonese stays in 口語. */
export interface TranscriptSegment {
  /** Seconds from start of recording. */
  start: number;
  end: number;
  /** "Speaker 1" etc. before identification, a real name after. */
  speaker: string;
  /** Verbatim. Written Cantonese where Cantonese was spoken, Latin script for English. */
  text: string;
  /** Rough language mix, for debugging transcription quality. */
  language?: 'yue' | 'en' | 'mixed' | 'other';
}

export interface SpeakerIdentification {
  /** The diarization label, e.g. "Speaker 1". */
  speakerId: string;
  /** Best guess at the real name, or null if never introduced. */
  name: string | null;
  /** Role or title if stated, e.g. "Finance Director". */
  role?: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** Verbatim words that justified the mapping, so you can check it. */
  evidence?: string | null;
  evidenceTime?: number | null;
  /** How much this speaker talked -- helps you spot a mis-split speaker. */
  segmentCount: number;
}

/** Every substantive claim in the minutes points back at the recording. */
export interface Evidence {
  /** Seconds from start, so you can jump to it in the audio. */
  time: number;
  /** Verbatim quote in the language actually spoken. */
  quote: string;
}

export interface ActionItem {
  owner: string;
  action: string;
  dueDate: string | null;
  evidence: Evidence | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface Motion {
  text: string;
  proposedBy: string | null;
  secondedBy: string | null;
  outcome: 'carried' | 'carried unanimously' | 'defeated' | 'withdrawn' | 'deferred' | 'unclear';
  votesFor: number | null;
  votesAgainst: number | null;
  abstentions: number | null;
  evidence: Evidence | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface MinuteItem {
  /** e.g. "4" or "4.2". */
  number: string;
  heading: string;
  /** Formal English prose. Past tense, third person, no direct address. */
  discussion: string;
  /** RESOLVED THAT ... statements. */
  resolutions: string[];
  motions: Motion[];
  actions: ActionItem[];
  evidence: Evidence[];
}

export interface Minutes {
  bodyName: string;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  location: string;
  chair: string | null;
  secretary: string | null;
  present: string[];
  inAttendance: string[];
  apologies: string[];
  items: MinuteItem[];
  /** Things the model could not resolve and a human must check before sign-off. */
  flaggedForReview: string[];
  nextMeeting: string | null;
}

/** Server -> client over the websocket during recording. */
export type ServerEvent =
  | { type: 'ready'; meetingId: string }
  | { type: 'live'; start: number; end: number; text: string }
  | { type: 'chunk_ack'; index: number; seconds: number }
  | { type: 'error'; message: string };
