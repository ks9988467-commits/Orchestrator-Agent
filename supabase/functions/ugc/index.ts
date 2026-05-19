import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SYSTEM_PROMPT = `You are a professional short-video content strategist for the Malaysian market (TikTok / IG Reels).

Your task: Given a video subtitle/script, generate a cover copy kit in THREE languages simultaneously: Simplified Chinese (zh), English (en), and Bahasa Malaysia (ms).

Rules for each language:
- main title: max 6 Chinese characters / 5 English words / 6 Malay words — punchy, scroll-stopping
- sub title: max 8 Chinese characters / 7 English words / 8 Malay words — deepen curiosity or pain
- hook: natural spoken language, no ad-feel, must grab attention in first 3 seconds
- keywords: 3-5 pain-point words that hit the target audience
- postOpener: 1-2 sentences that follow the cover and pull viewers in

Hook types (pick the best fit):
- resonance: viewer thinks "Yes! Exactly!"
- curiosity: viewer thinks "No way, really?"
- disbelief: viewer thinks "Is this even possible?"

Output ONLY valid JSON, no markdown, no extra text:
{
  "zh": {
    "covers": [
      {"main": "≤6字", "sub": "≤8字", "type": "resonance|curiosity|disbelief"},
      {"main": "≤6字", "sub": "≤8字", "type": "resonance|curiosity|disbelief"}
    ],
    "hook": "口语hook句",
    "hookType": "resonance|curiosity|disbelief",
    "hookLabel": "共鸣型|好奇型|质疑型",
    "keywords": [{"word": "词", "hot": true}, {"word": "词", "hot": false}],
    "postOpener": "贴文开头1-2句"
  },
  "en": {
    "covers": [
      {"main": "≤5 words", "sub": "≤7 words", "type": "resonance|curiosity|disbelief"},
      {"main": "≤5 words", "sub": "≤7 words", "type": "resonance|curiosity|disbelief"}
    ],
    "hook": "spoken hook sentence",
    "hookType": "resonance|curiosity|disbelief",
    "hookLabel": "Resonance|Curiosity|Disbelief",
    "keywords": [{"word": "keyword", "hot": true}, {"word": "keyword", "hot": false}],
    "postOpener": "1-2 sentence post opener"
  },
  "ms": {
    "covers": [
      {"main": "≤6 patah", "sub": "≤8 patah", "type": "resonance|curiosity|disbelief"},
      {"main": "≤6 patah", "sub": "≤8 patah", "type": "resonance|curiosity|disbelief"}
    ],
    "hook": "ayat hook bahasa lisan",
    "hookType": "resonance|curiosity|disbelief",
    "hookLabel": "Resonans|Ingin Tahu|Tidak Percaya",
    "keywords": [{"word": "kata kunci", "hot": true}, {"word": "kata kunci", "hot": false}],
    "postOpener": "1-2 ayat pembuka"
  }
}`

async function getAnthropicKey(): Promise<string> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/provider_config?provider=eq.anthropic&active=eq.true&select=api_key&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const rows = await res.json()
  const key = rows[0]?.api_key?.trim()
  if (!key) throw new Error('Anthropic API key not configured in provider_config')
  return key
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS })

  try {
    const { script, product, audience } = await req.json()

    if (!script?.trim()) {
      return new Response(
        JSON.stringify({ error: '请提供字幕内容' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const apiKey = await getAnthropicKey()

    const userMsg = `Product line: ${product || 'General'}
Target audience: ${audience || 'General Public'}

Subtitle/Script:
${script.trim()}`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${err}`)
    }

    const data = await res.json()
    const raw = data.content.find((b: { type: string }) => b.type === 'text')?.text || ''
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())

    return new Response(JSON.stringify(parsed), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
