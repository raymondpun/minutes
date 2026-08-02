import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { Evidence, MinuteItem, Minutes } from '../types.js';
import { outcomeZh, stripResolvedZh, votesZh } from './minutes.js';

/**
 * Render the minutes as a Word document.
 *
 * Markdown is fine for a developer and useless to a company secretary. Formal
 * minutes get tabled, circulated, put on letterhead and signed, and every one
 * of those steps happens in Word. This is the format the document actually has
 * to arrive in.
 *
 * Latin text is set in a serif face and CJK in 明體 via the eastAsia font hint,
 * which is what a formal Hong Kong document uses -- Word will otherwise
 * substitute something arbitrary for the Chinese quotes.
 */
const SERIF = 'Georgia';
const CJK = 'PMingLiU';
const SANS = 'Calibri';

interface RunStyle {
  size?: number;
  bold?: boolean;
  italics?: boolean;
  color?: string;
}

function text(content: string, style: RunStyle = {}) {
  return new TextRun({
    text: content,
    font: { ascii: SERIF, hAnsi: SERIF, eastAsia: CJK },
    size: 22, // half-points, so 11pt
    ...style,
  });
}

function label(content: string) {
  return new TextRun({
    text: content,
    font: { ascii: SANS, hAnsi: SANS, eastAsia: CJK },
    size: 18,
    bold: true,
    color: '666666',
  });
}

type Block = Paragraph | Table;

