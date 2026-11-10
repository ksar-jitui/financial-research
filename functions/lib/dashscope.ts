const BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

export class ServiceNotConfigured extends Error {
  constructor() {
    super("service_not_configured");
    this.name = "ServiceNotConfigured";
  }
}

function apiKey(): string {
  const key = (globalThis as any).Deno?.env?.get?.("DASHSCOPE_API_KEY");
  if (!key) throw new ServiceNotConfigured();
  return key;
}

async function call(model: string, messages: any[], json: boolean, temperature: number): Promise<string> {
  const body: any = { model, messages, temperature };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`dashscope_http_${res.status}`);
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? "");
}

export async function completeJson(model: string, system: string, user: string): Promise<any> {
  const content = await call(model, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], true, 0.1);
  return parseJsonObject(content);
}

export async function chat(model: string, messages: any[]): Promise<string> {
  return call(model, messages, false, 0.3);
}

export function parseJsonObject(content: string): any {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("llm_invalid_json");
  return JSON.parse(text.slice(start, end + 1));
}