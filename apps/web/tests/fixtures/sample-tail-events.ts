/**
 * 12 production log entries from bt-servant-worker captured 2026-04-24
 * via the /cf-logs skill. PII placeholdered:
 *   phone numbers → "15551234567"
 *   emails        → "test-user@example.com"
 *   response text → "[REDACTED_RESPONSE]"
 *   user code     → "[REDACTED]"
 *
 * The shape of every other field is exactly what bt-servant-worker emits.
 */

export const sampleLogMessages = [
  '{"event":"request_received","request_id":"a991e72a-a86c-4d94-9cb6-b30a679bd8c9","user_id":"test-user@example.com","client_id":"web","org":"unfoldingWord","transport":"stream","chat_type":"private","timestamp":1777056449325}',
  '{"event":"request_received","request_id":"3429dcda-4041-4499-904b-cfca53e71a73","user_id":"15551234567","client_id":"whatsapp","org":"unfoldingWord","transport":"callback","chat_type":"private","timestamp":1777045491012}',
  '{"event":"request_received","request_id":"fc412c68-4de3-4024-a5d7-9b9198debced","user_id":"15551234567","client_id":"whatsapp","org":"unfoldingWord","transport":"callback","chat_type":"private","timestamp":1777044627982}',
  '{"event":"request_received","request_id":"2306a244-bc32-4cb5-92be-fab5e6a4d835","user_id":"test-user@example.com","client_id":"web","org":"unfoldingWord","transport":"stream","chat_type":"private","timestamp":1777044317197}',
  '{"has_voice_audio":false,"event":"process_chat_complete","request_id":"fdc12dcc-d79a-4261-9d7f-9c6d71a5b043","response":"[REDACTED_RESPONSE]","timestamp":1777048262707,"total_ms":6231,"response_count":1,"total_response_chars":884}',
  '{"has_voice_audio":false,"event":"process_chat_complete","request_id":"b1d0fe86-73e6-4630-86bb-fe9f23d1d81b","response":"[REDACTED_RESPONSE]","timestamp":1777047218234,"total_ms":21044,"response_count":2,"total_response_chars":771}',
  '{"has_voice_audio":false,"event":"process_chat_complete","request_id":"3233d6a3-e47b-4e09-9143-bb7e67573336","response":"[REDACTED_RESPONSE]","timestamp":1777047083147,"total_ms":8761,"response_count":1,"total_response_chars":450}',
  '{"event":"chat_immediate","request_id":"307fdf7e-83e5-448b-8b14-f6d99027e297","message_id":"8d748f24-5e14-47f5-b7cb-005cd2e81f5e","user_id":"15551234567","transport":"callback","timestamp":1777056788146}',
  '{"event":"request_timing_summary","request_id":"e72e936d-936a-451d-8441-43ba6115a4c7","user_id":"15551234567","org":"unfoldingWord","transport":"callback","timestamp":1777059020595,"total_ms":1090,"phases":{"kv_and_routing":115,"do_fetch":975}}',
  '{"level":"error","event":"mcp_tool_call_error","request_id":"a991e72a-a86c-4d94-9cb6-b30a679bd8c9","server_id":"translation-helps","tool_name":"fetch_translation_word","args":{"word":"lampstand"},"error":"MCP error: Missing required parameter: path (code: -32000)","stack":"MCPError: MCP error: Missing required parameter: path (code: -32000)\\n    at parseJsonRpcResponse (index.js:4530:13)","timestamp":1777056469074,"duration_ms":15}',
  '{"level":"error","event":"mcp_tool_call_error","request_id":"8b313643-4df7-4ada-a961-7f61dc52d2fc","server_id":"translation-helps","tool_name":"fetch_translation_notes","args":{"book":"GEN","chapter":4,"verse":1,"verse_end":8},"error":"MCP error: Missing required parameter: reference (code: -32000)","stack":"MCPError: MCP error: Missing required parameter: reference (code: -32000)\\n    at parseJsonRpcResponse (index.js:4530:13)","timestamp":1777047892318,"duration_ms":17}',
  '{"level":"error","event":"code_execution_error","request_id":"13db13f7-b908-44e1-a21f-cd4c6884b20b","code":"[REDACTED]","error":"\'read_memory\' is not defined","stack":"CodeExecutionError: \'read_memory\' is not defined\\n    at checkExecutionError (index.js:10362:11)","timestamp":1776708516168,"duration_ms":0,"mcp_calls_made":0,"mcp_calls_limit":10}',
];

/**
 * Wrap each raw JSON message into a TraceItem so it can be passed to
 * `tailHandler` directly.
 */
export function buildTraceItems(): TraceItem[] {
  return [
    {
      scriptName: 'bt-servant-worker',
      outcome: 'ok',
      eventTimestamp: Date.now(),
      event: null,
      logs: sampleLogMessages.map((message) => ({
        message: [message],
        level: 'log',
        timestamp: Date.now(),
      })),
      exceptions: [],
      diagnosticsChannelEvents: [],
      truncated: false,
    } as unknown as TraceItem,
  ];
}
