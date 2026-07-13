const OpenAI = require('openai');

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function fallbackAction(text) {
  const body = String(text || '').trim();
  const unitMatch = body.match(/\b(\d{2,4}\s*[A-Z]?)\b/i);
  const lower = body.toLowerCase();

  let requestType = 'MESSAGE';
  let department = 'Operations';
  let priority = 'Normal';

  if (/shampoo|toalla|towel|supply|supplies|papel|soap|jab[oó]n/.test(lower)) {
    requestType = 'SUPPLIES';
    department = 'Runner';
  } else if (/roto|broken|leak|fuga|mojado|wet|maintenance|mantenimiento/.test(lower)) {
    requestType = 'MAINTENANCE';
    department = 'Maintenance';
  } else if (/lista|ready|termin[eé]|done/.test(lower)) {
    requestType = 'DONE';
    department = 'Inspection';
  } else if (/empiezo|start|comienzo/.test(lower)) {
    requestType = 'START';
    department = 'Housekeeping';
  }

  if (/urgente|urgent|inund|flood|danger|peligro/.test(lower)) priority = 'Urgent';

  return {
    unit: unitMatch ? unitMatch[1].replace(/\s+/g, '').toUpperCase() : null,
    department,
    requestType,
    items: [],
    priority,
    summary: body.slice(0, 240),
    confidence: 0.55,
  };
}

async function interpretMessage(text) {
  if (!client) return fallbackAction(text);

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Extract a structured hotel housekeeping operation from the message. Return JSON with unit, department, requestType, items array, priority, summary, confidence. Use null when unit is absent. priority must be Low, Normal, High, or Urgent.'
        },
        { role: 'user', content: String(text || '') }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content || '{}');
    return {
      unit: parsed.unit || null,
      department: parsed.department || 'Operations',
      requestType: parsed.requestType || 'MESSAGE',
      items: Array.isArray(parsed.items) ? parsed.items : [],
      priority: parsed.priority || 'Normal',
      summary: parsed.summary || String(text || '').slice(0, 240),
      confidence: Number(parsed.confidence || 0.8),
    };
  } catch (error) {
    console.error('AI interpretation error:', error.message);
    return fallbackAction(text);
  }
}

module.exports = { interpretMessage };