export async function renderDocx(minutes: Minutes): Promise<Buffer> {
  const children: Block[] = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: minutes.bodyName.toUpperCase(),
          font: { ascii: SANS, hAnsi: SANS, eastAsia: CJK },
          size: 20,
          bold: true,
          characterSpacing: 60,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [text(`Minutes of the ${minutes.title}`, { size: 30 })],
    }),
  );

  const facts: Array<[string, string | null]> = [
    ['Date', formatDate(minutes.date)],
    [
      'Time',
      minutes.startTime
        ? `${minutes.startTime}${minutes.endTime ? ` – ${minutes.endTime}` : ''}`
        : null,
    ],
    ['Place', minutes.location || 'Not recorded'],
    ['Chair', minutes.chair],
    ['Secretary', minutes.secretary],
  ];
  for (const [key, value] of facts) {
    if (!value) continue;
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [label(`${key.toUpperCase()}   `), text(value)],
      }),
    );
  }

  const roll: Array<[string, string[]]> = [
    ['Present', minutes.present],
    ['In attendance', minutes.inAttendance ?? []],
    ['Apologies for absence', minutes.apologies ?? []],
  ];
  children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
  for (const [key, names] of roll) {
    if (!names.length) continue;
    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [label(`${key.toUpperCase()}   `), text(names.join(', '))],
      }),
    );
  }

  children.push(
    new Paragraph({
      spacing: { before: 240, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } },
      children: [],
    }),
  );

  for (const item of minutes.items) {
    children.push(...renderItem(item));
  }

  if (minutes.nextMeeting) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 320, after: 120 },
        children: [
          new TextRun({
            text: 'Date of next meeting / 下次會議日期',
            font: { ascii: SANS, hAnsi: SANS, eastAsia: CJK },
            size: 24,
            bold: true,
          }),
        ],
      }),
      new Paragraph({ children: [text(minutes.nextMeeting)] }),
      ...(minutes.nextMeetingZh
        ? [new Paragraph({ children: [text(minutes.nextMeetingZh)] })]
        : []),
    );
  }

  if (minutes.flaggedForReview?.length) {
    children.push(
      new Paragraph({
        spacing: { before: 400, after: 120 },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 8 } },
        children: [
          new TextRun({
            text: 'TO VERIFY BEFORE SIGN-OFF',
            font: { ascii: SANS, hAnsi: SANS, eastAsia: CJK },
            size: 20,
            bold: true,
            color: '8A6410',
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 120 },
        children: [
          text(
            'These minutes were drafted from an audio recording by an automated system. The following could not be established with confidence and must be checked before the minutes are tabled.',
            { italics: true, size: 18, color: '666666' },
          ),
        ],
      }),
    );
    for (const flag of minutes.flaggedForReview) {
      children.push(
        new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [text(flag)] }),
      );
    }
  }

  children.push(
    new Paragraph({
      spacing: { before: 400 },
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 8 } },
      children: [
        text(
          'Drafted automatically from the meeting recording. Quotations are verbatim in the language spoken; the body of these minutes is a translation. Not a signed record until approved.',
          { italics: true, size: 16, color: '888888' },
        ),
      ],
    }),
  );

  const doc = new Document({
    creator: 'Minutes',
    title: `${minutes.title} — ${minutes.date}`,
    description: 'Draft minutes',
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function renderItem(item: MinuteItem): Block[] {
  const out: Block[] = [];

  out.push(
    new Paragraph({
      spacing: { before: 320, after: 120 },
      children: [
        new TextRun({
          text: `${item.number}.   ${item.heading}${item.headingZh ? ` / ${item.headingZh}` : ''}`,
          font: { ascii: SANS, hAnsi: SANS, eastAsia: CJK },
          size: 24,
          bold: true,
        }),
      ],
    }),
  );

  // English first, then the 書面語 version of the same discussion beneath it —
  // the interleaved layout, so a reader of either language never leaves the item.
  const discussions = [item.discussion, item.discussionZh ?? ''];
  for (const block of discussions) {
    for (const para of block.split('\n').filter(Boolean)) {
      out.push(
        new Paragraph({
          spacing: { after: 140, line: 300 },
          alignment: AlignmentType.JUSTIFIED,
          children: [text(para)],
        }),
      );
    }
  }

  for (const motion of item.motions ?? []) {
    const votes = [
      motion.votesFor != null ? `${motion.votesFor} for` : null,
      motion.votesAgainst != null ? `${motion.votesAgainst} against` : null,
      motion.abstentions != null ? `${motion.abstentions} abstaining` : null,
    ].filter(Boolean);

    out.push(
      new Paragraph({
        indent: { left: 480 },
        spacing: { before: 100, after: 40 },
        children: [label('MOTION   '), text(motion.text)],
      }),
    );
    if (motion.textZh) {
      out.push(
        new Paragraph({
          indent: { left: 480 },
          spacing: { after: 40 },
          children: [label('動議   '), text(motion.textZh)],
        }),
      );
    }
    if (motion.proposedBy || motion.secondedBy) {
      out.push(
        new Paragraph({
          indent: { left: 480 },
          spacing: { after: 40 },
          children: [
            text(
              [
                motion.proposedBy && `Proposed by ${motion.proposedBy}`,
                motion.secondedBy && `seconded by ${motion.secondedBy}`,
              ]
                .filter(Boolean)
                .join(', ') + '.',
              { italics: true },
            ),
          ],
        }),
      );
    }
    out.push(
      new Paragraph({
        indent: { left: 480 },
        spacing: { after: 140 },
        children: [
          text(`Outcome: ${motion.outcome}`, { bold: true }),
          text(votes.length ? ` (${votes.join(', ')})` : ''),
          text(` / ${outcomeZh(motion.outcome)}${votesZh(motion)}`),
          ...(motion.confidence === 'low' ? [text('  [TO VERIFY]', { bold: true })] : []),
        ],
      }),
    );
    if (motion.evidence) out.push(quote(motion.evidence));
  }

  (item.resolutions ?? []).forEach((resolution, i) => {
    const zh = item.resolutionsZh?.[i];
    out.push(
      new Paragraph({
        indent: { left: 480 },
        spacing: { before: 100, after: zh ? 40 : 160 },
        children: [
          text('RESOLVED THAT ', { bold: true }),
          text(resolution.replace(/^\s*resolved\s+that\s+/i, '')),
        ],
      }),
    );
    if (zh) {
      out.push(
        new Paragraph({
          indent: { left: 480 },
          spacing: { after: 160 },
          children: [text('議決 ', { bold: true }), text(stripResolvedZh(zh))],
        }),
      );
    }
  });

  if (item.actions?.length) {
    out.push(
      new Paragraph({ spacing: { before: 60, after: 60 }, children: [label('ACTIONS')] }),
    );
    const rows = [
      new TableRow({
        tableHeader: true,
        children: ['ACTION 行動', 'OWNER 負責人', 'BY WHEN 期限'].map(
          (h) =>
            new TableCell({
              children: [new Paragraph({ children: [label(h)] })],
            }),
        ),
      }),
      ...item.actions.map(
        (a) =>
          new TableRow({
            children: [
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      text(a.action),
                      ...(a.confidence === 'low'
                        ? [text('  [TO VERIFY]', { bold: true })]
                        : []),
                    ],
                  }),
                  ...(a.actionZh
                    ? [new Paragraph({ children: [text(a.actionZh)] })]
                    : []),
                ],
              }),
              new TableCell({ children: [new Paragraph({ children: [text(a.owner)] })] }),
              new TableCell({
                children: [new Paragraph({ children: [text(a.dueDate ?? '—')] })],
              }),
            ],
          }),
      ),
    ];
    out.push(
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
      new Paragraph({ spacing: { after: 120 }, children: [] }),
    );
  }

  const sources = [
    ...(item.evidence ?? []),
    ...(item.actions ?? []).map((a) => a.evidence).filter((e): e is Evidence => !!e),
  ];
  if (sources.length) {
    out.push(
      new Paragraph({
        spacing: { before: 60, after: 40 },
        children: [label('WHAT WAS ACTUALLY SAID')],
      }),
    );
    for (const e of sources) out.push(quote(e));
  }

  return out;
}

/** The verbatim quote stays in the language spoken -- it is the check on the translation. */
function quote(evidence: Evidence): Paragraph {
  return new Paragraph({
    indent: { left: 480 },
    spacing: { after: 60 },
    border: { left: { style: BorderStyle.SINGLE, size: 8, color: 'CCCCCC', space: 8 } },
    children: [
      new TextRun({
        text: `${timestamp(evidence.time)}  `,
        font: { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: CJK },
        size: 16,
        color: '888888',
      }),
      text(`“${evidence.quote}”`, { size: 20, color: '444444' }),
    ],
  });
}

function timestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
