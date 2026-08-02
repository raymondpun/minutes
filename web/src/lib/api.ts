import type { MeetingMeta, MeetingSnapshot, SpeakerIdentification } from '../types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export interface CreateMeetingInput {
  title: string;
  body: string;
  location: string;
  date: string;
  chair?: string;
  secretary?: string;
  expectedAttendees: string[];
  apologies: string[];
  agenda: string[];
}

export const api = {
  health: () =>
    request<{
      ok: boolean;
      project: string;
      location: string;
      models: Record<string, string>;
      singlePassTranscription: boolean;
      retainAudioDays: number | 'forever';
    }>('/api/health'),

  listMeetings: () => request<MeetingMeta[]>('/api/meetings'),

  createMeeting: (input: CreateMeetingInput) =>
    request<MeetingMeta>('/api/meetings', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getMeeting: (id: string) => request<MeetingSnapshot>(`/api/meetings/${id}`),

  startMeeting: (id: string) =>
    request<MeetingMeta>(`/api/meetings/${id}/start`, { method: 'POST' }),

  rollCallDone: (id: string) =>
    request<MeetingMeta>(`/api/meetings/${id}/roll-call-done`, { method: 'POST' }),

  pauseMeeting: (id: string) =>
    request<MeetingMeta>(`/api/meetings/${id}/pause`, { method: 'POST' }),

  resumeMeeting: (id: string) =>
    request<MeetingMeta>(`/api/meetings/${id}/resume`, { method: 'POST' }),

  stopMeeting: (id: string) =>
    request<MeetingMeta>(`/api/meetings/${id}/stop`, { method: 'POST' }),

  confirmSpeakers: (id: string, speakers: SpeakerIdentification[]) =>
    request<{ speakers: SpeakerIdentification[] }>(`/api/meetings/${id}/speakers`, {
      method: 'PUT',
      body: JSON.stringify({ speakers }),
    }),

  regenerate: (id: string) =>
    request<{ ok: boolean }>(`/api/meetings/${id}/minutes/regenerate`, {
      method: 'POST',
    }),

  deleteMeeting: (id: string) =>
    request<{ ok: boolean }>(`/api/meetings/${id}`, { method: 'DELETE' }),

  clipUrl: (id: string, at: number) =>
    `/api/meetings/${id}/clip?at=${encodeURIComponent(Math.max(0, Math.round(at)))}`,

  docxUrl: (id: string) => `/api/meetings/${id}/minutes.docx`,
  minutesUrl: (id: string) => `/api/meetings/${id}/minutes.md`,
  transcriptUrl: (id: string) => `/api/meetings/${id}/transcript.txt`,
};
