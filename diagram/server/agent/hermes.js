import { AppError } from '../errors.js';
import { extractJson } from './json-extract.js';

export function createHermesAdapter({ url = null, key = null, model = 'hermes-agent', fetchImpl = fetch } = {}) {
  return {
    name: 'hermes',
    async run({ system, user, schema, signal }) {
      if (!url || !key) throw new AppError('agent_unavailable', 'Thiếu DIAGRAM_HERMES_URL hoặc DIAGRAM_HERMES_KEY.');
      let response;
      try {
        response = await fetchImpl(`${url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [
              { role: 'system', content: `${system}\n\nReturn only one JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}` },
              { role: 'user', content: user },
            ],
          }),
          signal,
        });
      } catch (error) {
        throw new AppError('agent_error', error?.message ?? 'Hermes request failed');
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new AppError('agent_error', `Hermes trả về lỗi ${response.status}`, { detail: String(body).slice(0, 300) });
      }
      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content ?? '';
      return extractJson(content);
    },
  };
}
