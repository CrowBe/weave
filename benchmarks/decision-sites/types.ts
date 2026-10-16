/** Benchmark contracts. Answers are observations, never runtime authority. */
import type { EvaluationContent, EvaluationQuestion } from '@weave/gateway';
export interface Item {
  id: string;
  scenario_id: string;
  site: string;
  state: EvaluationContent;
  gold: Record<string, string | boolean>;
}
export interface Request {
  state: EvaluationContent;
  questions: Record<string, EvaluationQuestion>;
}
export interface Answer {
  choice?: string;
  probability?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}
export interface Result {
  status: 'ok' | 'failed' | 'skipped';
  reason?: string;
  model?: string;
  answers?: Record<string, Answer>;
  input_tokens?: number;
  output_tokens?: number;
  http_status?: number;
  error_code?: string;
  request_id?: string;
  retry_after_ms?: number;
  parse_failure?: boolean;
}
export interface Provider {
  id: string;
  model: string;
  /** USD per million input tokens; output free in the declared profiles. */
  price: number;
  competitor?: boolean;
  serialize(request: Request): string;
  request(request: Request, signal: AbortSignal): Promise<Result>;
}
