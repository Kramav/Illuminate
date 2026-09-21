/**
 * The optional language-model pass.
 *
 * It reads the **residue** — the prose the deterministic rules already declined — and nothing else.
 * That ordering is the whole design. The rules handle every line that is plainly a term and a
 * definition, for free, offline, and identically on every run; the model is asked only about the
 * paragraphs that defeated them. Sending the whole deck instead would cost more, be slower, produce
 * different cards run to run, and re-derive work that was already correct.
 *
 * Three providers behind one function. Two of them are the same code: Ollama, LM Studio and
 * llama.cpp's server all speak the OpenAI chat shape, so "run it locally" costs one `fetch` and a
 * different port rather than a client per tool. Claude goes through the official SDK, imported only
 * if it is actually used, so nobody who runs offline has to install it.
 */

import { normalize } from './doc.js';

export const PROVIDERS = ['none', 'ollama', 'lmstudio', 'claude'];

const LOCAL = {
  ollama: { base: 'http://127.0.0.1:11434/v1', list: 'http://127.0.0.1:11434/api/tags', label: 'Ollama' },
  lmstudio: { base: 'http://127.0.0.1:1234/v1', list: 'http://127.0.0.1:1234/v1/models', label: 'LM Studio' },
};

const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

/** Roughly how much prose to put in one request. Small enough to stay sharp, large enough to batch. */
const CHUNK = 3500;

const SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          front: { type: 'string' },
          back: { type: 'string' },
        },
        required: ['ref', 'front', 'back'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

const SYSTEM = `You turn lecture material into flashcards.

Rules:
- Use ONLY facts stated in the text. Never add outside knowledge, and never infer beyond it.
- The front is a question or a single term. The back is the answer, under 200 characters.
- One idea per card. Do not put two facts in one answer.
- Write nothing about the document itself: no cards about its agenda, structure, author, or thanks.
- If a passage carries no fact worth recalling, produce no card for it. Returning fewer good cards
  is always better than padding.
- Every card's "ref" must be copied exactly from the [ref] label above the passage it came from.

Reply with JSON only, in this shape:
{"cards":[{"ref":"slide-3","front":"...","back":"..."}]}
If nothing is worth carding, reply {"cards":[]}.`;

/**
 * One passage as one or more request-sized blocks, each labelled with its section.
 *
 * Splitting *within* a passage is what keeps `CHUNK` a ceiling rather than only a floor. A section
 * can be the whole document — `readDocx` opens a new one at a heading, so a handout typed without
 * heading styles arrives as a single passage — and a local server does not refuse a prompt past its
 * context. It drops what does not fit, which pushes the rules in `SYSTEM` out of view and produces
 * cards that quietly stop obeying them.
 *
 * The cut falls on the newline `extract` joined the leftover lines with, so it lands between lines
 * rather than mid-sentence. The label is repeated on every piece, because a card from the tail has
 * to name the same section as one from the head.
 *
 * ponytail: a single line longer than CHUNK is still sent whole. There is no boundary inside it we
 * could trust, and one over-long line is a smaller problem than the document it used to carry.
 */
function blocksFor(entry) {
  const label = `[${entry.ref}]${entry.title ? ` ${entry.title}` : ''}`;
  const room = Math.max(CHUNK - label.length - 1, 1);
  const blocks = [];
  let lines = [];
  let size = 0;
  for (const line of entry.text.trim().split('\n')) {
    if (size + line.length > room && lines.length) {
      blocks.push(lines);
      lines = [];
      size = 0;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length) blocks.push(lines);
  return blocks.map((ls) => `${label}\n${ls.join('\n')}`);
}

/** Group residue into request-sized batches, keeping each passage labelled with its section. */
function chunk(residue) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const entry of residue) {
    // Under a sentence or so there is nothing to extract, and it costs a request to find that out.
    if (entry.text.trim().length < 60) continue;
    for (const block of blocksFor(entry)) {
      if (size + block.length > CHUNK && current.length) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(block);
      size += block.length;
    }
  }
  if (current.length) chunks.push(current);
  return chunks.map((blocks) => blocks.join('\n\n'));
}

/**
 * Get JSON out of whatever the model actually said, and the array it was asked for under `key`.
 *
 * Local models in particular like to introduce themselves before answering, or wrap the answer in a
 * fenced code block, no matter how the request was phrased. Slicing between the outermost braces
 * recovers the object from both without caring which happened.
 */
export function parseJson(text, key) {
  if (!text) return null;
  const body = String(text).replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '');
  const source = body.includes('{') ? body : String(text);
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return Array.isArray(parsed?.[key]) ? parsed[key] : null;
  } catch {
    return null;
  }
}

export const parseCards = (text) => parseJson(text, 'cards');

