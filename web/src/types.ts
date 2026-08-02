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
  title: string;
  body: string;
  location: string;
  date: string;
  startedAt?: string;
  endedAt?: string;
  chair?: string;
  secretary?: string;
  expectedAttendees: string[];
  apologies: string[];
  agenda: string[];
  status: MeetingStatus;
  progress?: string;
  error?: string;
  durationSeconds?: number;
  createdAt: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
  language?: 'yue' | 'en' | 'mixed' | 'other';
}

export interface SpeakerIdentification {
  speakerId: string;
  name: string | null;
  role?: string | null;
  confidence: 'high' | 'medium' | 'low';
  evidence?: string | null;
  evidenceTime?: number | null;
  segmentCount: number;
}

export interface LiveLine {
  start: number;
  end: number;
  text: string;
}

export interface Evidence {
  time: number;
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
  outcome:
    | 'carried'
    | 'carried unanimously'
    | 'defeated'
    | 'withdrawn'
    | 'deferred'
    | 'unclear';
  votesFor: number | null;
  votesAgainst: number | null;
  abstentions: number | null;
  evidence: Evidence | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface MinuteItem {
  number: string;
  heading: string;
  discussion: string;
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
  flaggedForReview: string[];
  nextMeeting: string | null;
}

export interface MeetingSnapshot {
  meta: MeetingMeta;
  transcript: TranscriptSegment[];
  speakers: SpeakerIdentification[];
  minutes: Minutes | null;
  markdown: string | null;
  live: LiveLine[];
  audioSeconds: number;
  audioAvailable: boolean;
}
