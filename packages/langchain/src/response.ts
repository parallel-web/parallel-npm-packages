import type {
  ExtractResponse,
  SearchResult,
} from 'parallel-web/resources/top-level.mjs';

const TRUNCATED =
  '\n\n[Output truncated. The complete response is available in the tool artifact.]';

/**
 * Shorten the text sent to the model, keeping the SDK response intact for the
 * artifact. Always show a complete source URL before any text from that source.
 */
export function formatResponse(
  response: SearchResult | ExtractResponse,
  maxOutputChars: number
): string {
  const sections = response.results.map((result) => ({
    source: `Source: ${result.url}\n`,
    text: [
      result.title && `Title: ${result.title}`,
      result.publish_date && `Published: ${result.publish_date}`,
      result.excerpts.join('\n\n') ||
        ('full_content' in result && result.full_content) ||
        'No excerpts returned.',
    ]
      .filter(Boolean)
      .join('\n'),
  }));

  if ('errors' in response) {
    for (const error of response.errors) {
      sections.push({
        source: `Extraction failed: ${error.url}\n`,
        text: `${error.error_type}${error.http_status_code == null ? '' : ` (HTTP ${error.http_status_code})`}`,
      });
    }
  }
  for (const warning of response.warnings ?? []) {
    sections.push({ source: 'Warning: ', text: warning.message });
  }

  // Leave room for the truncation notice. Each source header must fit in full.
  const budget = maxOutputChars - TRUNCATED.length;
  // Keep failures visible when result text or an error URL fills the space.
  let content =
    'errors' in response && response.errors.length
      ? `Extraction failed for ${response.errors.length} of ${response.results.length + response.errors.length} URLs.`
      : '';
  for (const section of sections) {
    const header = `${content ? '\n\n' : ''}${section.source}`;
    if (content.length + header.length > budget) {
      return content + TRUNCATED;
    }
    content += header;
    const remaining = budget - content.length;
    content += section.text.slice(0, remaining);
    if (section.text.length > remaining) {
      return content + TRUNCATED;
    }
  }
  return content || 'No results returned.';
}
