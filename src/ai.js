const OpenAI = require('openai');

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

async function interpretOperationsMessage(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return null;

  if (!client) {
    return {
      unit: null,
      department: 'Operations',
      requestType: 'MESSAGE',
      priority: 'Normal',
      summary: cleanText,
      confidence: 0.5,
      items: [],
    };
  }

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Convierte mensajes de housekeeping en JSON estructurado. Devuelve unit, department, requestType, priority, summary, confidence e items. No inventes datos.'
      },
      { role: 'user', content: cleanText }
    ]
  });

  return JSON.parse(response.choices[0].message.content);
}

module.exports = { interpretOperationsMessage };