async function askLocal(provider, model, system, prompt, signal) {
  const { base, label } = LOCAL[provider];
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0,
      stream: false,
      response_format: { type: 'json_object' },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`${label} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function askClaude(model, system, schema, prompt) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('the claude provider needs the Anthropic SDK: npm install @anthropic-ai/sdk');
  }
  const client = new Anthropic();
  const message = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: prompt }],
    // A schema rather than a plea in the prompt: this is a mechanical extraction, so constrain the
    // shape and spend the effort budget on reading the passage instead of on formatting.
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  });
  if (message.stop_reason === 'refusal') throw new Error('Claude declined this passage');
  return message.content.find((block) => block.type === 'text')?.text ?? '';
}

/**
 * One request to any provider, returning the reply as text.
 *
 * Exported so the review pass in verify.js asks its own question through exactly this plumbing — the
 * same ports, the same SDK import, the same refusal handling — rather than a second copy of it.
 * `schema` constrains Claude's reply; local servers only get the shape the prompt describes.
 */
export function ask({ provider, model, system, schema, prompt, signal }) {
  return provider === 'claude'
    ? askClaude(model, system, schema, prompt)
    : askLocal(provider, model, system, prompt, signal);
}

/** One request, with a single retry — a local model that rambles once will often comply when told. */
async function askOnce(provider, model, prompt, signal) {
  return parseCards(await ask({ provider, model, system: SYSTEM, schema: SCHEMA, prompt, signal }));
}

/**
 * Read the residue into extra card candidates.
 *
 * Returns raw `{ref, front, back}` objects rather than finished cards: they still have to go through
 * `finalize` in cards.js alongside the rule-made ones, so that both are judged by the same gate.
 *
 * A provider failure is reported and skipped, never thrown. The deterministic cards are already in
 * hand by the time this runs, and losing the whole deck because a local model timed out on slide 40
 * would be a bad trade.
 *
 * @param {Array<{ref: string, title: string, text: string}>} residue
 * @param {{provider: string, model?: string, refs: Set<string>, onProgress?: Function}} options
 */
export async function expand(residue, { provider, model, refs, onProgress = () => {} }) {
  if (provider === 'none' || !residue.length) return [];
  const chunks = chunk(residue);
  const chosen = model ?? await defaultModel(provider);
  const out = [];

  for (const [i, prompt] of chunks.entries()) {
    onProgress(`${provider}: passage ${i + 1}/${chunks.length}`);
    // Local models are slow and a stuck request should not hang the run indefinitely.
    const signal = provider === 'claude' ? undefined : AbortSignal.timeout(180_000);
    let cards = null;
    try {
      cards = await askOnce(provider, chosen, prompt, signal);
      if (!cards) {
        cards = await askOnce(provider, chosen,
          `${prompt}\n\nReply with JSON only — no prose, no code fence.`, signal);
      }
    } catch (err) {
      onProgress(`${provider}: ${err.message} — keeping the rule-made cards for this passage`);
      continue;
    }
    if (!cards) {
      onProgress(`${provider}: passage ${i + 1} did not come back as JSON — skipped`);
      continue;
    }
    for (const card of cards) {
      // A model that invents a section reference would tag the card onto a slide it never read.
      const ref = refs.has(card?.ref) ? card.ref : null;
      if (!ref || typeof card.front !== 'string' || typeof card.back !== 'string') continue;
      out.push({ ref, front: card.front.trim(), back: card.back.trim() });
    }
  }
  return out;
}

/** Whatever the local server already has loaded, so `--llm ollama` works without also naming a model. */
export async function defaultModel(provider) {
  if (provider === 'claude') return DEFAULT_CLAUDE_MODEL;
  const found = (await probe(provider)).models?.[0];
  if (!found) throw new Error(`no model available from ${LOCAL[provider].label} — pull one first`);
  return found;
}

async function probe(provider) {
  const { list, label } = LOCAL[provider];
  try {
    const res = await fetch(list, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { ok: false, detail: `${label} answered ${res.status}` };
    const data = await res.json();
    const models = (data.models ?? data.data ?? []).map((m) => m.name ?? m.id).filter(Boolean);
    return { ok: true, models, detail: models.length ? models.join(', ') : 'running, but no models' };
  } catch {
    return { ok: false, detail: 'not running' };
  }
}

/** What `--check` reports: what is available right now, and how to get what isn't. */
export async function check() {
  const rows = [];

  for (const provider of ['ollama', 'lmstudio']) {
    const { ok, detail } = await probe(provider);
    rows.push({
      name: `--llm ${provider}`,
      ok,
      detail,
      fix: provider === 'ollama'
        ? 'install from ollama.com, then: ollama serve && ollama pull qwen3:8b'
        : 'start LM Studio and turn on its local server (Developer → Start Server)',
    });
  }

  let sdk = true;
  try {
    await import('@anthropic-ai/sdk');
  } catch {
    sdk = false;
  }
  const key = Boolean(process.env.ANTHROPIC_API_KEY);
  rows.push({
    name: '--llm claude',
    ok: sdk && key,
    detail: !sdk ? 'SDK not installed' : key ? `ready (${DEFAULT_CLAUDE_MODEL})` : 'ANTHROPIC_API_KEY is not set',
    fix: !sdk ? 'npm install @anthropic-ai/sdk' : 'set ANTHROPIC_API_KEY in your environment',
  });

  let pdf = true;
  try {
    await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    pdf = false;
  }
  rows.push({ name: 'PDF reading', ok: pdf, detail: pdf ? 'ready' : 'pdfjs-dist missing', fix: 'npm install' });

  return rows;
}

/** Cards the rules already produced win; the model does not get to restate them. */
export function withoutDuplicates(aiItems, existing) {
  const seen = new Set(existing.map((c) => normalize(c.front)));
  return aiItems.filter((item) => {
    const key = normalize(item.front);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
