export type MeetingStatus =
  | 'setup'
  | 'roll_call'
  | 'recording'
  | 'paused'
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
  /** Position in the recording, in seconds, where the roll call ended. */
  rollCallEndedAt?: number;
  /** Where recording was paused, in recording-seconds. */
  pauses: Array<{ at: number; label?: string }>;
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

/**
 * A rolling summary block produced every few minutes during the meeting. This
 * is what makes an hour-old discussion reviewable in the room — a dozen
 * timestamped topics can be scanned, an hour of raw transcript cannot.
 */
export interface DigestBlock {
  start: number;
  end: number;
  heading: string;
  bullets: string[];
  /** Provisional — heard mid-discussion, before the outcome was known. */
  decisions: string[];
  continuesPrevious: boolean;
}

export interface Evidence {
  time: number;
  quote: string;
}

export interface ActionItem {
  owner: string;
  action: string;
  actionZh?: string | null;
  dueDate: string | null;
  evidence: Evidence | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface Motion {
  text: string;
  textZh?: string | null;
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
  headingZh?: string | null;
  discussion: string;
  discussionZh?: string | null;
  resolutions: string[];
  /** Parallel to resolutions, index for index. */
  resolutionsZh?: string[];
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
  nextMeetingZh?: string | null;
}

export interface MeetingSnapshot {
  meta: MeetingMeta;
  transcript: TranscriptSegment[];
  speakers: SpeakerIdentification[];
  minutes: Minutes | null;
  markdown: string | null;
  live: LiveLine[];
  digest: DigestBlock[];
  audioSeconds: number;
  audioAvailable: boolean;
}
