import { useState } from 'react';
import type { CreateMeetingInput } from '../lib/api';

interface Props {
  onStart: (input: CreateMeetingInput) => void;
  onCancel: () => void;
  busy: boolean;
}

/**
 * Filled in before the meeting starts, in the thirty seconds while people are
 * sitting down. Everything here is optional except the title -- a form that
 * blocks you from recording is a form that makes you miss the first five
 * minutes.
 */
export default function Setup({ onStart, onCancel, busy }: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [location, setLocation] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [chair, setChair] = useState('');
  const [attendees, setAttendees] = useState('');
  const [apologies, setApologies] = useState('');
  const [agenda, setAgenda] = useState('');

  const submit = () => {
    onStart({
      title: title.trim() || 'Meeting',
      body: body.trim(),
      location: location.trim(),
      date,
      chair: chair.trim() || undefined,
      expectedAttendees: splitLines(attendees),
      apologies: splitLines(apologies),
      agenda: splitLines(agenda),
    });
  };

  return (
    <div>
      <h1>New meeting</h1>
      <p className="sub">
        All optional except the title. You can start recording and fix the rest later.
      </p>

      <div className="card">
        <label htmlFor="title">Meeting title</label>
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Q3 Board Meeting"
          autoComplete="off"
        />

        <label htmlFor="body">Body</label>
        <input
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Board of Directors"
          autoComplete="off"
        />
        <p className="hint">Appears as the heading of the minutes.</p>

        <div className="row">
          <div>
            <label htmlFor="date">Date</label>
            <input
              id="date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="chair">Chair</label>
            <input
              id="chair"
              value={chair}
              onChange={(e) => setChair(e.target.value)}
              placeholder="Optional"
              autoComplete="off"
            />
          </div>
        </div>

        <label htmlFor="location">Location</label>
        <input
          id="location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Boardroom, 28/F"
          autoComplete="off"
        />
      </div>

      <div className="card">
        <label htmlFor="attendees">Expected attendees</label>
        <textarea
          id="attendees"
          value={attendees}
          onChange={(e) => setAttendees(e.target.value)}
          placeholder={'Raymond Pun\nCheryl Lau\n陳大文'}
        />
        <p className="hint">
          One per line. This is the single biggest accuracy win available: with a
          name list, matching voices to people becomes a matching problem instead
          of a guessing problem, and the spelling in the minutes will be right.
        </p>

        <label htmlFor="apologies">Apologies for absence</label>
        <textarea
          id="apologies"
          value={apologies}
          onChange={(e) => setApologies(e.target.value)}
          placeholder="One per line"
        />
      </div>

      <div className="card">
        <label htmlFor="agenda">Agenda</label>
        <textarea
          id="agenda"
          value={agenda}
          onChange={(e) => setAgenda(e.target.value)}
          placeholder={'Apologies\nMinutes of the previous meeting\nQ3 financials\nAOB'}
          style={{ minHeight: 110 }}
        />
        <p className="hint">
          One item per line. The minutes are structured around this where the
          discussion matches, with extra items added for anything raised off-agenda.
        </p>
      </div>

      <div className="stack">
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Starting…' : 'Continue'}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function splitLines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
