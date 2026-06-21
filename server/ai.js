import 'dotenv/config';

/**
 * Optional AI progress-photo analysis using Claude vision.
 * Gracefully disabled when ANTHROPIC_API_KEY is not set.
 */

let _client = null;

export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function getClient() {
  if (_client) return _client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  _client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return _client;
}

const SYSTEM = `You are an encouraging, knowledgeable strength & physique coach reviewing a
person's progress photos. You speak directly to the person ("you").

Guidelines:
- Be specific and observational about what you can actually see (muscle definition,
  size, leanness, posture, conditioning, symmetry). Don't invent details.
- Be honest but always constructive and motivating — never demeaning about their body.
- When given multiple photos in chronological order, focus on the CHANGE over time and
  call out concrete improvements. With a single photo, give a baseline read and what to
  watch going forward.
- Tie observations to their logged bodyweight/notes when provided.
- End with 2–3 concrete, actionable suggestions (training focus, areas to bring up).
- Keep it tight: a few short paragraphs, plus a short bullet list of next steps.
- This is general fitness guidance, not medical advice. No calorie/medical prescriptions.`;

export async function analyzeProgressPhotos(photos, { unit = 'lb' } = {}) {
  if (!aiEnabled()) {
    const err = new Error('AI analysis is not configured (set ANTHROPIC_API_KEY).');
    err.statusCode = 400;
    throw err;
  }
  const client = await getClient();

  const content = [];
  photos.forEach((p, i) => {
    const meta = [`Photo ${i + 1} — date ${p.taken_on}`];
    if (p.bodyweight != null) meta.push(`bodyweight ${p.bodyweight} ${unit}`);
    if (p.notes) meta.push(`note: "${p.notes}"`);
    content.push({ type: 'text', text: meta.join(', ') });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: p.mime || 'image/jpeg', data: p.base64 },
    });
  });

  const intro = photos.length > 1
    ? `These ${photos.length} progress photos are in chronological order (oldest first). Analyze my physique progress over time.`
    : `Here is a progress photo. Give me a baseline physique assessment and what to focus on.`;
  content.push({ type: 'text', text: intro });

  const resp = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    max_tokens: 1600,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });

  if (resp.stop_reason === 'refusal') {
    const err = new Error('The AI declined to analyze these images.');
    err.statusCode = 422;
    throw err;
  }

  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
