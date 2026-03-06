/**
 * Tokenizer wrapper for benchmark token counting.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-06
 */

import { countTokens as gptCountTokens } from 'gpt-tokenizer';

/**
 * Counts the number of tokens in a plain text string.
 */
export function countTokens(text: string): number {
  return gptCountTokens(text);
}

/**
 * Serializes an object to pretty-printed JSON, then counts its tokens.
 */
export function countJsonTokens(obj: unknown): number {
  return countTokens(JSON.stringify(obj, null, 2));
}
